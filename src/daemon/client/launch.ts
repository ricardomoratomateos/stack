import * as os from 'node:os';
import * as path from 'node:path';

/** `~/.config/stack` (or STACKD_CONFIG_DIR): where the daemon keeps its state and its socket. */
export const daemonConfigDir = (): string => process.env.STACKD_CONFIG_DIR || path.join(os.homedir(), '.config', 'stack');
