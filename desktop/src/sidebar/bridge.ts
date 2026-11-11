/**
 * The seam between the extension's sidebar webview and the desktop app. The webview speaks to a
 * host through `acquireVsCodeApi().postMessage`; here the host is the app, so
 *
 *   - `toSidebarState` builds what `StackWebviewProvider` posts (`{type:'state', payload}`) from
 *     stackd's snapshot, and
 *   - `translate` turns each message the webview sends (`WebMessage`) into one `Action`: a stackd
 *     command, something the app does itself (select, ask a question), or a no-op.
 *
 * Pure: no DOM, no Tauri, so it is unit-tested.
 */
import type { ProviderId } from '@core/ports/IAgentProvider';
import { normalizeSidebarStyle, type SidebarStyle } from '@core/sidebarStyle';
import type { StackState, WebMessage, WorktreeItem } from '@core/webview/types';
import { planDelete } from '@core/application/deletePlan';
import type { Snapshot } from '../stackd/api';

/** The state message the extension posts to its webview. */
export function toSidebarState(
  snapshot: Snapshot | null,
  opts: { repoRoot?: string; activeWorktreeId?: string; sidebarStyle?: SidebarStyle },
): StackState | null {
  const repo = snapshot?.repos.find((r) => r.repoRoot === opts.repoRoot) ?? snapshot?.repos[0];
  if (!repo) return null;
  return {
    ...repo.state,
    activeWorktreeId: opts.activeWorktreeId ?? repo.state.activeWorktreeId,
    sidebarStyle: normalizeSidebarStyle(opts.sidebarStyle ?? repo.state.sidebarStyle),
  };
}

export interface Context {
  repoRoot: string;
  /** Every worktree of the sidebar, the control session included. */
  worktrees: WorktreeItem[];
}

export type Action =
  /** A stackd command; `select` also shows the worktree it names in the centre afterwards. */
  | { kind: 'command'; name: string; body: Record<string, unknown>; select?: string; selectNew?: string }
  /** Show a worktree (and one of its sessions) in the centre. */
  | { kind: 'select'; worktreeId: string; index?: number }
  /** Ask for a line of text, then run `then` with it as `{field: text}`. */
  | { kind: 'ask'; title: string; label: string; initial: string; confirm: string; then: { name: string; body: Record<string, unknown>; field: string } }
  /** The new-task form (a title becomes the branch). */
  | { kind: 'newTask' }
  /** Ask yes/no (or one of `choices`) before a command. */
  | { kind: 'confirm'; title: string; detail: string; choices: string[]; then: (choice: number) => { name: string; body: Record<string, unknown> } }
  /** Not available in the desktop app yet. */
  | { kind: 'unsupported'; what: string }
  | { kind: 'none' };

/** Messages stackd runs itself (`DAEMON_MESSAGES` in src/daemon/StackDaemon.ts). */
const DAEMON_MESSAGES = ['dockerUp', 'dockerDown', 'reorderSessions', 'reorderWorktrees', 'setupAction', 'refreshDrift', 'forgetWorktree'];

const label = (wt: WorktreeItem) => wt.alias ?? wt.branch;

export function translate(msg: WebMessage, ctx: Context): Action {
  const find = (id: string) => ctx.worktrees.find((w) => w.id === id);
  switch (msg.type) {
    case 'ready':
      return { kind: 'none' }; // the host answers it with the current state
    case 'selectWorktree':
    case 'focusTerminal':
      return { kind: 'select', worktreeId: msg.worktreeId };
    case 'focusSession':
      return { kind: 'select', worktreeId: msg.worktreeId, index: msg.index };
    case 'launchAgent':
      return { kind: 'command', name: 'spawnAgent', body: { worktreeId: msg.worktreeId, ...(msg.provider ? { provider: msg.provider } : {}) }, selectNew: msg.worktreeId };
    case 'openTerminal':
      return { kind: 'command', name: 'spawnShell', body: { worktreeId: msg.worktreeId }, selectNew: msg.worktreeId };
    case 'killSession':
      return { kind: 'command', name: 'killWindow', body: { worktreeId: msg.worktreeId, windowIndex: msg.index } };
    case 'renameSession': {
      const s = find(msg.worktreeId)?.sessions.find((x) => x.index === msg.index);
      return {
        kind: 'ask', title: 'Rename session', label: 'Name (empty restores the default)', confirm: 'Rename',
        initial: s?.alias ?? '',
        then: { name: 'renameSession', body: { worktreeId: msg.worktreeId, windowIndex: msg.index }, field: 'name' },
      };
    }
    case 'renameWorktree': {
      const wt = find(msg.worktreeId);
      return {
        kind: 'ask', title: 'Rename task', label: 'Name (empty restores the branch name)', confirm: 'Rename',
        initial: wt?.alias ?? '',
        then: { name: 'renameTask', body: { worktreeId: msg.worktreeId }, field: 'alias' },
      };
    }
    case 'deleteWorktree': {
      const wt = find(msg.worktreeId);
      if (!wt) return { kind: 'none' };
      const plan = planDelete(wt.git, wt.pr);
      return {
        kind: 'confirm', title: `Delete ${label(wt)}?`, detail: plan.detail, choices: plan.choices,
        then: (choice) => ({ name: 'deleteTask', body: { worktreeId: msg.worktreeId, deleteBranch: choice !== plan.keepBranch } }),
      };
    }
    case 'initWorktree':
      return { kind: 'command', name: 'initTask', body: { worktreeId: msg.worktreeId } };
    case 'openNewTask':
      return { kind: 'newTask' };
    case 'createWorktree':
      return {
        kind: 'command', name: 'createTask',
        body: { repo: ctx.repoRoot, branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch, provider: msg.provider },
      };
    case 'refreshDrift':
    case 'dockerUp':
    case 'dockerDown':
    case 'setupAction':
    case 'reorderSessions':
    case 'reorderWorktrees':
    case 'forgetWorktree':
      return DAEMON_MESSAGES.includes(msg.type) ? { kind: 'command', name: 'message', body: { message: msg, repo: ctx.repoRoot } } : { kind: 'none' };
    case 'openDiff':
      return { kind: 'unsupported', what: 'The review panel' };
    case 'openPr':
    case 'openTicket':
    case 'openPort':
      return { kind: 'unsupported', what: 'Opening links' };
    case 'pickDefaultProvider':
      return { kind: 'unsupported', what: 'Choosing the default agent' };
    case 'showProviderInstall':
      return { kind: 'unsupported', what: `Installing ${msg.provider as ProviderId}` };
    case 'listBranches':
      return { kind: 'none' };
  }
}

/** The native view header's live counts (`StackWebviewProvider.describe`). */
export function describeCounts(state: StackState): string {
  const parts: string[] = [];
  const active = state.worktrees.filter((w) => w.agent === 'active').length;
  const perm = state.worktrees.filter((w) => w.agent === 'permission').length;
  if (active > 0) parts.push(`${active} thinking`);
  if (perm > 0) parts.push(`${perm} needs you`);
  return parts.join(' · ');
}

// ── stack.sidebarStyle from the user's VS Code settings ─────────────────────

/** `settings.json` is JSONC: comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** `stack.sidebarStyle` from the contents of a VS Code `settings.json`; `aside` when absent or unreadable. */
export function sidebarStyleFromSettings(text: string | null | undefined): SidebarStyle {
  if (!text) return normalizeSidebarStyle(undefined);
  try {
    const json = parseJsonc(text) as Record<string, unknown> | null;
    return normalizeSidebarStyle(json?.['stack.sidebarStyle']);
  } catch {
    return normalizeSidebarStyle(undefined);
  }
}
