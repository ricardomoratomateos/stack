import { describe, it, expect } from 'vitest';
import { tmuxInstallCommand } from '../../src/onboarding/tmuxGate';

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
