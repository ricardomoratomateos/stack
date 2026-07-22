import { execFile } from 'node:child_process';
import * as os from 'node:os';

/**
 * Native OS notification via macOS `osascript` — reaches the user even when
 * the VSCode window is unfocused or hidden, where in-window toasts don't.
 * No-op on other platforms. Uses execFile (no shell) so message content can't
 * inject commands; only AppleScript string escaping is needed.
 */
export class OsaNotifyAdapter {
  constructor(
    private platform: NodeJS.Platform = os.platform(),
    private run: (cmd: string, args: string[]) => void = (cmd, args) => {
      execFile(cmd, args, () => {});
    },
  ) {}

  notify(message: string, title = 'Unmess'): void {
    if (this.platform !== 'darwin') return;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    this.run('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
  }
}
