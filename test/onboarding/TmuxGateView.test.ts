import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, env, commands } from '../__mocks__/vscode';
import { TmuxGateView } from '../../src/onboarding/TmuxGateView';
import type { TmuxInstall } from '../../src/onboarding/tmuxGate';

const brew: TmuxInstall = { manager: 'Homebrew', command: 'brew install tmux' };

function makeView() {
  let handler: ((m: { type: string }) => void) | undefined;
  const view = {
    webview: {
      options: {} as Record<string, unknown>,
      html: '',
      onDidReceiveMessage: (h: (m: { type: string }) => void) => { handler = h; return { dispose() {} }; },
    },
  };
  return { view, fire: (type: string) => handler?.({ type }) as unknown as Promise<void> | void };
}

function resolve(install: TmuxInstall | null) {
  const { view, fire } = makeView();
  new TmuxGateView(install).resolveWebviewView(view as never);
  return { view, fire };
}

beforeEach(() => {
  window.createTerminal.mockClear();
  env.clipboard.writeText.mockClear();
  env.openExternal.mockClear();
  commands.executeCommand.mockClear();
});

describe('TmuxGateView', () => {
  it('states the requirement and offers the detected manager', () => {
    const { view } = resolve(brew);
    expect(view.webview.html).toContain('Foreman needs tmux');
    expect(view.webview.html).toContain('brew install tmux');
    expect(view.webview.html).toContain('Install with Homebrew');
  });

  it('runs scripts but grants the view no local resource roots', () => {
    const { view } = resolve(brew);
    expect(view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
  });

  it('points at the official guide when no package manager was found', () => {
    // Inventing a command that might fail confusingly is worse than a link.
    const { view } = resolve(null);
    expect(view.webview.html).toContain('No supported package manager');
    expect(view.webview.html).toContain('Open install guide');
    expect(view.webview.html).not.toContain('data-action="install"');
  });

  it('escapes the install command instead of pasting it into the markup', () => {
    const { view } = resolve({ manager: 'a&b', command: 'sh -c "<script>"' });
    expect(view.webview.html).toContain('sh -c &quot;&lt;script&gt;&quot;');
    expect(view.webview.html).toContain('a&amp;b');
    expect(view.webview.html).not.toContain('<script>"');
  });

  it('install runs the command in a visible terminal', () => {
    const { fire } = resolve(brew);
    fire('install');
    expect(window.createTerminal).toHaveBeenCalledWith('Install tmux');
    const term = window.terminals[window.terminals.length - 1];
    expect(term.show).toHaveBeenCalled();
    expect(term.sendText).toHaveBeenCalledWith('brew install tmux');
  });

  it('copy puts the command on the clipboard', async () => {
    const { fire } = resolve(brew);
    await fire('copy');
    expect(env.clipboard.writeText).toHaveBeenCalledWith('brew install tmux');
  });

  it('install and copy do nothing without a detected manager', async () => {
    const { fire } = resolve(null);
    await fire('install');
    await fire('copy');
    expect(window.createTerminal).not.toHaveBeenCalled();
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('reload reloads the window, which is what re-enters activation', async () => {
    const { fire } = resolve(brew);
    await fire('reload');
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('guide opens the tmux install wiki', async () => {
    const { fire } = resolve(null);
    await fire('guide');
    expect(env.openExternal).toHaveBeenCalled();
    expect(String(env.openExternal.mock.calls[0][0].path)).toContain('tmux/tmux/wiki/Installing');
  });

  it('ignores a message it does not know', async () => {
    const { fire } = resolve(brew);
    await fire('nonsense');
    expect(window.createTerminal).not.toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});
