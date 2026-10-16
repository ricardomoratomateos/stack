/**
 * What the sidebar makes of a worktree's raw state: which group it belongs to,
 * what its one-line summary says, how its stack and drift read.
 *
 * Pure, with no DOM or React: the three layouts all read from here (so they can
 * never disagree about what "needs you" means), and the extension host imports
 * it too, so the "jump to the next one that needs me" shortcut walks the same
 * queue the sidebar draws.
 */
import type { StackState, ProviderId, SessionItem, WorktreeItem } from './types';

export type WorktreeGroup = 'needs' | 'review' | 'working' | 'idle' | 'missing';

/** Display order of the groups, most urgent first. */
export const GROUP_ORDER: readonly WorktreeGroup[] = ['needs', 'review', 'working', 'idle', 'missing'];

export const GROUP_LABEL: Record<WorktreeGroup, string> = {
  needs: 'Needs you',
  review: 'Ready for review',
  working: 'Working',
  idle: 'Idle',
  missing: 'Missing',
};

/** Shorter names, for counters and chips that sit in a narrow row. */
export const GROUP_SHORT: Record<WorktreeGroup, string> = {
  needs: 'Needs you',
  review: 'Review',
  working: 'Working',
  idle: 'Idle',
  missing: 'Missing',
};

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'plain';

const isAgent = (s: SessionItem) => s.kind === 'agent' && s.state !== 'terminated';

/** Whether there is something to look at: uncommitted work, or commits beyond the base or the upstream. */
export function hasWork(wt: WorktreeItem): boolean {
  return wt.git.hasChanges || wt.git.ahead > 0 || (wt.git.base?.ahead ?? 0) > 0;
}

export function hasOpenPr(wt: WorktreeItem): boolean {
  return !!wt.pr && wt.pr.state.toLowerCase() === 'open';
}

/**
 * Where a worktree sits. First match wins, most urgent first:
 *
 * - missing: its directory is gone.
 * - needs you: any session is asking (`permission`).
 * - working: any session is `active`. Wins over review, because an agent still
 *   typing is not ready to be reviewed whatever the diff says.
 * - ready for review: an agent is idle or waiting AND there is work to look at
 *   (changes, commits beyond the base, or an open PR). A freshly launched agent
 *   on a clean tree is just idle.
 * - idle: everything else.
 */
export function groupOf(wt: WorktreeItem): WorktreeGroup {
  if (wt.missing) return 'missing';
  const agents = wt.sessions.filter(isAgent);
  if (wt.agent === 'permission' || agents.some((s) => s.state === 'permission')) return 'needs';
  if (wt.agent === 'active' || agents.some((s) => s.state === 'active')) return 'working';
  const resting = agents.some((s) => s.state === 'waiting' || s.state === 'idle');
  if (resting && (hasWork(wt) || hasOpenPr(wt))) return 'review';
  return 'idle';
}

const PRIORITY: Record<string, number> = { permission: 0, active: 1, waiting: 2, idle: 3 };

/** The agent session that best represents the worktree: the one asking, else the busy one. */
export function primaryAgent(wt: WorktreeItem): SessionItem | undefined {
  return wt.sessions
    .filter(isAgent)
    .sort((a, b) => (PRIORITY[a.state] ?? 9) - (PRIORITY[b.state] ?? 9))[0];
}

export interface ParsedAttention {
  /** The command the agent wants to run, when the message is one. */
  command?: string;
  /** Anything else it said. */
  text?: string;
}

/**
 * The permission request in a displayable shape. A command ("Bash: composer
 * test") renders like a shell line; a prose notification ("Claude needs your
 * permission to use Bash") renders as text.
 */
export function parseAttention(message: string | undefined): ParsedAttention | undefined {
  const line = message?.trim().split('\n')[0]?.trim();
  if (!line) return undefined;
  const bash = /^Bash:\s*(.+)$/.exec(line);
  return bash ? { command: bash[1] } : { text: line };
}

/** The first thing the asking session said, if it said anything. */
export function attentionOf(wt: WorktreeItem): ParsedAttention | undefined {
  const asking = wt.sessions.find((s) => isAgent(s) && s.state === 'permission' && s.attention);
  return parseAttention(asking?.attention);
}

/** The session the "Open" button should land on: the one asking, else the primary agent. */
export function sessionToOpen(wt: WorktreeItem): SessionItem | undefined {
  return wt.sessions.find((s) => isAgent(s) && s.state === 'permission') ?? primaryAgent(wt);
}

