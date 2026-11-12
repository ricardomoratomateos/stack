// SPIKE (docs/spikes/code-browser.md) — code-lsp-bench.mjs <scenario.json>
// Spawns one language server over stdio, waits for its indexing, and times requests (first / repeated),
// with its memory footprint. Scenario:
//   { name, cwd, cmd: [bin, ...args], env?, init?, config?, waitProgress?, settleMs?, maxWaitMs?,
//     map?: [from, to]            rewrite paths in the answers (a mirror or base checkout -> the task worktree)
//     textRoot?, overlay?: [rel]  open (and "save") files of another tree under this root's URIs
//     overlaySave?: false         open only
//     watched?: [[rel, type]]     send workspace/didChangeWatchedFiles first (2 changed, 3 deleted)
//     dump?: true                 write <scenario>.out.json with every answer as sorted `path:line`
//     requests: [{ label, method, file?, line?, ch?, query?, repeat?, timeout? } | { sleep: ms }] }   (0-based line/ch)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = Date.now();
const proc = spawn(sc.cmd[0], sc.cmd.slice(1), { cwd: sc.cwd, env: { ...process.env, NODE_OPTIONS: '', ...(sc.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-3000); });
proc.on('exit', (code) => { console.log(`server exited (${code}) ${stderr.split('\n').slice(-4).join(' | ')}`); process.exit(1); });

let buf = Buffer.alloc(0), nextId = 1;
const pending = new Map();
let progressOpen = 0, progressSeen = false, lastProgress = '', progressEndAt = 0, peak = 0;
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); proc.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); proc.stdin.write(b); };
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }); });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
proc.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())?.[1] ?? 0);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len);
    if (msg.method === undefined) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result ?? null); }
    else if (msg.id !== undefined) {
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map((i) => (sc.config ?? {})[i.section] ?? null);
      send({ jsonrpc: '2.0', id: msg.id, result });
    } else if (msg.method === '$/progress') {
      const v = msg.params?.value ?? {};
      if (v.kind === 'begin') { progressOpen++; progressSeen = true; lastProgress = v.title ?? ''; }
      else if (v.kind === 'report') lastProgress = v.message ?? lastProgress;
      else if (v.kind === 'end') { progressOpen--; progressEndAt = Date.now(); }
    } else if (msg.method === 'indexingStarted') { progressOpen++; progressSeen = true; }
    else if (msg.method === 'indexingEnded') { progressOpen--; progressEndAt = Date.now(); }
    else if (msg.method === 'window/showMessage' || msg.method === 'window/logMessage') { if (process.env.VERBOSE) console.log('  [server]', String(msg.params?.message).slice(0, 200)); }
  }
});

function tree() {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Set([proc.pid]);
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of table) if (kids.has(ppid) && !kids.has(pid)) { kids.add(pid); grew = true; } }
  return { pids: [...kids], rss: Math.round(table.filter(([pid]) => kids.has(pid)).reduce((n, r) => n + r[2], 0) / 1024) };
}
function footprint() {
  let total = 0, peakFp = 0;
  for (const pid of tree().pids) {
    try {
      const out = execFileSync('footprint', [String(pid)], { encoding: 'utf8' });
      total += Number(/phys_footprint: (\d+) MB/.exec(out)?.[1] ?? 0);
      peakFp += Number(/phys_footprint_peak: (\d+) MB/.exec(out)?.[1] ?? 0);
    } catch { /* gone */ }
  }
  return { total, peak: peakFp };
}
const sampler = setInterval(() => { try { peak = Math.max(peak, tree().rss); } catch { /* */ } }, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (f) => pathToFileURL(f).href;
const unmap = (s) => (sc.map ? s.split(sc.map[0]).join(sc.map[1]) : s);

const root = uri(sc.cwd);
await request('initialize', {
  processId: process.pid, rootUri: root, rootPath: sc.cwd, workspaceFolders: [{ uri: root, name: path.basename(sc.cwd) }],
  initializationOptions: sc.init ?? {},
  capabilities: {
    workspace: { configuration: true, workspaceFolders: true, symbol: {}, didChangeWatchedFiles: { dynamicRegistration: true } },
    window: { workDoneProgress: true },
    textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, synchronization: {} },
  },
});
notify('initialized', {});
console.log(`# ${sc.name}\ninitialize: ${Date.now() - t0} ms`);

if (sc.waitProgress) {
  await sleep(sc.settleMs ?? 3000);
  let shown = 0;
  while (progressOpen > 0 || (!progressSeen && Date.now() - t0 < (sc.maxWaitMs ?? 20000))) {
    await sleep(500);
    if (Date.now() - shown > 30000) { shown = Date.now(); console.log(`  … ${Math.round((Date.now() - t0) / 1000)} s ${lastProgress} rss ${tree().rss} MB`); }
  }
  console.log(`indexing done: ${((progressEndAt || Date.now()) - t0) / 1000} s after spawn (progress seen: ${progressSeen}); peak RSS ${peak} MB; now RSS ${tree().rss} MB; footprint ${JSON.stringify(footprint())}`);
}

