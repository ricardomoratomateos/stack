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
import { PROVIDER_IDS, PROVIDER_INSTALL, type ProviderId } from '@core/ports/IAgentProvider';
import type { StackState, WebMessage, WorktreeItem } from '@core/webview/types';
import { planDelete } from '@core/application/deletePlan';
import type { Snapshot } from '../stackd/api';

/** The state message the extension posts to its webview. */
export function toSidebarState(
  snapshot: Snapshot | null,
  opts: { repoRoot?: string; activeWorktreeId?: string; defaultProvider?: ProviderId },
): StackState | null {
  const repo = snapshot?.repos.find((r) => r.repoRoot === opts.repoRoot) ?? snapshot?.repos[0];
  if (!repo) return null;
  return {
    ...repo.state,
    host: 'desktop',
    activeWorktreeId: opts.activeWorktreeId ?? repo.state.activeWorktreeId,
    ...(opts.defaultProvider ? { defaultProvider: opts.defaultProvider } : {}),
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
  /** Open a link in the default browser. */
  | { kind: 'open'; url: string }
  /** Choose the agent the main button launches. */
  | { kind: 'pickProvider'; choices: ProviderId[] }
  /** Explain how to install an agent that is not on PATH (`installHint`). */
  | { kind: 'install'; provider: ProviderId }
  /** The PR-style review of a worktree's changes, in the centre. */
  | { kind: 'review'; worktreeId: string }
  /** Not available in the desktop app yet. */
  | { kind: 'unsupported'; what: string }
  | { kind: 'none' };

/** Messages stackd runs itself (`DAEMON_MESSAGES` in src/daemon/StackDaemon.ts). */
const DAEMON_MESSAGES = ['reorderSessions', 'reorderWorktrees', 'setupAction', 'refreshDrift', 'forgetWorktree'];

/** What may be handed to the browser: https links (PR, ticket) and localhost ports. */
export function safeUrl(url: string | undefined): string | undefined {
  return url && /^https:\/\/[^\s]+$/.test(url) ? url : undefined;
}

/** The text of the "X is not on your PATH" dialog, as in `WorktreeApplicationService.showProviderInstall`. */
export function installHint(provider: ProviderId): { title: string; detail: string; command: string } {
  const { label, install } = PROVIDER_INSTALL[provider];
  return { title: `${label} is not on your PATH`, detail: `Install it with:\n\n${install}`, command: install };
}

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
    case 'resumeAgent':
      return { kind: 'command', name: 'resumeAgent', body: { worktreeId: msg.worktreeId }, selectNew: msg.worktreeId };
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
    case 'setupAction':
    case 'reorderSessions':
    case 'reorderWorktrees':
    case 'forgetWorktree':
      return DAEMON_MESSAGES.includes(msg.type) ? { kind: 'command', name: 'message', body: { message: msg, repo: ctx.repoRoot } } : { kind: 'none' };
    case 'openDiff':
      return find(msg.worktreeId) ? { kind: 'review', worktreeId: msg.worktreeId } : { kind: 'none' };
    case 'openPr':
    case 'openTicket': {
      const wt = find(msg.worktreeId);
      const url = safeUrl(msg.type === 'openPr' ? wt?.pr?.url : wt?.ticket?.url);
      return url ? { kind: 'open', url } : { kind: 'none' };
    }
    case 'openPort':
      return Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536 ? { kind: 'open', url: `http://localhost:${msg.port}` } : { kind: 'none' };
    case 'pickDefaultProvider':
      return { kind: 'pickProvider', choices: [...PROVIDER_IDS] };
    case 'showProviderInstall':
      return { kind: 'install', provider: msg.provider };
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
