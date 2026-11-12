#!/usr/bin/env node
// @ts-check
/**
 * SPIKE (docs/spikes/code-browser.md) — the backend of the `?dev=code` prototype.
 *
 * What stackd would do for a "Code" tab, as a standalone localhost server so the running stackd is not touched:
 *   - files of an allow-listed root (a task's worktree): directory listing, file read, quick-open list;
 *   - one language server per (root, language), spawned over stdio and proxied as plain request/response
 *     (LSP navigation is request/response: no WebSocket needed, it fits stackd's `POST /commands/<name>`).
 *
 *   node desktop/scripts/code-dev-server.mjs --root <dir> [--root <dir>…] [--port 1431]
 *        [--phpactor <path to bin/phpactor>]   the PHP server (default: `phpactor` on PATH). Needs PHP 8.1+.
 *        [--composer-autoload <vendor/autoload.php>]  the main checkout's, when the worktree has no vendor/
 *        [--php-server intelephense]           use Intelephense for PHP instead (proprietary; kept to compare)
 *        [--servers <dir with node_modules/.bin/{typescript-language-server,intelephense}>]
 *        [--exclude <glob>…]   extra PHP index excludes (Phpactor: root-relative, like `/zer/` + `**` + `/*`)
 *        [--include <dir>…]    read-only directories outside the roots that "go to definition" may open
 *                              (the main checkout's vendor/ and node_modules/)
 *        [--ts-native <tsc>]   TypeScript 7's own LSP (`<tsc> --lsp --stdio`) for JS/TS, to compare
 *        [--cache <dir>]       where the PHP server keeps its index (default: os tmp). Never inside a root.
 *
 * Nothing is ever written under a root.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- arguments ----------

/** @param {string} name @returns {string[]} */
function args(name) {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[++i]);
  return out;
}
const PORT = Number(args('port')[0] ?? 1431);
const ROOTS = args('root').map((r) => fs.realpathSync(path.resolve(r)));
const SERVERS = args('servers')[0] ? fs.realpathSync(path.resolve(args('servers')[0])) : undefined;
const EXCLUDES = args('exclude');
const INCLUDES = args('include').map((r) => path.resolve(r));
/** Experimental: TypeScript 7's native server (`tsc --lsp --stdio`) instead of typescript-language-server + tsserver. */
const TS_NATIVE = args('ts-native')[0];
const PHPACTOR = args('phpactor')[0] ?? 'phpactor';
const PHP_SERVER = args('php-server')[0] ?? 'phpactor';
/** `vendor/autoload.php` of the main checkout, for worktrees that have no vendor/ of their own. */
const COMPOSER_AUTOLOAD = args('composer-autoload')[0] ? path.resolve(args('composer-autoload')[0]) : undefined;
const PHPACTOR_WORKERS = Number(args('phpactor-workers')[0] ?? 0);
const CACHE = path.resolve(args('cache')[0] ?? path.join(os.tmpdir(), 'stack-code-spike'));
if (!ROOTS.length) { console.error('usage: code-dev-server.mjs --root <dir> [--root <dir>…] [--port N] [--servers <dir>]'); process.exit(2); }

/** PHP's built-in functions and classes are declared in the stubs Phpactor ships: readable, like lib.d.ts. */
const PHP_STUBS = (() => {
  try {
    for (let d = path.dirname(fs.realpathSync(PHPACTOR)), i = 0; i < 6; d = path.dirname(d), i++) {
      for (const stubs of [path.join(d, 'vendor', 'jetbrains', 'phpstorm-stubs'), path.join(d, 'jetbrains', 'phpstorm-stubs')]) if (fs.existsSync(stubs)) return [fs.realpathSync(stubs)];
    }
  } catch { /* phpactor on PATH: its stubs stay unreadable, built-ins just do not open */ }
  return [];
})();

// ---------- path safety ----------

class Refused extends Error {}

/**
 * The real path of `p` when it lies inside an allow-listed root (or, read-only extras, the language servers'
 * own install: PHP stubs, lib.d.ts). Symlinks are resolved first, so a link pointing out of the root is refused.
 * @param {string} p @param {{ extras?: boolean }} [opt]
 */
