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
  const items = state.worktrees.map((wt) => describe(wt, state.dockerUnavailable));
  return {
    repoRoot: repo.repoRoot,
    repoName: baseName(repo.repoRoot),
    repos: snapshot.repos.map((r) => ({ repoRoot: r.repoRoot, name: baseName(r.repoRoot) })),
    items,
    control: state.controlSession ? describe(state.controlSession, state.dockerUnavailable) : undefined,
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
}

/** Every session of a worktree. `commands` maps window index to the pane's current command, when known. */
export function sessionRows(wt: WorktreeItem, commands: Record<number, string> = {}): SessionRow[] {
  return [...wt.sessions]
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      if (s.kind === 'agent') {
        const state = STATE_WORD[s.state];
        return { index: s.index, kind: 'agent', name: s.alias ?? s.provider ?? s.name, detail: s.title ? `${s.title}` : state, state: s.state };
      }
      return { index: s.index, kind: 'shell', name: s.alias ?? 'shell', detail: commands[s.index] ?? s.title ?? s.name, state: s.state };
    });
}

export const stateWord = (s: AgentState): string => STATE_WORD[s];

/** The session to show when a worktree is selected: the remembered one if it still exists, else the one asking, else the agent. */
export function pickSession(wt: WorktreeItem, remembered?: number): number | undefined {
  if (remembered !== undefined && wt.sessions.some((s) => s.index === remembered)) return remembered;
  return sessionToOpen(wt)?.index ?? wt.sessions[0]?.index;
}

/** The Manager's window: its agent, else the first window. */
export function managerSession(control: WorktreeItem | undefined): SessionItem | undefined {
  return control && (primaryAgent(control) ?? control.sessions[0]);
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
  | { kind: 'toggle-manager' };

export interface KeyLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}

/** ⌘1..9, ⌘⇧[ / ⌘⇧], ⌘⇧J, ⌘0, ⌘⇧M. Layout-independent (uses the physical key). */
export function shortcutOf(e: KeyLike): Shortcut | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (!e.shiftKey && digit) {
    const n = Number(digit[1]);
    return n === 0 ? { kind: 'focus-manager' } : { kind: 'worktree', n };
  }
  if (e.shiftKey) {
    if (e.code === 'BracketLeft') return { kind: 'prev' };
    if (e.code === 'BracketRight') return { kind: 'next' };
    if (e.code === 'KeyJ') return { kind: 'needs' };
    if (e.code === 'KeyM') return { kind: 'toggle-manager' };
  }
  return null;
}

export interface Effect {
  select?: string;
  focusManager?: true;
  toggleManager?: true;
}

/** What a shortcut does given the worktrees (in sidebar order) and the selected one. */
export function resolveShortcut(sc: Shortcut, items: Described[], selectedId: string | undefined): Effect {
  switch (sc.kind) {
    case 'focus-manager':
      return { focusManager: true };
    case 'toggle-manager':
      return { toggleManager: true };
    case 'worktree': {
      const d = items[sc.n - 1];
      return d ? { select: d.wt.id } : {};
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

export { nameOf };
