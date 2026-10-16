import type { ProviderId } from '../ports/IAgentProvider';
import type { SidebarStyle } from '../sidebarStyle';

/** Everything the panel needs to render, and re-sent whenever a setting changes. */
export interface NewTaskInit {
  /** Branch list for the "from" picker. */
  branches: string[];
  /** Preselected base. */
  baseBranch: string;
  /** `stack.sidebarStyle`: the panel wears the same accent as the sidebar. */
  sidebarStyle: SidebarStyle;
  /** Agent preselected in the picker (`stack.defaultProvider`). */
  defaultProvider: ProviderId;
  /** Agents whose command resolves on PATH; the rest are dimmed. */
  installedProviders: ProviderId[];
}

/** Panel → extension. */
export type NewTaskMessage =
  | { type: 'ready' }
  | { type: 'create'; branch: string; title?: string; description?: string; baseBranch?: string; provider?: ProviderId }
  /** `dirty`: the description holds text the user would lose by closing. */
  | { type: 'cancel'; dirty?: boolean }
  /** Explain how to install an agent whose command is not on PATH. */
  | { type: 'showProviderInstall'; provider: ProviderId };

/** Extension → panel. */
export type NewTaskExtMessage =
  | { type: 'init'; init: NewTaskInit }
  /** Creating failed; the panel stays open with the text intact and shows this. */
  | { type: 'error'; message: string };
