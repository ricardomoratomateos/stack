import * as path from 'node:path';

/**
 * The extension's id when it was called Foreman (`<publisher>.<name>`).
 *
 * VS Code keys an extension's storage on its id, so Foreman's files are in a
 * different directory from Stack's: `<globalStorage>/foreman.foreman/` beside
 * `<globalStorage>/ricardomoratomateos.stack/`.
 */
export const LEGACY_EXTENSION_ID = 'foreman.foreman';

/**
 * Foreman's globalStorage directory, worked out from Stack's own: the sibling
 * named after the old id. It holds the notify.sh that agents Foreman started
 * still run — they read their hooks once, at startup — and the `routes/` and
 * `hook-url` files that script looks its window up in. It may not exist.
 */
export function legacyStoragePath(storagePath: string): string {
  return path.join(path.dirname(storagePath), LEGACY_EXTENSION_ID);
}
