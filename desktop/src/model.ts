/**
 * What the Full layout shows, derived from stackd's snapshot. Pure: the
 * sidebar's own rules (groups, lines, attention queue) come from the
 * extension's derive.ts so both UIs agree on what "needs you" means.
 */
import type { AgentState, SessionItem, WorktreeItem } from '@core/webview/types';
import {
  attentionQueue, countByGroup, describe, nextInQueue, nameOf, primaryAgent, sessionToOpen,
  type Described, type WorktreeGroup,
} from '@core/webview/derive';
import { slugify } from '@core/newtask/composer';
import type { Snapshot } from './stackd/api';

export interface View {
  repoRoot: string;
  repoName: string;
  repos: { repoRoot: string; name: string }[];
  items: Described[];
  control?: Described;
  counts: Record<WorktreeGroup, number>;
}

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/** The view of one repo of the snapshot (the first when `repoRoot` is absent or unknown). */
export function buildView(snapshot: Snapshot | null, repoRoot?: string): View | null {
  const repo = snapshot?.repos.find((r) => r.repoRoot === repoRoot) ?? snapshot?.repos[0];
  if (!snapshot || !repo) return null;
  const { state } = repo;
  const items = state.worktrees.map((wt) => describe(wt));
  return {
    repoRoot: repo.repoRoot,
    repoName: baseName(repo.repoRoot),
    repos: snapshot.repos.map((r) => ({ repoRoot: r.repoRoot, name: baseName(r.repoRoot) })),
    items,
    control: state.controlSession ? describe(state.controlSession) : undefined,
    counts: countByGroup(items),
  };
}

const STATE_WORD: Record<AgentState, string> = {
  active: 'working',
  waiting: 'waiting',
  permission: 'needs you',
  idle: 'idle',
  terminated: 'ended',
};

export interface SessionRow {
  index: number;
  kind: 'agent' | 'shell';
  /** "claude", "codex", "shell". */
  name: string;
  /** Live title / state for an agent, the running command for a shell. */
  detail: string;
  state: AgentState;
  /** It has taken a turn: `waiting` reads as "your turn" (see describe's line). */
  turned?: boolean;
}

/** Every session of a worktree. `commands` maps window index to the pane's current command, when known. */
export function sessionRows(wt: WorktreeItem, commands: Record<number, string> = {}): SessionRow[] {
  return [...wt.sessions]
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      if (s.kind === 'agent') {
        const state = stateWord(s.state, s.turned);
        return { index: s.index, kind: 'agent', name: s.alias ?? s.provider ?? s.name, detail: s.title ? `${s.title}` : state, state: s.state, ...(s.turned ? { turned: true } : {}) };
      }
      return { index: s.index, kind: 'shell', name: s.alias ?? 'shell', detail: commands[s.index] ?? s.title ?? s.name, state: s.state };
    });
}

/** A session's state in words; a `waiting` agent that has taken a turn is waiting on you: "your turn". */
export const stateWord = (s: AgentState, turned?: boolean): string => (s === 'waiting' && turned ? 'your turn' : STATE_WORD[s]);

/** The session to show when a worktree is selected: the remembered one if it still exists, else the one asking, else the agent. */
export function pickSession(wt: WorktreeItem, remembered?: number): number | undefined {
  if (remembered !== undefined && wt.sessions.some((s) => s.index === remembered)) return remembered;
  return sessionToOpen(wt)?.index ?? wt.sessions[0]?.index;
}

/**
 * The session "Send to agent" in the review delivers to: the live agent the daemon picks
 * (AgentSessionManager.sendPromptToAgent) — one waiting or idle first, then one asking, then any.
 */
export function liveAgentIndex(wt: WorktreeItem): number | undefined {
  const rank = (s: AgentState) => (s === 'waiting' || s === 'idle' ? 0 : s === 'permission' ? 1 : 2);
  return wt.sessions
    .filter((s) => s.kind === 'agent' && s.state !== 'terminated')
    .sort((a, b) => rank(a.state) - rank(b.state))[0]?.index;
}