function inside(p, opt) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Refused('An absolute path is required.');
  let real;
  try { real = fs.realpathSync(p); } catch { throw new Refused('No such file.'); }
  const allowed = opt?.extras ? [...ROOTS, ...INCLUDES, ...(SERVERS ? [SERVERS] : []), ...PHP_STUBS] : ROOTS;
  if (!allowed.some((r) => real === r || real.startsWith(r + path.sep))) throw new Refused('Outside the worktree.');
  return real;
}

/** @param {string} root */
function rootOf(root) {
  const real = inside(root);
  if (!ROOTS.includes(real)) throw new Refused('Not a root.');
  return real;
}

// ---------- files ----------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees', '.DS_Store']);
const MAX_FILE = 2 * 1024 * 1024;

/** @param {string} dir */
function listDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
    .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))) }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}
/** @param {string} p */
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** @param {string} file */
function readFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Refused('Not a file.');
  if (st.size > MAX_FILE) return { path: file, size: st.size, tooLarge: true, text: '' };
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return { path: file, size: st.size, binary: true, text: '' };
  return { path: file, size: st.size, text: buf.toString('utf8') };
}

/** Quick open: every file path under a root, relative, walked once and kept (stackd: `git ls-files` + a watcher). */
const fileLists = new Map();
/** @param {string} root @returns {{ files: string[], ms: number }} */
function filesOf(root) {
  let hit = fileLists.get(root);
  if (hit) return hit;
  const t0 = Date.now();
  /** @type {string[]} */
  const files = [];
  (function walk(d, rel) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), rel + e.name + '/'); }
      else if (e.isFile()) files.push(rel + e.name);
    }
  })(root, '');
  hit = { files, ms: Date.now() - t0 };
  fileLists.set(root, hit);
  return hit;
}

/**
 * Subsequence match, VS Code-ish ranking: matches in the file name and contiguous runs score higher,
 * `vendor/` lower. Returns up to `limit` paths.
 * @param {string[]} files @param {string} q @param {number} limit
 */
function fuzzy(files, q, limit) {
  const needle = q.toLowerCase().replace(/\s+/g, '');
  if (!needle) return files.slice(0, limit);
  /** @type {{ f: string, s: number }[]} */
  const scored = [];
  for (const f of files) {
    const hay = f.toLowerCase();
    const base = hay.lastIndexOf('/') + 1;
    let s = 0, at = -1, run = 0, ok = true;
    // Prefer matching the whole needle inside the file name.
    const inName = hay.indexOf(needle, base);
    if (inName >= 0) s = 1000 - (inName - base) * 2 - (hay.length - base - needle.length);
    else {
      for (const ch of needle) {
        const next = hay.indexOf(ch, at + 1);
        if (next < 0) { ok = false; break; }
        run = next === at + 1 ? run + 1 : 0;
        s += 1 + run * 3 + (next >= base ? 4 : 0) + (next === 0 || hay[next - 1] === '/' ? 6 : 0);
        at = next;
      }
      if (!ok) continue;
      s -= hay.length / 20;
    }
    if (hay.startsWith('vendor/') || hay.includes('/vendor/')) s -= 200;
    scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.f.length - b.f.length);
  return scored.slice(0, limit).map((x) => x.f);
}

// ---------- language servers ----------

/** @param {string} name */
function bin(name) {
  const local = SERVERS && path.join(SERVERS, 'node_modules', '.bin', name);
  return local && fs.existsSync(local) ? local : name; // else: whatever is on PATH
}

/**
 * @typedef {{ id: string, languages: string[], command: () => [string, string[]], env?: () => Record<string, string>,
 *   init: (root: string) => unknown, config: (section: string | undefined) => unknown }} ServerSpec
 */
