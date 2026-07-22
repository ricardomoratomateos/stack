import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, commands, env, resetVscodeMock } from '../__mocks__/vscode';
import { tmuxInstallCommand, promptTmuxInstall } from '../../src/onboarding/tmuxGate';

// A `has()` predicate backed by a fixed set of present binaries.
const withBins = (...bins: string[]) => (bin: string) => bins.includes(bin);

describe('tmuxInstallCommand', () => {
  it('suggests Homebrew on macOS when brew is present', () => {
    expect(tmuxInstallCommand('darwin', withBins('brew'))).toEqual({
      manager: 'Homebrew',
      command: 'brew install tmux',
    });
  });

  it('returns null on macOS without brew', () => {
    expect(tmuxInstallCommand('darwin', withBins())).toBeNull();
  });

  it.each([
    ['apt-get', 'apt', 'sudo apt-get install -y tmux'],
    ['dnf', 'dnf', 'sudo dnf install -y tmux'],
    ['pacman', 'pacman', 'sudo pacman -S --noconfirm tmux'],
    ['zypper', 'zypper', 'sudo zypper install -y tmux'],
    ['apk', 'apk', 'sudo apk add tmux'],
  ])('suggests %s manager on Linux', (bin, manager, command) => {
    expect(tmuxInstallCommand('linux', withBins(bin))).toEqual({ manager, command });
  });

  it('prefers apt-get over other Linux managers when several are present', () => {
    expect(tmuxInstallCommand('linux', withBins('apt-get', 'dnf', 'pacman'))?.manager).toBe('apt');
  });

  it('returns null on Linux with no known manager', () => {
    expect(tmuxInstallCommand('linux', withBins())).toBeNull();
  });

  it('returns null on unsupported platforms', () => {
    expect(tmuxInstallCommand('win32', withBins('brew', 'apt-get'))).toBeNull();
  });
});

describe('promptTmuxInstall', () => {
  beforeEach(() => resetVscodeMock());

  describe('when no install command can be suggested', () => {
    it('opens the install guide when the user asks for it', async () => {
      window.showWarningMessage.mockResolvedValueOnce('Open install guide');
      await promptTmuxInstall('win32', withBins());

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
        'Open install guide',
      );
      expect(env.openExternal).toHaveBeenCalledOnce();
      expect(env.openExternal.mock.calls[0][0].toString()).toContain('tmux/tmux');
    });

    it('does nothing when the user dismisses the guide prompt', async () => {
      window.showWarningMessage.mockResolvedValueOnce(undefined);
      await promptTmuxInstall('win32', withBins());
      expect(env.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('when an install command is available', () => {
    it('copies the command to the clipboard on "Copy command"', async () => {
      window.showWarningMessage.mockResolvedValueOnce('Copy command');
      await promptTmuxInstall('darwin', withBins('brew'));

      expect(env.clipboard.writeText).toHaveBeenCalledWith('brew install tmux');
      expect(window.createTerminal).not.toHaveBeenCalled();
    });

    it('runs the command in a terminal and reloads on "Install tmux" → "Reload window"', async () => {
      window.showWarningMessage.mockResolvedValueOnce('Install tmux');
      window.showInformationMessage.mockResolvedValueOnce('Reload window');
      await promptTmuxInstall('darwin', withBins('brew'));

      expect(window.createTerminal).toHaveBeenCalledWith('Install tmux');
      const term = window.terminals[0];
      expect(term.show).toHaveBeenCalled();
      expect(term.sendText).toHaveBeenCalledWith('brew install tmux');
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    });

    it('runs the command but does not reload when the reload prompt is dismissed', async () => {
      window.showWarningMessage.mockResolvedValueOnce('Install tmux');
      window.showInformationMessage.mockResolvedValueOnce(undefined);
      await promptTmuxInstall('darwin', withBins('brew'));

      expect(window.createTerminal).toHaveBeenCalledOnce();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('does nothing when the warning is dismissed', async () => {
      window.showWarningMessage.mockResolvedValueOnce(undefined);
      await promptTmuxInstall('darwin', withBins('brew'));

      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.createTerminal).not.toHaveBeenCalled();
    });
  });
});