const opened = new Set();
// Overlay: files of another tree (sc.textRoot, same relative layout) opened under THIS root's URIs, then "saved",
// so the server sees and indexes the other tree's content without it being on disk here.
const textOf = (f) => { const alt = sc.textRoot && path.join(sc.textRoot, path.relative(sc.cwd, f)); return fs.readFileSync(alt && fs.existsSync(alt) ? alt : f, 'utf8'); };
if (sc.watched) {
  // Tell the server these files changed (2) or were deleted (3) on disk: it re-reads them from its own root.
  const s0 = Date.now();
  notify('workspace/didChangeWatchedFiles', { changes: sc.watched.map(([rel, type]) => ({ uri: uri(path.join(sc.cwd, rel)), type })) });
  await sleep(sc.watchedWaitMs ?? 6000);
  console.log(`watched: ${sc.watched.length} file events sent, waited ${Date.now() - s0} ms`);
}
if (sc.overlay) {
  const s0 = Date.now();
  for (const rel of sc.overlay) {
    const f = path.join(sc.cwd, rel);
    opened.add(f);
    notify('textDocument/didOpen', { textDocument: { uri: uri(f), languageId: 'php', version: 1, text: textOf(f) } });
    if (sc.overlaySave !== false) notify('textDocument/didSave', { textDocument: { uri: uri(f) } });
  }
  await request('workspace/symbol', { query: 'zzzzNothing' }); // a round trip: the notifications above were processed
  console.log(`overlay: ${sc.overlay.length} documents opened${sc.overlaySave !== false ? ' and saved' : ''} in ${Date.now() - s0} ms`);
}
for (const r of sc.requests) {
  if (r.sleep) { await sleep(r.sleep); console.log(`(idle ${r.sleep} ms) RSS ${tree().rss} MB footprint ${JSON.stringify(footprint())}`); continue; }
  if (r.file && !opened.has(r.file)) {
    opened.add(r.file);
    const ext = path.extname(r.file);
    const languageId = ext === '.php' ? 'php' : ext === '.tsx' ? 'typescriptreact' : 'typescript';
    notify('textDocument/didOpen', { textDocument: { uri: uri(r.file), languageId, version: 1, text: textOf(r.file) } });
  }
  const params = r.method === 'workspace/symbol' ? { query: r.query }
    : { textDocument: { uri: uri(r.file) }, position: { line: r.line ?? 0, character: r.ch ?? 0 }, context: { includeDeclaration: true } };
  const times = [];
  let res, err = '';
  for (let i = 0; i < (r.repeat ?? 2); i++) {
    const s = Date.now();
    try { res = await Promise.race([request(r.method, params), sleep(r.timeout ?? 120000).then(() => { throw new Error('timeout'); })]); } catch (e) { err = e.message; }
    times.push(Date.now() - s);
  }
  const list = Array.isArray(res) ? res : res ? [res] : [];
  const first = list[0];
  let what = '';
  if (first) {
    const u = first.uri ?? first.targetUri ?? first.location?.uri;
    const rg = first.range ?? first.targetSelectionRange ?? first.location?.range;
    what = u ? `${unmap(decodeURIComponent(u)).replace('file://' + sc.cwd + '/', '').replace(/^file:\/\/.*\/(vendor|node_modules)\//, '…/$1/')}:${(rg?.start?.line ?? 0) + 1}` : first.name ? `${first.name}` : JSON.stringify(first.contents?.value ?? first.contents ?? first).replace(/\\n/g, ' ').slice(0, 110);
  }
  if (sc.dump) {
    (globalThis.__out ??= {})[r.label] = list.map((x) => {
      const u = x.uri ?? x.targetUri ?? x.location?.uri; const rg = x.range ?? x.targetSelectionRange ?? x.location?.range;
      return u ? `${sc.map ? (decodeURIComponent(u).includes(sc.map[0]) ? 'B ' : 'T ') : ''}${unmap(decodeURIComponent(u)).replace('file://', '').replace(sc.map ? sc.map[1] + '/' : sc.cwd + '/', '')}:${(rg?.start?.line ?? 0) + 1}` : (x.name ?? 'hover:' + JSON.stringify(x.contents?.value ?? '').length);
    }).sort();
  }
  console.log(`${r.label.padEnd(44)} cold ${String(times[0]).padStart(6)} ms  warm ${String(times.slice(1).join('/') || '-').padStart(6)} ms  ${String(list.length).padStart(4)} res  ${err ? 'ERROR ' + err : what}`);
}
console.log(`end: RSS ${tree().rss} MB (peak ${peak} MB); footprint ${JSON.stringify(footprint())}; elapsed ${Math.round((Date.now() - t0) / 1000)} s`);
if (sc.dump) fs.writeFileSync(process.argv[2].replace(/\.json$/, '.out.json'), JSON.stringify(globalThis.__out, null, 1));
clearInterval(sampler);
proc.removeAllListeners('exit');
proc.kill();
setTimeout(() => process.exit(0), 300);