/** @type {ServerSpec} */
const PHPACTOR_SPEC = {
  id: 'phpactor',
  languages: ['php'],
  command: () => ['php', ['-d', 'memory_limit=-1', PHPACTOR, 'language-server']],
  // Phpactor keeps its index under XDG_CACHE_HOME (`phpactor/index/<project id>`), keyed by project root:
  // pointing XDG at our cache keeps it out of the worktree and out of ~/.cache, ~/.config.
  env: () => ({
    XDG_CACHE_HOME: path.join(CACHE, 'phpactor', 'cache'),
    XDG_CONFIG_HOME: path.join(CACHE, 'phpactor', 'config'),
    XDG_DATA_HOME: path.join(CACHE, 'phpactor', 'data'),
  }),
  // Phpactor takes its configuration as initializationOptions. A browser's profile:
  init: (root) => ({
    'language_server.enable_trust_check': false, // never load the worktree's own .phpactor.json (it can name binaries to run)
    // MUST stay off: on start Phpactor offers to enable PHPStan, php-cs-fixer… when the project uses them, and
    // writes the answer (even "no") into `<project>/.phpactor.json`. A browser never writes in the worktree.
    'language_server_configuration.auto_config': false,
    'language_server.diagnostics_on_open': false,
    'language_server.diagnostics_on_update': false,
    'language_server.diagnostics_on_save': false,
    'indexer.enabled_watchers': ['lsp'],         // no polling of the tree; changes arrive from the client
    // vendor/ is NOT indexed (half the disk, and nobody asks "who uses Symfony's Request"). Jumping INTO a vendor
    // class still works: Phpactor finds the file through Composer's class maps (PSR-4), read as data
    // (`class_maps_only`: vendor/composer/autoload_{psr4,classmap}.php are included, the autoloader is not run).
    'indexer.exclude_patterns': ['/vendor/**/*', '/node_modules/**/*', '/.worktrees/**/*', '/.php/**/*', ...EXCLUDES],
    'composer.enable': true,
    'composer.class_maps_only': true,
    // A worktree without vendor/: the main checkout's autoloader does the same job.
    'composer.autoloader_path': COMPOSER_AUTOLOAD ?? path.join(root, 'vendor', 'autoload.php'),
    ...(PHPACTOR_WORKERS ? { 'indexer.parallel_workers': PHPACTOR_WORKERS } : {}),
    'language_server_indexer.workspace_symbol_search_limit': 100,
  }),
  config: () => null,
};

/** @type {ServerSpec[]} */
const SPECS = [
  ...(PHP_SERVER === 'intelephense' ? [] : [PHPACTOR_SPEC]),
  {
    id: 'intelephense',
    languages: ['php'],
    command: () => [bin('intelephense'), ['--stdio']],
    init: (root) => ({
      // Its index lives outside the worktree, keyed by root: a second start of the same root reuses it.
      storagePath: path.join(CACHE, 'intelephense', Buffer.from(root).toString('base64url').slice(-80)),
      globalStoragePath: path.join(CACHE, 'intelephense-global'),
      clearCache: false,
    }),
    config: (section) => {
      const intelephense = {
        files: {
          maxSize: 1_000_000,
          associations: ['*.php', '*.phtml'],
          exclude: ['**/.git/**', '**/node_modules/**', '**/vendor/**/{Tests,tests}/**', '**/vendor/**/vendor/**', '**/.worktrees/**', ...EXCLUDES],
        },
        environment: { includePaths: INCLUDES },
        diagnostics: { enable: false }, // a browser: no squiggles, less work
        telemetry: { enabled: false },
      };
      return section === 'intelephense' ? intelephense : section === undefined ? { intelephense } : null;
    },
  },
  {
    id: 'typescript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    command: () => (TS_NATIVE ? [TS_NATIVE, ['--lsp', '--stdio']] : [bin('typescript-language-server'), ['--stdio']]),
    init: () => ({
      hostInfo: 'stack',
      // The worktree's own TypeScript when it has node_modules; else the one installed next to the server.
      tsserver: SERVERS ? { fallbackPath: path.join(SERVERS, 'node_modules', 'typescript', 'lib') } : {},
      preferences: { includePackageJsonAutoImports: 'off' },
      disableAutomaticTypingAcquisition: true, // never download @types behind the user's back
    }),
    config: () => null,
  },
];

