import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { StackState, SessionItem, WorktreeItem } from '../../src/webview/types';
import type { LayoutProps } from '../../src/webview/styles/types';
import { describeAll } from '../../src/webview/derive';

/**
 * Render smoke tests: each layout draws every kind of worktree without
 * throwing, and says the things a layout must say. The sidebar is excluded from
 * coverage (it is a view), but "does not crash on a missing worktree with no
 * sessions" is cheap to keep true, and the three layouts have to stay in step.
 */

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

const state: StackState = {
  defaultProvider: 'claude',
  installedProviders: ['claude'],
  dockerEnabled: true,
  worktrees: [
    wt({ id: 'main', branch: 'develop', isMain: true }),
    wt({
      id: 'ask', branch: 'fix/pay', alias: 'fix-payments', agent: 'permission',
      sessions: [session({ state: 'permission', attention: 'Bash: composer test' })],
      git: { ...clean, hasChanges: true, unstaged: 2, lines: { added: 12, removed: 3 }, base: { ref: 'origin/develop', ahead: 1, behind: 2 } },
      ports: [{ name: 'HTTP_PORT', port: 8082, openable: true }, { name: 'DEBUG_PORT', port: 9902, openable: false }],
      docker: [{ name: 'x-app-web-1', state: 'running', service: 'web' }, { name: 'db', state: 'exited', exitCode: 1 }],
    }),
    wt({
      id: 'rev', branch: 'feat/csv', agent: 'waiting', sessions: [session({ title: 'CSV export' }), session({ name: 'zsh', kind: 'shell', provider: undefined, index: 2, title: 'npm run dev' })],
      git: { ...clean, hasChanges: true, staged: 1 }, pr: { number: 41, state: 'OPEN' },
      dockerError: 'port is already allocated',
    }),
    wt({ id: 'work', branch: 'feat/work', agent: 'active', sessions: [session({ state: 'active', provider: 'codex' })], dockerBusy: 'starting' }),
    wt({ id: 'gone', branch: 'spike/old', missing: true }),
    wt({ id: 'bye', branch: 'feat/bye', deleting: true }),
  ],
};

function props(over: Partial<LayoutProps> = {}): LayoutProps {
  const s = over.state ?? state;
  return {
    state: s,
    loaded: true,
    items: describeAll(s),
    selectedId: 'ask',
    select: () => {},
    dragFor: () => ({
      props: { draggable: false, onDragEnter: () => {}, onDragOver: () => {}, onDrop: () => {}, onDragEnd: () => {} },
      dragging: false,
      over: false,
    }),
    now: 5 * 60_000,
    ...over,
  };
}

let layouts: Record<string, (p: LayoutProps) => React.ReactElement>;

beforeAll(async () => {
  // The webview talks to VS Code through this global, and reads the platform.
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: () => {}, getState: () => null, setState: () => {} }));
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  const [aside, claude, mission] = await Promise.all([
    import('../../src/webview/styles/aside/Aside'),
    import('../../src/webview/styles/claude/Claude'),
    import('../../src/webview/styles/mission/Mission'),
  ]);
  layouts = {
    aside: (p) => <aside.Aside {...p} />,
    claude: (p) => <claude.Claude {...p} />,
    mission: (p) => <mission.Mission {...p} />,
  };
});

describe.each(['aside', 'claude', 'mission'])('%s layout', (name) => {
  const render = (p: LayoutProps) => renderToStaticMarkup(layouts[name](p));

  it('draws every kind of worktree and the question the agent asked', () => {
    const html = render(props());
    expect(html).toContain('fix-payments');
    expect(html).toContain('feat/csv');
    expect(html).toContain('spike/old');
    expect(html).toContain('composer test');
    expect(html).toContain('Forget');
    expect(html).toContain('Review diff');
  });

  it('shows the selected worktree\'s ports, containers and PR somewhere', () => {
    const html = render(props({ selectedId: 'ask' }));
    expect(html).toContain(':8082');
    expect(html).toContain('Ports');
    const rev = render(props({ selectedId: 'rev' }));
    expect(rev).toContain('#41');
    expect(rev).toContain('port is already allocated');
  });

  it('offers a way to launch an agent, open a terminal and review for the selected worktree', () => {
    const html = render(props({ selectedId: 'work' }));
    expect(html).toMatch(/Launch|New claude session|not on your PATH/);
    expect(html).toMatch(/Terminal|Shell|Open terminal/);
    expect(html).toMatch(/Diff|Review diff/);
    // Unmeasured (no layout in SSR) everything fits, so every action is an
    // inline icon and there is no "⋯" — it only appears for what overflows.
    expect(html).toContain('Delete worktree');
    expect(html).not.toContain('More actions');
  });

  it('draws the loading and empty states', () => {
    expect(render(props({ loaded: false, state: { worktrees: [] }, items: [] }))).toContain('Loading worktrees');
    const empty = render(props({ state: { worktrees: [] }, items: [], selectedId: null }));
    expect(empty).toContain('No worktrees yet');
  });

  it('copes with a selection that no longer exists', () => {
    expect(() => render(props({ selectedId: 'vanished' }))).not.toThrow();
    expect(() => render(props({ selectedId: null }))).not.toThrow();
  });
});

describe('docker on the health strip', () => {
  it('says docker is down, with the reason, instead of counting containers', async () => {
    const { Claude } = await import('../../src/webview/styles/claude/Claude');
    const down: StackState = { ...state, dockerUnavailable: 'Cannot connect to the Docker daemon' };
    const html = renderToStaticMarkup(<Claude {...props({ state: down, items: describeAll(down) })} />);
    expect(html).toContain('docker down');
    expect(html).toContain('Cannot connect to the Docker daemon');
  });
});
