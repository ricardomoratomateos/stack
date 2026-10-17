import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WindowFile } from './protocol';

/**
 * Finding the VS Code window a tool call is for.
 *
 * Used by the bridge on every call — never cached, since windows come, go and
 * reload (new port, new token) while an agent session lasts for hours — and by
 * the extension to sweep the files dead windows left behind.
 */

/**
 * Whether a process is running. Signal 0 checks without sending anything;
 * EPERM means it exists but belongs to someone else, which still counts.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** A discovery file's content, or undefined when it is not one. */
export function parseWindowFile(text: string): WindowFile | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  if (typeof w.pid !== 'number' || typeof w.port !== 'number' || typeof w.token !== 'string' || !w.token) return undefined;
  return {
    pid: w.pid,
    port: w.port,
    token: w.token,
    repoRoots: strings(w.repoRoots) ? w.repoRoots : [],
    workspaceFolders: strings(w.workspaceFolders) ? w.workspaceFolders : [],
    worktreeIds: strings(w.worktreeIds) ? w.worktreeIds : [],
    focusedAt: typeof w.focusedAt === 'number' ? w.focusedAt : 0,
  };
}

/**
 * Every live window's discovery file in `dir`. A file whose process is gone
 * is a window that crashed or was killed before it could clean up: ignored,
 * and removed on the way (best effort — another reader may beat us to it).
 */
export function readWindows(dir: string, isAlive: (pid: number) => boolean = isPidAlive): WindowFile[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: WindowFile[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const w = parseWindowFile(text);
    if (!w) continue;
    if (!isAlive(w.pid)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      continue;
    }
    out.push(w);
  }
  return out;
}

/** What a call can be matched on, strongest first. */
export interface ResolveTarget {
  /** The `repo` argument: an explicit path wins over everything. */
  repo?: string;
  /** A task id (the call's task_id, or $STACK_TASK_ID): the window showing that worktree. */
  taskId?: string;
  /** Where the agent runs: $CLAUDE_PROJECT_DIR, then the cwd. */
  paths: string[];
}

export type Resolution = { window: WindowFile } | { error: string };

/** How specifically `folder` contains `target`: its length when it does, -1 when not. */
function containment(target: string, folder: string): number {
  const t = path.resolve(target);
  const f = path.resolve(folder);
  return t === f || t.startsWith(f.endsWith(path.sep) ? f : f + path.sep) ? f.length : -1;
}

function bestScore(w: WindowFile, target: string): number {
  return Math.max(-1, ...[...w.repoRoots, ...w.workspaceFolders].map((f) => containment(target, f)));
}

/** Highest score, then the window focused most recently. */
function pick(scored: Array<{ w: WindowFile; score: number }>): WindowFile | undefined {
  return scored
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score || b.w.focusedAt - a.w.focusedAt)[0]?.w;
}

/**
 * The window a call goes to.
 *
 * 1. `repo` given: the window whose folders contain it most specifically.
 * 2. A task id some window shows: that window — a manager in one repository
 *    can follow up on a task by id, and a worker finds its window wherever
 *    its cwd is.
 * 3. The agent's project dir / cwd, most specific folder first.
 *
 * Ties go to the most recently focused window. Nothing matching is an error
 * naming what IS open, so the agent can pass `repo` — never a guess: creating
 * a task in the wrong repository is worse than asking.
 */
export function resolveWindow(windows: WindowFile[], target: ResolveTarget): Resolution {
  if (windows.length === 0) {
    const where = target.repo ?? target.paths[0];
    return { error: `No VS Code window with Stack is open${where ? ` on ${where}` : ''}. Open Stack on ${where ?? 'the repository'} in VS Code.` };
  }
  const open = () => windows.map((w) => w.repoRoots[0] ?? w.workspaceFolders[0]).filter(Boolean).join(', ');
  if (target.repo) {
    const found = pick(windows.map((w) => ({ w, score: bestScore(w, target.repo!) })));
    return found ? { window: found } : { error: `Open Stack on ${target.repo} in VS Code. Open now: ${open() || 'none'}.` };
  }
  if (target.taskId) {
    const owner = pick(windows.filter((w) => w.worktreeIds.includes(target.taskId!)).map((w) => ({ w, score: 0 })));
    if (owner) return { window: owner };
  }
  for (const p of target.paths) {
    const found = pick(windows.map((w) => ({ w, score: bestScore(w, p) })));
    if (found) return { window: found };
  }
  const where = target.paths[0];
  return {
    error: `Open Stack on ${where ?? 'this repository'} in VS Code, or pass "repo" with one of the open repositories: ${open() || 'none'}.`,
  };
}