class LspServer {
  /** @param {ServerSpec} spec @param {string} root */
  constructor(spec, root) {
    this.spec = spec;
    this.root = root;
    this.startedAt = Date.now();
    /** @type {'starting' | 'indexing' | 'ready' | 'dead'} */
    this.state = 'starting';
    this.message = '';
    /** @type {number | undefined} */ this.initMs = undefined;
    /** @type {number | undefined} */ this.indexMs = undefined;
    this.requests = 0;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.open = new Set();
    this.buf = Buffer.alloc(0);
    this.stderr = '';
    const [cmd, argv] = spec.command();
    for (const dir of Object.values(spec.env?.() ?? {})) fs.mkdirSync(dir, { recursive: true });
    this.proc = spawn(cmd, argv, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', ...spec.env?.() } });
    this.proc.stdout.on('data', (c) => this.onData(c));
    this.proc.stderr.on('data', (c) => { this.stderr = (this.stderr + c.toString()).slice(-4000); });
    this.proc.on('error', (e) => this.die(e.message));
    this.proc.on('exit', (code) => this.die(`exited (${code})`));
    this.capabilities = /** @type {Record<string, unknown>} */ ({});
    this.ready = this.initialize();
  }

  /** @param {string} why */
  die(why) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.message = `${why}${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`;
    for (const p of this.pending.values()) p.reject(new Error(`${this.spec.id} ${this.message}`));
    this.pending.clear();
  }

  async initialize() {
    const uri = pathToFileURL(this.root).href;
    const result = /** @type {{ capabilities?: Record<string, unknown> }} */ (await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'stack-code-spike' },
      rootUri: uri,
      rootPath: this.root,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      initializationOptions: this.spec.init(this.root),
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didSave: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          documentHighlight: {},
        },
      },
    }));
    this.capabilities = result?.capabilities ?? {};
    this.notify('initialized', {});
    this.initMs = Date.now() - this.startedAt;
    if (this.state === 'starting') this.state = 'ready';
  }

  /** @param {Buffer} chunk */
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString('ascii'));
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < head + 4 + len) return;
      const body = this.buf.subarray(head + 4, head + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(head + 4 + len);
      try { this.onMessage(JSON.parse(body)); } catch { /* not JSON: skip the frame */ }
    }
  }

  /** @param {{ id?: number, method?: string, params?: any, result?: unknown, error?: { message: string } }} msg */
  onMessage(msg) {
    if (msg.method === undefined) { // a response
      const p = this.pending.get(/** @type {number} */ (msg.id));
      if (!p) return;
      this.pending.delete(/** @type {number} */ (msg.id));
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.id !== undefined) { // a request from the server: answer the few a browser needs to
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map((/** @type {{ section?: string }} */ i) => this.spec.config(i.section));
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    // Notifications: only indexing progress is of interest.
    if (msg.method === 'indexingStarted') { this.state = 'indexing'; this.indexStart = Date.now(); }
    else if (msg.method === 'indexingEnded') { this.state = 'ready'; this.indexMs = Date.now() - (this.indexStart ?? this.startedAt); }
    else if (msg.method === '$/progress') {
      const v = msg.params?.value ?? {};
      if (v.kind === 'begin') { this.state = 'indexing'; this.indexStart ??= Date.now(); this.message = v.title ?? ''; }
      else if (v.kind === 'report') this.message = v.message ?? this.message;
      else if (v.kind === 'end') { this.state = 'ready'; this.indexMs = Date.now() - (this.indexStart ?? this.startedAt); this.indexStart = undefined; this.message = ''; }
    }
  }

  /** @param {unknown} msg */
  write(msg) {
    if (this.state === 'dead') return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  /** @param {string} method @param {unknown} params */
  request(method, params) {
    if (this.state === 'dead') return Promise.reject(new Error(`${this.spec.id} ${this.message}`));
    const id = this.nextId++;
    this.requests++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {string} method @param {unknown} params */
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  /**
   * The server must have a document open to answer about it. Read-only browser: the text is the file on disk,
   * read here (never trusted from the client), and re-sent only when it changed.
   * @param {string} file @param {string} languageId
   */
  ensureOpen(file, languageId) {
    if (this.open.has(file)) return;
    this.open.add(file);
    const { text } = readFile(file);
    this.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text } });
  }

  rssMb() {
    if (this.state === 'dead' || !this.proc.pid) return 0;
    try {
      // The server and its children (typescript-language-server runs tsserver as a child).
      const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
      const kids = new Set([this.proc.pid]);
      for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of table) if (kids.has(ppid) && !kids.has(pid)) { kids.add(pid); grew = true; } }
      return Math.round(table.filter(([pid]) => kids.has(pid)).reduce((n, r) => n + r[2], 0) / 1024);
    } catch { return 0; }
  }

  status() {
    return {
      server: this.spec.id, root: this.root, state: this.state, message: this.message, pid: this.proc.pid,
      initMs: this.initMs, indexMs: this.indexMs, indexingForMs: this.state === 'indexing' && this.indexStart ? Date.now() - this.indexStart : undefined,
      requests: this.requests, openDocuments: this.open.size, rssMb: this.rssMb(),
    };
  }

  stop() { try { this.proc.kill(); } catch { /* already gone */ } }
}

