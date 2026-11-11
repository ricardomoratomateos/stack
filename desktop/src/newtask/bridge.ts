/**
 * The seam between the extension's new-task panel (`src/newtask/webview`) and the app, the
 * counterpart of what `NewTaskPanelManager` does in VS Code: it answers `ready` with `init`,
 * runs `create`, asks before discarding text, explains how to install an agent.
 * Pure, so it is unit-tested.
 */
import type { ProviderId } from '@core/ports/IAgentProvider';
import { normalizeSidebarStyle, type SidebarStyle } from '@core/sidebarStyle';
import type { NewTaskInit, NewTaskMessage } from '@core/newtask/types';

export type NewTaskAction =
  /** Send `init` (the panel just announced itself). */
  | { kind: 'init' }
  /** Run stackd's `createTask`; on success close the panel, on failure post `error` with the reason. */
  | { kind: 'create'; body: Record<string, unknown> }
  | { kind: 'close' }
  /** Ask "discard what you wrote?" and close on yes. */
  | { kind: 'confirmDiscard' }
  | { kind: 'install'; provider: ProviderId };

export function translateNewTask(msg: NewTaskMessage, ctx: { repoRoot: string }): NewTaskAction {
  switch (msg.type) {
    case 'ready':
      return { kind: 'init' };
    case 'create':
      return {
        kind: 'create',
        body: { repo: ctx.repoRoot, branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch, provider: msg.provider },
      };
    case 'cancel':
      return msg.dirty ? { kind: 'confirmDiscard' } : { kind: 'close' };
    case 'showProviderInstall':
      return { kind: 'install', provider: msg.provider };
  }
}

/** The panel's inputs: stackd's `newTaskInit` (branches, installed agents) with the app's own choices on top. */
export function toNewTaskInit(
  fromStackd: Partial<NewTaskInit> | null | undefined,
  prefs: { sidebarStyle?: SidebarStyle; defaultProvider?: ProviderId },
): NewTaskInit {
  return {
    branches: fromStackd?.branches ?? [],
    baseBranch: fromStackd?.baseBranch ?? 'main',
    sidebarStyle: normalizeSidebarStyle(prefs.sidebarStyle ?? fromStackd?.sidebarStyle),
    defaultProvider: prefs.defaultProvider ?? fromStackd?.defaultProvider ?? 'claude',
    installedProviders: fromStackd?.installedProviders ?? ['claude', 'codex', 'opencode'],
  };
}