/** "now", "5m", "3h", "2d". */
export function formatAge(since: number | undefined, now: number): string {
  if (since === undefined) return '';
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The label a worktree goes by. */
export const nameOf = (wt: WorktreeItem): string => wt.alias ?? wt.branch;

function lineFor(wt: WorktreeItem, group: WorktreeGroup, agent: SessionItem | undefined): string {
  if (wt.deleting) return 'Deleting…';
  const title = agent?.title;
  switch (group) {
    case 'missing':
      return 'Folder not found on disk';
    case 'needs': {
      // The question itself is shown in a box under the row; the line only says what kind it is.
      const ask = attentionOf(wt);
      return ask?.command ? 'Wants to run a command' : ask?.text ? 'Needs your answer' : title ?? 'Wants your attention';
    }
    case 'working':
      return title ?? 'Working…';
    case 'review':
      return title ? `Done · ${title}` : 'Done — ready for review';
    case 'idle':
      return agent ? (title ?? 'Waiting for a task') : 'No agent running';
  }
}

export interface Described {
  wt: WorktreeItem;
  group: WorktreeGroup;
  name: string;
  agent?: SessionItem;
  provider?: ProviderId;
  /** One line on what the agent is up to. */
  line: string;
  attention?: ParsedAttention;
  /** Lines when git could count them, else the number of files touched. */
  diff?: { added: number; removed: number } | { files: number };
  base: { text: string; tone: Tone; title: string };
  stack: { text: string; tone: Tone; title: string };
  /** "http :8082" style, in the order the settings name them. */
  ports: Array<{ label: string; port: number; openable: boolean }>;
  pr?: { number: number; state: 'open' | 'merged' | 'closed' };
}

function describeDiff(wt: WorktreeItem): Described['diff'] {
  const lines = wt.git.lines;
  if (lines && lines.added + lines.removed > 0) return lines;
  const files = wt.git.staged + wt.git.unstaged + wt.git.untracked;
  return wt.git.hasChanges && files > 0 ? { files } : undefined;
}

function describeBase(wt: WorktreeItem): Described['base'] {
  const base = wt.git.base;
  if (!base) return { text: wt.isMain ? 'main checkout' : '—', tone: 'muted', title: 'No base branch to compare against' };
  const title = `${base.behind} commit${base.behind === 1 ? '' : 's'} behind ${base.ref}, ${base.ahead} ahead — click to fetch and check again`;
  if (base.behind > 0) return { text: `↓${base.behind} behind ${base.ref}`, tone: 'warn', title };
  return { text: `up to date with ${base.ref}`, tone: 'ok', title };
}

/** "3/3 up", "stopped", "starting…", "1 crashed" — and why, in the tooltip. */
export function describeStack(wt: WorktreeItem, dockerUnavailable?: string): Described['stack'] {
  if (wt.dockerBusy) return { text: wt.dockerBusy === 'starting' ? 'starting…' : 'stopping…', tone: 'warn', title: 'Docker is working on this stack' };
  if (wt.dockerError) return { text: 'failed', tone: 'bad', title: wt.dockerError };
  const total = wt.docker.length;
  if (total === 0) {
    // An empty list while docker is unreachable means "unknown", not "down".
    if (dockerUnavailable) return { text: 'unknown', tone: 'muted', title: `Docker is not answering: ${dockerUnavailable}` };
    return { text: wt.ports.length > 0 ? 'stopped' : '—', tone: 'muted', title: 'No containers' };
  }
  const up = wt.docker.filter((c) => c.state === 'running').length;
  const crashed = wt.docker.filter((c) => c.state === 'exited' && (c.exitCode ?? 0) !== 0).length;
  if (crashed > 0) return { text: `${crashed} crashed`, tone: 'bad', title: `${up}/${total} containers up` };
  if (up === total) return { text: `${up}/${total} up`, tone: 'ok', title: 'All containers are running' };
  if (up === 0) return { text: 'stopped', tone: 'muted', title: `${total} container${total === 1 ? '' : 's'}, none running` };
  return { text: `${up}/${total} up`, tone: 'warn', title: 'Some containers are not running' };
}

export function describe(wt: WorktreeItem, dockerUnavailable?: string): Described {
  const group = groupOf(wt);
  const agent = primaryAgent(wt);
  const prState = wt.pr?.state.toLowerCase();
  return {
    wt,
    group,
    name: nameOf(wt),
    agent,
    provider: agent?.provider,
    line: lineFor(wt, group, agent),
    attention: group === 'needs' ? attentionOf(wt) : undefined,
    diff: describeDiff(wt),
    base: describeBase(wt),
    stack: describeStack(wt, dockerUnavailable),
    // HTTP_PORT reads as "http", beside lowercase container names.
    ports: wt.ports.map((p) => ({ label: p.name.replace(/_PORT$/, '').toLowerCase(), port: p.port, openable: p.openable })),
    pr: wt.pr
      ? { number: wt.pr.number, state: prState === 'open' || prState === 'merged' ? prState : 'closed' }
      : undefined,
  };
}

export function describeAll(state: StackState): Described[] {
  return state.worktrees.map((wt) => describe(wt, state.dockerUnavailable));
}

export function countByGroup(items: Described[]): Record<WorktreeGroup, number> {
  const counts: Record<WorktreeGroup, number> = { needs: 0, review: 0, working: 0, idle: 0, missing: 0 };
  for (const d of items) counts[d.group] += 1;
  return counts;
}

/**
 * Worktrees waiting on a person — asking, or finished and unreviewed — oldest
 * first, so the one that has waited longest is at the top. Ties keep the
 * sidebar's own order.
 */
export function attentionQueue<T extends { wt: WorktreeItem; group: WorktreeGroup }>(items: T[]): T[] {
  return items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => item.group === 'needs' || item.group === 'review')
    .sort((a, b) => (a.item.wt.since ?? Number.MAX_SAFE_INTEGER) - (b.item.wt.since ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)
    .map(({ item }) => item);
}

/** The queue entry after `currentId` (wrapping), or the first when the current one is not in it. */
export function nextInQueue<T extends { wt: WorktreeItem }>(queue: T[], currentId: string | undefined): T | undefined {
  if (queue.length === 0) return undefined;
  const at = queue.findIndex((q) => q.wt.id === currentId);
  return queue[(at + 1) % queue.length];
}