/** @type {Map<string, LspServer>} */
const servers = new Map();

/** One server per (root, language family), started on first use. @param {string} root @param {string} languageId */
function serverFor(root, languageId) {
  const spec = SPECS.find((s) => s.languages.includes(languageId));
  if (!spec) throw new Refused(`No language server for ${languageId}.`);
  const key = `${spec.id}\n${root}`;
  let s = servers.get(key);
  if (!s || s.state === 'dead') { s = new LspServer(spec, root); servers.set(key, s); }
  return s;
}

/** Navigation only. Nothing that writes (rename, formatting, code actions, executeCommand) goes through. */
const METHODS = new Set([
  'textDocument/definition', 'textDocument/references', 'textDocument/hover', 'textDocument/documentSymbol',
  'textDocument/documentHighlight', 'textDocument/implementation', 'textDocument/typeDefinition', 'workspace/symbol',
]);

/** @param {{ root?: string, languageId?: string, method?: string, params?: any }} body */
async function lsp(body) {
  const root = rootOf(String(body.root));
  if (!METHODS.has(String(body.method))) throw new Refused(`Method not allowed: ${body.method}`);
  const server = serverFor(root, String(body.languageId));
  await server.ready;
  const uri = body.params?.textDocument?.uri;
  if (typeof uri === 'string') server.ensureOpen(inside(fileURLToPath(uri), { extras: true }), String(body.languageId));
  const t0 = Date.now();
  const result = await server.request(String(body.method), body.params);
  return { result, ms: Date.now() - t0 };
}

// ---------- http ----------

/** @param {http.IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */ const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Refused('The body must be JSON.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Dev only: the Vite page is another localhost origin. stackd's socket needs none of this.
  const origin = req.headers.origin ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  /** @param {number} status @param {unknown} body */
  const send = (status, body) => { const t = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(t); };
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = (/** @type {string} */ k) => url.searchParams.get(k) ?? '';
    if (req.method === 'GET' && url.pathname === '/roots') return send(200, { ok: true, result: ROOTS.map((r) => ({ root: r, name: path.basename(r) })) });
    if (req.method === 'GET' && url.pathname === '/tree') return send(200, { ok: true, result: listDir(inside(q('dir'))) });
    if (req.method === 'GET' && url.pathname === '/file') return send(200, { ok: true, result: readFile(inside(q('path'), { extras: true })) });
    if (req.method === 'GET' && url.pathname === '/files') {
      const { files, ms } = filesOf(rootOf(q('root')));
      return send(200, { ok: true, result: { total: files.length, walkMs: ms, files: fuzzy(files, q('q'), 60) } });
    }
    if (req.method === 'GET' && url.pathname === '/lsp/status') return send(200, { ok: true, result: [...servers.values()].map((s) => s.status()) });
    if (req.method === 'POST' && url.pathname === '/lsp') return send(200, { ok: true, result: await lsp(/** @type {any} */ (await readBody(req))) });
    send(404, { ok: false, error: 'Not found.' });
  } catch (e) {
    send(e instanceof Refused ? 403 : 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`code-dev-server on http://127.0.0.1:${PORT}`);
  for (const r of ROOTS) console.log(`  root ${r}`);
  console.log(`  open http://localhost:1430/?dev=code&api=http://127.0.0.1:${PORT}`);
});

const bye = () => { for (const s of servers.values()) s.stop(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
