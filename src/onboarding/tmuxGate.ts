import * as vscode from 'vscode';

/** A package-manager command that installs tmux on the user's system. */
export interface TmuxInstall {
  manager: string;
  command: string;
}

const GUIDE_URL = 'https://github.com/tmux/tmux/wiki/Installing';

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

/**
 * Actionable "you need tmux" prompt shown when the extension is gated off.
 *
 * We install in a visible VSCode terminal rather than shelling out silently:
 * most managers need sudo (an interactive password prompt the extension can't
 * drive), and the user should see exactly what runs. tmux is assumed available
 * from activation, so once it's installed the clean way to enable Unmess is a
 * window reload.
 */
export async function promptTmuxInstall(
  platform: NodeJS.Platform,
  has: (bin: string) => boolean,
): Promise<void> {
  const suggestion = tmuxInstallCommand(platform, has);

  if (!suggestion) {
    const pick = await vscode.window.showWarningMessage(
      'Unmess needs tmux to run agents, and it was not found on your system.',
      'Open install guide',
    );
    if (pick === 'Open install guide') {
      await vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    }
    return;
  }

  const pick = await vscode.window.showWarningMessage(
    `Unmess needs tmux to run agents. Install it with ${suggestion.manager}?`,
    'Install tmux',
    'Copy command',
  );

  if (pick === 'Copy command') {
    await vscode.env.clipboard.writeText(suggestion.command);
    return;
  }

  if (pick === 'Install tmux') {
    const term = vscode.window.createTerminal('Install tmux');
    term.show();
    term.sendText(suggestion.command);
    const done = await vscode.window.showInformationMessage(
      'When the install finishes, reload the window to enable Unmess.',
      'Reload window',
    );
    if (done === 'Reload window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}
