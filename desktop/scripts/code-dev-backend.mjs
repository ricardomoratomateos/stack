#!/usr/bin/env node
// @ts-check
/**
 * Dev only: stackd's Code service (src/code/CodeService.ts) for ONE directory over localhost, so the Code tab
 * can be worked on at `/?dev=code` without the app or a stackd restart. Same commands, same answers.
 *
 *   node desktop/scripts/code-dev-backend.mjs --root <worktree> [--repo <main checkout>] [--base <git ref>]
 *        [--port 1431] [--config <dir>]   cache/ and tools/ live under it (default ~/.config/stack)
 *        [--phpactor <path>]              as the `phpactorPath` setting
 *
 * Nothing is written under --root.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (/** @type {string} */ name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const root = arg('root');
if (!root) { console.error('usage: code-dev-backend.mjs --root <worktree> [--repo <dir>] [--base <ref>] [--port N] [--config <dir>] [--phpactor <path>]'); process.exit(2); }
const repoRoot = path.resolve(arg('repo') ?? root);
const port = Number(arg('port') ?? 1431);
const configDir = path.resolve(arg('config') ?? path.join(os.homedir(), '.config', 'stack'));

// The service is TypeScript: bundle it the way stackd is bundled, into a temp file, and load that.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-code-dev-')), 'CodeService.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(repo, 'src/code/CodeService.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out, logLevel: 'warning' });
const { CodeService, CodeError, PathRefused, defaultCodeConfig } = require(out);

const service = new CodeService({
  cacheDir: path.join(configDir, 'cache'),
  toolsDir: path.join(configDir, 'tools'),
  config: () => defaultCodeConfig({ phpactorPath: arg('phpactor') ?? '' }),
  log: console.log,
});
const task = { id: `dev-${path.basename(path.resolve(root))}`, root: path.resolve(root), repoRoot };

/** @param {string} name @param {Record<string, unknown>} b */
async function command(name, b) {
  switch (name) {
    case 'codeOpen': {
      let unified = '';
      const base = arg('base');
      if (base) { try { unified = execFileSync('git', ['-C', task.root, 'diff', base], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { /* no such ref */ } }
      return service.open(task, unified);
    }
    case 'codeTree': return service.tree(task, b.dir);
    case 'codeRead': return service.read(task, b.path);
    case 'codeFiles': return service.files(task, String(b.query ?? ''));
    case 'codeSearch': return service.search(task, String(b.query ?? ''), { caseSensitive: b.caseSensitive === true, wholeWord: b.wholeWord === true });
    case 'codeLsp': return { result: await service.lsp(task, String(b.languageId), String(b.method), b.params) };
    case 'codeDiagnostics': return { diagnostics: await service.diagnostics(task, b.path) };
    case 'codeStatus': return service.status(task);
    default: throw new CodeError(`Unknown command ${name}`);
  }
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const send = (/** @type {number} */ status, /** @type {unknown} */ body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = /^\/commands\/([A-Za-z]+)$/.exec(req.url ?? '');
  if (!m || req.method !== 'POST') return send(404, { ok: false, error: 'Not found.' });
  /** @type {Buffer[]} */ const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try { send(200, { ok: true, result: await command(m[1], chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }); }
    catch (e) { send(e instanceof PathRefused ? 403 : e instanceof CodeError ? 409 : 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`code-dev-backend on http://127.0.0.1:${port} for ${task.root}`);
  console.log(`  cd desktop && npx vite --port 1430 --strictPort, then open http://localhost:1430/?dev=code&api=http://127.0.0.1:${port}`);
});

const bye = () => { service.dispose(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