/** The Manager's window: its agent, else the first window. */
export function managerSession(control: WorktreeItem | undefined): SessionItem | undefined {
  return control && (primaryAgent(control) ?? control.sessions[0]);
}

/** The Manager window to show: the remembered tab if it still exists, else the Manager's agent. */
export function managerIndex(control: WorktreeItem | undefined, remembered?: number): number | undefined {
  if (control && remembered !== undefined && control.sessions.some((s) => s.index === remembered)) return remembered;
  return managerSession(control)?.index;
}

/** Branch name and prompt for a task typed in the composer. */
export function taskFromText(text: string, repoRoot: string): { repo: string; branch: string; title: string; description: string } | null {
  const title = text.trim();
  const branch = slugify(title);
  if (!branch) return null;
  return { repo: repoRoot, branch, title, description: title };
}

// ── shortcuts ───────────────────────────────────────────────────────────────

export type Shortcut =
  | { kind: 'worktree'; n: number }
  | { kind: 'prev' }
  | { kind: 'next' }
  | { kind: 'needs' }
  | { kind: 'focus-manager' }
  | { kind: 'tab-prev' }
  | { kind: 'tab-next' }
  | { kind: 'toggle-manager' }
  | { kind: 'cycle-mode' }
  | { kind: 'maximize' };

export interface KeyLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
  key?: string;
}

function bracketOf(e: KeyLike): 'prev' | 'next' | null {
  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') return 'prev';
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') return 'next';
  return null;
}

/** ⌘1..9, ⌘⇧[ / ⌘⇧], ⌘⇧J, ⌘0, ⌘⇧M, ⌘⇧F, ⌘⇧Enter. Digits and letters use the physical key; the brackets match the
 * physical key OR the produced character ('[' ']' '{' '}'), since on some layouts (Spanish) they need ⌥ and
 * the key code is not what the user presses. The layout-proof next/previous are the menu's ⌥⌘↓ / ⌥⌘↑. */
export function shortcutOf(e: KeyLike): Shortcut | null {
  if (!e.metaKey || e.ctrlKey) return null;
  const bracket = e.shiftKey ? bracketOf(e) : null;
  if (bracket) return { kind: bracket };
  if (e.altKey) {
    if (e.shiftKey) return null;
    if (e.code === 'ArrowLeft') return { kind: 'tab-prev' };
    if (e.code === 'ArrowRight') return { kind: 'tab-next' };
    return null;
  }
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (!e.shiftKey && digit) {
    const n = Number(digit[1]);
    return n === 0 ? { kind: 'focus-manager' } : { kind: 'worktree', n };
  }
  if (e.shiftKey) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') return { kind: 'maximize' };
    if (e.code === 'KeyJ') return { kind: 'needs' };
    if (e.code === 'KeyM') return { kind: 'toggle-manager' };
    if (e.code === 'KeyF') return { kind: 'cycle-mode' };
  }
  return null;
}

export type Pane = 'centre' | 'manager';

export interface Effect {
  select?: string;
  /** Focus the centre terminal (after selecting a worktree that is already selected, from the Manager). */
  focusCentre?: true;
  /** Move to the previous/next session tab of a pane, wrapping, and focus its terminal. */
  tab?: { pane: Pane; dir: 1 | -1 };
  focusManager?: true;
  toggleManager?: true;
  cycleMode?: true;
  maximize?: true;
}

