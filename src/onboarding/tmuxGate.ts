/** A package-manager command that installs tmux on the user's system. */
export interface TmuxInstall {
  manager: string;
  command: string;
}

/**
 * Pick the install command for tmux given the platform and which package
 * managers are present. Pure and synchronous so it can be exhaustively tested;
 * binary detection happens in the caller. Returns null when we can't confidently
 * suggest a command (no known manager, or an unsupported platform) — the caller
 * then falls back to the install guide rather than inventing a command that
 * might fail in a confusing way.
 */
export function tmuxInstallCommand(
  platform: NodeJS.Platform,
  has: (bin: string) => boolean,
): TmuxInstall | null {
  if (platform === 'darwin') {
    if (has('brew')) return { manager: 'Homebrew', command: 'brew install tmux' };
    return null;
  }
  if (platform === 'linux') {
    if (has('apt-get')) return { manager: 'apt', command: 'sudo apt-get install -y tmux' };
    if (has('dnf')) return { manager: 'dnf', command: 'sudo dnf install -y tmux' };
    if (has('pacman')) return { manager: 'pacman', command: 'sudo pacman -S --noconfirm tmux' };
    if (has('zypper')) return { manager: 'zypper', command: 'sudo zypper install -y tmux' };
    if (has('apk')) return { manager: 'apk', command: 'sudo apk add tmux' };
    return null;
  }
  return null;
}

/** Package managers worth probing for, in the order tmuxInstallCommand prefers them. */
export const PACKAGE_MANAGERS = ['brew', 'apt-get', 'dnf', 'pacman', 'zypper', 'apk'] as const;
