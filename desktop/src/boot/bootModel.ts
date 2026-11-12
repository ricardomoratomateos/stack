import { describe, groupOf, type WorktreeGroup } from '@core/webview/derive';
import type { Snapshot } from '../stackd/api';

/** One branch of the boot graph: a task, and its group once stackd has confirmed it. */
export interface BootTask {
  id: string;
  name: string;
  group?: WorktreeGroup;
}

/** The trunk's label and the branches the boot screen draws. */
export interface BootGraph {
  trunk: string;
  tasks: BootTask[];
  /** Tasks past `MAX_BRANCHES`, drawn as one "+n" tip. */
  more: number;
}

export const MAX_BRANCHES = 7;
const CACHE_KEY = 'stack.boot.v1';

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** The graph a live snapshot draws: every repo's non-main tasks, each with its group. */
export function graphOf(snapshot: Snapshot): BootGraph {
  const tasks: BootTask[] = [];
  for (const repo of snapshot.repos) {
    for (const wt of repo.state.worktrees) {
      if (wt.isMain) continue;
      tasks.push({ id: wt.id, name: describe(wt).name, group: groupOf(wt) });
    }
  }
  const trunk = snapshot.repos.length === 1 ? basename(snapshot.repos[0].repoRoot) : snapshot.repos.length ? `${snapshot.repos.length} repos` : 'main';
  return cap({ trunk, tasks, more: 0 });
}

/**
 * What to draw now: the live graph once there is one, laid over the remembered one so
 * branches already on screen keep their place (new tasks grow at the end, gone ones drop).
 * Before stackd answers, the remembered tasks, unconfirmed.
 */
export function mergeGraph(cached: BootGraph | null, live: BootGraph | null): BootGraph {
  if (!live) return cached ? cap({ ...cached, tasks: cached.tasks.map(({ id, name }) => ({ id, name })) }) : { trunk: 'main', tasks: [], more: 0 };
  if (!cached) return live;
  const byId = new Map(live.tasks.map((t) => [t.id, t] as const));
  const kept = cached.tasks.flatMap((t) => byId.get(t.id) ?? []);
  const keptIds = new Set(kept.map((t) => t.id));
  return cap({ trunk: live.trunk, tasks: [...kept, ...live.tasks.filter((t) => !keptIds.has(t.id))], more: live.more });
}

function cap(g: BootGraph): BootGraph {
  if (g.tasks.length <= MAX_BRANCHES) return g;
  return { ...g, tasks: g.tasks.slice(0, MAX_BRANCHES), more: g.more + g.tasks.length - MAX_BRANCHES };
}

/** The graph remembered from the last run, for the next boot to draw at once. */
export function loadCached(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): BootGraph | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as BootGraph;
    return Array.isArray(g?.tasks) && typeof g.trunk === 'string' ? g : null;
  } catch {
    return null;
  }
}

export function saveCached(g: BootGraph, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ trunk: g.trunk, tasks: g.tasks.map(({ id, name }) => ({ id, name })), more: g.more }));
  } catch {
    // private mode / quota: the next boot just starts from the trunk
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Geometry of the graph in a 520-wide viewBox: the trunk along the middle, tips in a column. */
export interface Layout {
  height: number;
  trunkY: number;
  trunkEnd: number;
  tipX: number;
  branches: { forkX: number; y: number; path: string }[];
}

const ROW = 30;
const TRUNK_START = 24;
const TIP_X = 252;

export function layout(count: number): Layout {
  const rows = Math.max(1, count);
  const height = Math.max(120, rows * ROW + 48);
  const trunkY = height / 2;
  // Forks spread along the trunk; the last one sits well before the tips so every branch curves.
  const forkSpan = 130;
  const branches = Array.from({ length: count }, (_, i) => {
    const forkX = TRUNK_START + 40 + (count === 1 ? forkSpan / 2 : (forkSpan * i) / (count - 1));
    const y = trunkY + (i - (count - 1) / 2) * ROW;
    const path = `M ${forkX} ${trunkY} C ${forkX + 46} ${trunkY}, ${TIP_X - 56} ${y}, ${TIP_X} ${y}`;
    return { forkX, y, path };
  });
  const trunkEnd = count ? branches[branches.length - 1].forkX : TIP_X;
  return { height, trunkY, trunkEnd, tipX: TIP_X, branches };
}

export const TRUNK_X = TRUNK_START;