/** What a shortcut does given the worktrees (in sidebar order) and the selected one. */
export function resolveShortcut(sc: Shortcut, items: Described[], selectedId: string | undefined, focus: Pane = 'centre'): Effect {
  switch (sc.kind) {
    case 'focus-manager':
      // ⌘0 again while the Manager is focused advances its tab.
      return focus === 'manager' ? { tab: { pane: 'manager', dir: 1 } } : { focusManager: true };
    case 'tab-prev':
    case 'tab-next':
      return { tab: { pane: focus, dir: sc.kind === 'tab-next' ? 1 : -1 } };
    case 'toggle-manager':
      return { toggleManager: true };
    case 'cycle-mode':
      return { cycleMode: true };
    case 'maximize':
      return { maximize: true };
    case 'worktree': {
      const d = items[sc.n - 1];
      if (!d) return {};
      // ⌘N again on the selected worktree (centre focused) advances to its next session tab.
      if (d.wt.id === selectedId) return focus === 'centre' ? { tab: { pane: 'centre', dir: 1 } } : { select: d.wt.id, focusCentre: true };
      return { select: d.wt.id };
    }
    case 'prev':
    case 'next': {
      if (items.length === 0) return {};
      const at = items.findIndex((d) => d.wt.id === selectedId);
      const step = sc.kind === 'next' ? 1 : -1;
      const to = at < 0 ? (step === 1 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
      return { select: items[to].wt.id };
    }
    case 'needs': {
      const next = nextInQueue(attentionQueue(items), selectedId);
      return next ? { select: next.wt.id } : {};
    }
  }
}

/** The session index one tab away from `current` (wrapping), among the window's sessions in tab order. */
export function stepSessionIndex(wt: WorktreeItem | undefined, current: number | undefined, dir: 1 | -1): number | undefined {
  const idx = [...(wt?.sessions ?? [])].map((s) => s.index).sort((a, b) => a - b);
  if (idx.length === 0) return undefined;
  const at = current === undefined ? -1 : idx.indexOf(current);
  if (at < 0) return idx[dir === 1 ? 0 : idx.length - 1];
  return idx[stepWrap(at, idx.length, dir)];
}

/** One line of the Float list: a worktree, its sessions, and the session asking for permission (if any). */
export interface FloatRow {
  id: string;
  name: string;
  group: Described['group'];
  sessions: SessionRow[];
  /**
   * The session that needs you; the row shows what it asks (`label`) and an Allow button for it.
   * `attention` is the request as stackd has it, sent back with Allow so a newer one is not allowed blind.
   */
  asking?: { index: number; label: string; attention?: string };
}

export function floatRows(items: Described[]): FloatRow[] {
  return items.map((d) => {
    const ask = d.wt.sessions.find((s) => s.kind === 'agent' && s.state === 'permission');
    return {
      id: d.wt.id,
      name: d.name,
      group: d.group,
      sessions: sessionRows(d.wt),
      asking: ask ? { index: ask.index, label: ask.attention ?? 'needs you', attention: ask.attention } : undefined,
    };
  });
}

export const MANAGER_ID = 'manager';

/** Most-recently-selected first: `id` moves to the front. */
export function mruTouch(history: string[], id: string, cap = 50): string[] {
  return [id, ...history.filter((h) => h !== id)].slice(0, cap);
}

/** `ids` ordered by recency; the ones never selected follow in their own order. */
export function mruOrder(ids: string[], history: string[]): string[] {
  const known = new Set(ids);
  const seen = new Set<string>();
  const first = history.filter((h) => known.has(h) && !seen.has(h) && seen.add(h));
  return [...first, ...ids.filter((i) => !seen.has(i))];
}

/** Move `from` by one step, wrapping. */
export function stepWrap(from: number, count: number, dir: 1 | -1): number {
  return count <= 0 ? 0 : (from + dir + count) % count;
}

export interface SwitcherRow {
  id: string;
  name: string;
  state: AgentState;
  line: string;
  /** ⌘N hint, "⌘0" for the Manager. */
  hint: string;
}

/** The rows of the ⌃Tab switcher: the repo's worktrees and the Manager, in MRU order. */
export function switcherRows(items: Described[], control: Described | undefined, history: string[]): SwitcherRow[] {
  const byId = new Map<string, SwitcherRow>();
  const row = (d: Described, id: string, hint: string): SwitcherRow => ({
    id, name: d.name, state: d.agent?.state ?? d.wt.agent, line: d.line, hint,
  });
  items.forEach((d, i) => byId.set(d.wt.id, row(d, d.wt.id, i < 9 ? `⌘${i + 1}` : '')));
  if (control) byId.set(MANAGER_ID, { ...row(control, MANAGER_ID, '⌘0'), name: control.name || 'Manager' });
  return mruOrder([...byId.keys()], history).map((id) => byId.get(id)!);
}

export { nameOf };
