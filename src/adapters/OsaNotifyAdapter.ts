import { execFile } from 'node:child_process';
import * as os from 'node:os';

/** The chime that comes with a notification. */
export const NOTIFY_SOUND = '/System/Library/Sounds/Glass.aiff';

/**
 * Native OS notification via macOS `osascript` — reaches the user even when
 * the VSCode window is unfocused or hidden, where in-window toasts don't —
 * with the Glass chime played alongside, so the sound and the banner are one
 * decision: a chime the banner would not have earned is noise.
 * No-op on other platforms. Uses execFile (no shell) so message content can't
 * inject commands; only AppleScript string escaping is needed.
 */
export class OsaNotifyAdapter {
  constructor(
    private platform: NodeJS.Platform = os.platform(),
    private run: (cmd: string, args: string[]) => void = (cmd, args) => {
      execFile(cmd, args, () => {});
    },
    /** Sound file played with each notification; null for silence. */
    private sound: string | null = NOTIFY_SOUND,
  ) {}

  notify(message: string, title = 'Stack'): void {
    if (this.platform !== 'darwin') return;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    this.run('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
    // afplay, the chime Stack has always played: the notification's own
    // `sound name` would follow the settings macOS keeps for Script Editor,
    // where osascript's banners are filed — not something anyone looks at.
    if (this.sound) this.run('afplay', [this.sound]);
  }
}
