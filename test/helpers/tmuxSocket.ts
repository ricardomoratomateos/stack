import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where tmux puts the socket of `tmux -L <name>`. */
export function tmuxSocketPath(name: string): string {
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, name);
}

/**
 * Ends a test's own tmux server and removes its socket file: `kill-server`
 * leaves the file behind, and one is left in /tmp/tmux-<uid>/ per run.
 */
export function removeTmuxServer(name: string): void {
  try { execFileSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore' }); } catch { /* none started */ }
  fs.rmSync(tmuxSocketPath(name), { force: true });
}
