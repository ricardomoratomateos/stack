import * as fs from 'node:fs';
import * as path from 'node:path';
import { JsonHookInstaller } from './shared/JsonHookInstaller';

/** Where versions with Codex support registered Stack's hooks, relative to the home dir. */
export const LEGACY_CODEX_HOOKS_PATH = '.codex/hooks.json';

/** The events those versions registered (Codex had no SessionEnd). */
const LEGACY_CODEX_EVENTS = ['SessionStart', 'Stop', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'];

/**
 * Codex support is gone, but earlier versions put Stack's notify hook into
 * `<home>/.codex/hooks.json`, where it would keep firing at a script nobody
 * listens to. Takes out Stack's own entries only — other tools' hooks and the
 * rest of the file stay as they are, and a file with nothing of Stack's in it
 * is not rewritten. No file, nothing to do. Never throws: a file it cannot
 * edit safely is reported through the returned message and left untouched.
 *
 * Returns undefined when it did its job (or had nothing to do), else why not.
 */
export function removeLegacyCodexHooks(storagePath: string, homeDir: string): string | undefined {
  const file = path.join(homeDir, LEGACY_CODEX_HOOKS_PATH);
  if (!fs.existsSync(file)) return undefined;
  try {
    new JsonHookInstaller(storagePath, file, LEGACY_CODEX_EVENTS, 'codex').uninstall();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
