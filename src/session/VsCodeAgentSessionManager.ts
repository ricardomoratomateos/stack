import type * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AgentSessionManager } from './AgentSessionManager';
import { SessionTerminals } from './SessionTerminals';
import type { SessionTabsMode } from './terminalHost';
import { TmuxManager } from './TmuxManager';
import type { ISessionManager } from '../ports/ISessionManager';
import type { ProviderFactory } from '../providers/ProviderFactory';
import type { KeyValueStore } from '../core/KeyValueStore';

/**
 * The session model hosted in VS Code: AgentSessionManager plus the
 * SessionTerminals that put its tmux windows on screen as VS Code terminals.
 */
export class VsCodeAgentSessionManager extends AgentSessionManager<vscode.Terminal> {
  constructor(
    providers: ProviderFactory,
    store: KeyValueStore,
    tmux: ISessionManager = new TmuxManager(),
    pathExists: (p: string) => boolean = (p) => fs.existsSync(p),
    hostname: string = os.hostname(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    sessionTabs: () => SessionTabsMode = () => 'single',
    promptPrefix: () => string = () => '',
  ) {
    super(providers, store, tmux, pathExists, hostname, sleep, sessionTabs, promptPrefix, new SessionTerminals(tmux, pathExists));
  }
}
