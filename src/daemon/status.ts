import * as fs from 'node:fs';
import type { KeyValueStore } from '../core/KeyValueStore';
import { WorktreeStore } from '../worktree/WorktreeStore';
import { worktreesInRepo } from '../worktree/worktreesInRepo';
import { ProviderFactory } from '../providers/ProviderFactory';
import { AgentSessionManager } from '../session/AgentSessionManager';
import type { ISessionManager } from '../ports/ISessionManager';
import type { ConfigSource } from '../providers/claude/ClaudeProvider';
import type { AgentSessionState } from '../types';
import type { SessionItem } from '../webview/types';

export interface StatusWorktree {
  id: string;
  branch: string;
  alias?: string;
  path: string;
  isMain: boolean;
  missing: boolean;
  agent: AgentSessionState;
  sessions: SessionItem[];
}

export interface StatusDeps {
  /** A snapshot of the extension's state; never written back anywhere. */
  store: KeyValueStore;
  config: ConfigSource;
  /** Where hook scripts would live; `status` never installs any, so it is only a name. */
  storagePath: string;
  tmux?: ISessionManager;
  exists?: (p: string) => boolean;
}

/**
 * The worktrees of one repo with their sessions and states, as the sidebar
 * would list them. Read-only: the session manager is headless, hooks are not
 * installed, no agent is started and the store is an in-memory snapshot.
 */
export async function collectStatus(repoRoot: string, deps: StatusDeps): Promise<StatusWorktree[]> {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const worktrees = worktreesInRepo(new WorktreeStore({ globalState: deps.store }).getAll(), repoRoot)
    .sort((a, b) => Number(b.isMain ?? false) - Number(a.isMain ?? false));
  const manager = new AgentSessionManager(
    new ProviderFactory(deps.config, deps.storagePath), deps.store, deps.tmux,
  );
  try {
    await manager.reconnect(worktrees);
    return worktrees.map((wt) => ({
      id: wt.id,
      branch: wt.branch,
      alias: wt.alias,
      path: wt.path,
      isMain: wt.isMain ?? false,
      missing: !exists(wt.path),
      agent: manager.getState(wt.id),
      sessions: manager.getSessions(wt.id),
    }));
  } finally {
    manager.dispose();
  }
}

export function formatStatus(repoRoot: string, items: StatusWorktree[]): string {
  if (items.length === 0) return `${repoRoot}: no worktrees tracked by Stack\n`;
  const lines = [`${repoRoot}: ${items.length} worktree${items.length === 1 ? '' : 's'}`];
  for (const wt of items) {
    const label = wt.alias ? `${wt.alias} (${wt.branch})` : wt.branch;
    const flags = [wt.isMain ? 'main' : '', wt.missing ? 'missing' : ''].filter(Boolean).join(', ');
    lines.push(`${label}${flags ? ` [${flags}]` : ''}  ${wt.agent}`);
    for (const s of wt.sessions) {
      const name = s.alias || s.title || s.name;
      const state = s.kind === 'agent' ? s.state : 'shell';
      lines.push(`  ${s.index}: ${name}  ${s.kind === 'agent' ? `${s.provider ?? 'agent'} ` : ''}${state}${s.attention ? `  "${s.attention}"` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}
