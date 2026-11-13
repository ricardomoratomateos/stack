#!/usr/bin/env node
// @ts-check
/**
 * End-to-end proof of stackd's PHP navigation, with the real CodeService, real git and a real Phpactor, against
 * a real repository and real task worktrees. Nothing is written in the repository; indexes go to --cache.
 *
 *   node desktop/scripts/code-e2e.mjs --repo <main checkout> --task <worktree> [--task <worktree>…]
 *        --cache <scratch dir, NOT ~/.config/stack/cache> [--base develop] [--base-from develop~40]
 *        [--tools ~/.config/stack/tools]
 *
 * It builds the repo's base (sources of the base branch + their index; with --base-from, first at that older
 * commit and then brought up to date incrementally, as when the branch moves), opens each task (clone +
 * overlay), and checks, on cases it derives from the task's own diff:
 *   1. F12 on a class the task added                    -> the added file
 *   2. F12 from changed code into unchanged code        -> the unchanged file
 *   3. ⇧F12 on an unchanged class                       -> includes a call site the diff added
 *   4. workspace symbol for a class the task added      -> the added file
 *   5. the base index is byte-for-byte what it was before the task
 *   6. never more than one Phpactor alive at a time
 * Exit code 1 when a check fails.
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = (/** @type {string} */ name) => { const out = []; for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[++i]); return out; };
const repoRoot = fs.realpathSync(args('repo')[0] ?? '');
const tasks = args('task').map((t) => fs.realpathSync(t));
const cacheDir = path.resolve(args('cache')[0] ?? '');
const baseBranch = args('base')[0] ?? 'develop';
const baseFrom = args('base-from')[0];
const toolsDir = path.resolve(args('tools')[0] ?? path.join(os.homedir(), '.config', 'stack', 'tools'));
if (!args('repo')[0] || !tasks.length || !args('cache')[0]) { console.error('usage: code-e2e.mjs --repo <dir> --task <dir>… --cache <scratch dir> [--base develop] [--tools <dir>]'); process.exit(2); }
if (cacheDir.startsWith(path.join(os.homedir(), '.config', 'stack'))) { console.error('--cache must not be Stack\'s own cache.'); process.exit(2); }

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(here, 'package.json'));
fs.mkdirSync(cacheDir, { recursive: true });
const out = path.join(fs.mkdtempSync(path.join(path.dirname(cacheDir), 'stack-code-e2e-')), 'CodeService.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(here, 'src/code/CodeService.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out, logLevel: 'warning' });
const { CodeService, CodeError } = require(out);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s`;
const say = (/** @type {string} */ line) => console.log(`${stamp()}  ${line}`);
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\n$/, ''); } catch { return ''; } };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// Every Phpactor the service starts goes through here: how many are alive at once, and how much memory they take.
let alive = 0, maxAlive = 0, spawned = 0, peakRssMb = 0;
/** @type {Set<number>} */ const pids = new Set();
const spawn = (/** @type {string} */ command, /** @type {string[]} */ argv, /** @type {{ cwd: string, env: NodeJS.ProcessEnv }} */ options) => {
  const child = nodeSpawn(command, argv, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned++; alive++; maxAlive = Math.max(maxAlive, alive);
  if (child.pid) pids.add(child.pid);
  child.on('exit', () => { alive--; if (child.pid) pids.delete(child.pid); });
  return child;
};
const sampler = setInterval(() => {
  for (const pid of pids) {
    try { peakRssMb = Math.max(peakRssMb, Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024)); } catch { /* gone */ }
  }
}, 500);

const service = new CodeService({ cacheDir, toolsDir, spawn, log: (/** @type {string} */ l) => say(l) });

/** A digest of a directory: every file's path, size and mtime. Unchanged digest = nothing was written in it. */
function digest(/** @type {string} */ dir) {
  const h = crypto.createHash('sha256');
  let files = 0, bytes = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const st = fs.statSync(p); files++; bytes += st.size; h.update(`${path.relative(dir, p)}\0${st.size}\0${st.mtimeMs}\n`); }
    }
  })(dir);
  return { files, bytes, sha: h.digest('hex').slice(0, 16) };
}
const du = (/** @type {string} */ dir) => { try { return execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).split('\t')[0].trim(); } catch { return '?'; } };

/** Asks until it is answered: "Preparing…" / "Indexing…" are the service saying "not yet". */
async function ask(/** @type {any} */ task, /** @type {string} */ method, /** @type {any} */ params) {
  let waits = 0;
  for (;;) {
    try { return { result: await service.lsp(task, 'php', method, params), waits }; } catch (e) {
      if (!(e instanceof CodeError) || !/^(Preparing|Indexing)/.test(e.message)) throw e;
      if (waits++ % 20 === 0) say(`   … ${e.message}`);
      await sleep(1000);
    }
  }
}
const locs = (/** @type {any} */ r) => (Array.isArray(r) ? r : r ? [r] : []).map((/** @type {any} */ l) => `${fileURLToPath(l.uri ?? l.location?.uri)}:${(l.range ?? l.location?.range).start.line + 1}`);

/** Cases from the task's own diff against its merge-base with the base. */
function casesOf(/** @type {string} */ root, /** @type {string} */ baseCommit) {
  const head = git(root, 'rev-parse', 'HEAD');
  const mergeBase = git(root, 'merge-base', baseCommit, head);
  const status = git(root, 'diff', '--name-status', '--no-renames', mergeBase, head, '--', '*.php').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const added = status.filter(([s, f]) => s === 'A' && !/Test\.php$/.test(f) && !f.includes('/tests/')).map(([, f]) => f);
  const changed = new Set(status.map(([, f]) => f));
  const classIn = (/** @type {string} */ f) => { const m = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/m.exec(fs.readFileSync(path.join(root, f), 'utf8')); return m?.[1]; };
  // Where a class lives, by Composer's PSR-4 map (longest prefix first).
  /** @type {Array<[string, string]>} */ let prefixes = [];
  try {
    const autoload = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8')).autoload?.['psr-4'] ?? {};
    prefixes = Object.entries(autoload).map(([k, v]) => /** @type {[string, string]} */ ([k, String(Array.isArray(v) ? v[0] : v)])).sort((x, y) => y[0].length - x[0].length);
  } catch { /* no composer.json: no such case */ }
  const psr4 = (/** @type {string} */ fqn) => { const hit = prefixes.find(([k]) => fqn.startsWith(k)); return hit ? path.join(hit[1], `${fqn.slice(hit[0].length).replace(/\\/g, '/')}.php`) : undefined; };
  /** @type {any} */ const c = { own: status.length };
  // Lines the diff added, with their place in the task's file.
  /** @type {Array<{ file: string, line: number, text: string }>} */ const addedLines = [];
  let file = '', line = 0;
  for (const l of git(root, 'diff', '-U0', '--no-renames', mergeBase, head, '--', '*.php').split('\n')) {
    if (l.startsWith('+++ b/')) file = l.slice(6);
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith('+') && !l.startsWith('+++')) addedLines.push({ file, line: line++, text: l.slice(1) });
  }
  // 1 + 4: a class the task added, and a line (added by the diff, in another file) that names it.
  for (const f of added) {
    const name = classIn(f);
    if (!name) continue;
    const use = addedLines.find((a) => a.file !== f && new RegExp(`\\b${name}\\b`).test(a.text) && !/^\s*(\*|\/\/|namespace )/.test(a.text));
    if (use) { c.addedClass = { name, file: f, at: { file: use.file, line: use.line - 1, character: use.text.search(new RegExp(`\\b${name}\\b`)) + 1 } }; break; }
    c.addedClass ??= { name, file: f };
  }
  // 2 + 3: an added `use X\Y\Z;` whose class lives in a file the task did not touch.
  for (const a of addedLines) {
    const m = /^use ([\w\\]+)\\(\w+);/.exec(a.text);
    if (!m) continue;
    const rel = psr4(`${m[1]}\\${m[2]}`);
    const found = rel && fs.existsSync(path.join(root, rel)) ? [rel] : [];
    if (found.length !== 1 || changed.has(found[0]) || found[0].startsWith('vendor/')) continue;
    // A call site of it the diff added (not the `use` line): `new X(`, `X::`, a type hint.
    const call = addedLines.find((x) => x.file !== found[0] && !/^\s*(use |\*|\/\/)/.test(x.text) && new RegExp(`\\b${m[2]}\\b`).test(x.text));
    c.unchanged = { name: m[2], file: found[0], at: { file: a.file, line: a.line - 1, character: a.text.lastIndexOf(m[2]) + 1 }, call: call && { file: call.file, line: call.line } };
    if (call) break;
  }
  return c;
}

let failed = 0;
const check = (/** @type {string} */ what, /** @type {boolean} */ ok, /** @type {string} */ detail) => { if (!ok) failed++; say(`${ok ? 'PASS' : 'FAIL'}  ${what}  ${detail}`); };

if (process.argv.includes('--cases-only')) {
  // What the checks would be for each task, without starting anything.
  const commit = git(repoRoot, 'rev-parse', `origin/${baseBranch}`);
  for (const root of tasks) console.log(path.basename(root), JSON.stringify(casesOf(root, commit)));
  process.exit(0);
}

try {
  // ── The base ───────────────────────────────────────────────────────────────
  const repoDir = () => path.join(cacheDir, 'phpactor', fs.readdirSync(path.join(cacheDir, 'phpactor'))[0]);
  const baseStatus = () => service.status({ id: 'none', root: repoRoot, repoRoot }).find((/** @type {any} */ s) => s.server === 'php base');
  /** Builds (or updates) the base at `branch` and waits for it, saying how long each half took. */
  async function prepare(/** @type {string} */ branch) {
    say(`base: preparing ${branch} of ${repoRoot}`);
    peakRssMb = 0;
    const b0 = Date.now();
    await service.prepareBase(repoRoot, branch);
    let extractedAt = 0, last = '';
    for (;;) {
      const st = baseStatus();
      if (!extractedAt && st && /\d+\/\d+|indexing/.test(st.message)) { extractedAt = Date.now(); say(`base: sources ready in ${((extractedAt - b0) / 1000).toFixed(1)} s (${du(path.join(repoDir(), 'base-src'))})`); }
      if (st?.message && st.message !== last && Date.now() - b0 > 2000) { last = st.message; }
      if (!st || st.state !== 'indexing') break;
      await sleep(500);
    }
    await service.baseSettled(repoRoot);
    const st = baseStatus();
    const info = JSON.parse(fs.readFileSync(path.join(repoDir(), 'base.json'), 'utf8'));
    say(`base: "${st?.message}" — total ${((Date.now() - b0) / 1000).toFixed(1)} s, index ${extractedAt ? ((Date.now() - extractedAt) / 1000).toFixed(1) : '?'} s, Phpactor peak RSS ${peakRssMb} MB, index on disk ${du(path.join(repoDir(), 'base'))}`);
    check(`base ready at ${branch}`, st?.state === 'ready' && info.ready === true && info.commit === git(repoRoot, 'rev-parse', `origin/${branch}`), JSON.stringify(info));
    await sleep(1500);
    check('no Phpactor left running after the base', alive === 0, `alive ${alive}`);
    return info;
  }
  if (baseFrom) {
    await prepare(baseFrom);
    const n = git(repoRoot, 'diff', '--name-only', `origin/${baseFrom}`, `origin/${baseBranch}`, '--', '*.php').split('\n').filter(Boolean).length;
    say(`base: ${baseBranch} is ${n} PHP file(s) ahead of ${baseFrom}: updating`);
  }
  const info = await prepare(baseBranch);
  const before = digest(path.join(repoDir(), 'base'));
  const srcBefore = digest(path.join(repoDir(), 'base-src'));
  say(`base: index ${before.files} files, ${(before.bytes / 1e6).toFixed(0)} MB, digest ${before.sha}`);

  // ── Each task ──────────────────────────────────────────────────────────────
  for (const root of tasks) {
    const task = { id: path.basename(root), root, repoRoot, baseBranch };
    const differs = git(root, 'diff', '--name-only', info.commit, 'HEAD', '--', '*.php').split('\n').filter(Boolean).length;
    const c = casesOf(root, info.commit);
    say(`task ${task.id}: ${c.own} PHP file(s) of its own, ${differs} differ from the base`);
    peakRssMb = 0;
    const o0 = Date.now();
    const first = await ask(task, 'workspace/symbol', { query: c.addedClass?.name ?? c.unchanged?.name ?? 'Controller' });
    say(`task ${task.id}: open (clone + overlay) and first answer in ${((Date.now() - o0) / 1000).toFixed(1)} s (${first.waits} "not yet")`);
    const w0 = Date.now();
    await service.lsp(task, 'php', 'workspace/symbol', { query: 'Handler' });
    say(`task ${task.id}: a warm workspace/symbol in ${Date.now() - w0} ms`);
    const uri = (/** @type {string} */ f) => pathToFileURL(path.join(root, f)).href;

    if (c.addedClass) {
      const hits = locs(first.result);
      check(`4 workspace symbol for added class ${c.addedClass.name}`, hits.some((h) => h.startsWith(path.join(root, c.addedClass.file) + ':')), hits.slice(0, 2).join(' ') || '(none)');
      if (c.addedClass.at) {
        const s = Date.now();
        const r = locs((await ask(task, 'textDocument/definition', { textDocument: { uri: uri(c.addedClass.at.file) }, position: c.addedClass.at })).result);
        check(`1 F12 on added class ${c.addedClass.name} (from ${c.addedClass.at.file}:${c.addedClass.at.line + 1})`, r.some((h) => h.startsWith(path.join(root, c.addedClass.file) + ':')), `${r[0] ?? '(none)'}  ${Date.now() - s} ms`);
      } else check(`1 F12 on added class ${c.addedClass.name}`, false, 'no added line names it: case not derivable');
    } else say('SKIP  1/4 the task adds no class');

    if (c.unchanged) {
      const at = { textDocument: { uri: uri(c.unchanged.at.file) }, position: c.unchanged.at };
      let s = Date.now();
      const d = locs((await ask(task, 'textDocument/definition', at)).result);
      check(`2 F12 from changed code into unchanged ${c.unchanged.name}`, d.some((h) => h.startsWith(path.join(root, c.unchanged.file) + ':')), `${d[0] ?? '(none)'}  ${Date.now() - s} ms`);
      s = Date.now();
      const refs = locs((await ask(task, 'textDocument/references', { ...at, context: { includeDeclaration: true } })).result);
      const site = c.unchanged.call ?? { file: c.unchanged.at.file, line: c.unchanged.at.line + 1 };
      const want = `${path.join(root, site.file)}:${site.line}`;
      check(`3 ⇧F12 on ${c.unchanged.name} includes the call site the diff added at ${site.file}:${site.line}`, refs.includes(want), `${refs.length} reference(s)  ${Date.now() - s} ms`);
    } else say('SKIP  2/3 no added `use` of an unchanged class in this diff');

    say(`task ${task.id}: Phpactor peak RSS ${peakRssMb} MB; its index ${du(path.join(repoDir(), 'tasks', task.id))} (a clone: shared with the base until it diverges)`);
    check('5 the task wrote nothing in its worktree', !fs.existsSync(path.join(root, '.phpactor.json')), '');
  }

  service.dispose();
  await sleep(1500);
  const after = digest(path.join(repoDir(), 'base'));
  const srcAfter = digest(path.join(repoDir(), 'base-src'));
  check('5 the base index is unchanged after the tasks', after.sha === before.sha && after.files === before.files, `${before.sha} -> ${after.sha} (${after.files} files)`);
  check('5 the base sources are unchanged after the tasks', srcAfter.sha === srcBefore.sha, `${srcBefore.sha} -> ${srcAfter.sha}`);
  check('6 never more than one Phpactor at a time', maxAlive === 1, `${spawned} started, at most ${maxAlive} alive at once`);
  check('nothing written in the main checkout', !fs.existsSync(path.join(repoRoot, '.phpactor.json')), '');
} catch (e) {
  failed++;
  say(`ERROR ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  clearInterval(sampler);
  service.dispose();
}
say(failed ? `${failed} check(s) FAILED` : 'all checks passed');
setTimeout(() => process.exit(failed ? 1 : 0), 500);
