import type { SessionItem, StackState, WorktreeItem } from '@core/webview/types';

/** A fixed sample state (the extension's layout tests use the same one), for comparing the sidebar with VS Code's. */

const session = (over: Partial<SessionItem>): SessionItem =>
  ({ name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 1, ...over });

const clean = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };

function wt(over: Partial<WorktreeItem>): WorktreeItem {
  return {
    id: 'a', branch: 'feat/a', path: '/r/a', isMain: false, deleting: false, agent: 'idle',
    agentCount: 0, terminalCount: 0, sessions: [], ports: [], docker: [], git: clean, pr: null,
    since: 0, ...over,
  };
}

export function sampleState(now = Date.now()): StackState {
  const ago = (min: number) => now - min * 60_000;
  return {
    defaultProvider: 'claude',
    installedProviders: ['claude', 'codex'],
    dockerEnabled: true,
    activeWorktreeId: 'ask',
    controlSession: wt({ id: 'control', branch: 'manager', isControl: true, agent: 'waiting', sessions: [session({ title: 'Manager' })], since: ago(30) }),
    worktrees: [
      wt({ id: 'main', branch: 'develop', isMain: true, since: ago(600) }),
      wt({
        id: 'ask', branch: 'fix/pay', alias: 'fix-payments', agent: 'permission', since: ago(2),
        sessions: [session({ state: 'permission', attention: 'Bash: composer test' })],
        git: { ...clean, hasChanges: true, unstaged: 2, upstream: true, lines: { added: 12, removed: 3 }, base: { ref: 'origin/develop', ahead: 1, behind: 2 } },
        ports: [{ name: 'HTTP_PORT', port: 8082, openable: true }, { name: 'DEBUG_PORT', port: 9902, openable: false }],
        docker: [{ name: 'x-app-web-1', state: 'running', service: 'web' }, { name: 'db', state: 'exited', exitCode: 1 }],
      }),
      wt({
        id: 'rev', branch: 'feat/csv', agent: 'waiting', since: ago(14),
        sessions: [session({ title: 'CSV export' }), session({ name: 'zsh', kind: 'shell', provider: undefined, index: 2, title: 'npm run dev' })],
        git: { ...clean, hasChanges: true, staged: 1 }, pr: { number: 41, state: 'OPEN', ci: 'pass' },
        review: { summary: 'CSV export is ready', at: ago(14) },
        dockerError: 'port is already allocated',
      }),
      wt({ id: 'work', branch: 'feat/work', agent: 'active', since: ago(5), sessions: [session({ state: 'active', provider: 'codex', title: 'Refactoring the importer' })], dockerBusy: 'starting' }),
      wt({ id: 'gone', branch: 'spike/old', missing: true, since: ago(3000) }),
      wt({ id: 'bye', branch: 'feat/bye', deleting: true }),
    ],
  };
}
