import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent config file Stack was about to edit but must not touch.
 *
 * Thrown instead of "starting fresh": the file is the user's, holding their
 * permissions, env, model and other tools' hooks, and rewriting it with only
 * our entries because it failed to parse is silent data loss. The message is
 * written for a notification — callers show it as is.
 */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

/** `~/.claude/settings.json` rather than the absolute path, as the user knows it. */
export function displayPath(file: string, home: string = os.homedir()): string {
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/**
 * Where in `text` a JSON.parse error points, as "line L, column C".
 *
 * Node 20's messages only carry the character offset ("at position 41") and
 * newer ones append their own line/column; the offset is in both, so it is the
 * one parsed. Undefined when the message has neither.
 */
export function syntaxErrorLocation(text: string, err: unknown): string | undefined {
  const match = /position (\d+)/.exec(err instanceof Error ? err.message : String(err));
  if (!match) return undefined;
  const offset = Math.min(Number(match[1]), text.length);
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `line ${line}, column ${column}`;
}

/**
 * Reads a JSON object config file.
 *
 * Missing or blank → `{}` (nothing to lose). Anything else that is not a JSON
 * object throws ConfigFileError, phrased after `action` ("install hooks").
 */
export function readJsonObject(file: string, action: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const where = syntaxErrorLocation(text, e);
    throw new ConfigFileError(
      `Stack couldn't ${action}: ${displayPath(file)} has a syntax error${where ? ` at ${where}` : ''}. ` +
      'The file was left untouched — fix it and reload the window.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileError(
      `Stack couldn't ${action}: ${displayPath(file)} is not a JSON object. The file was left untouched.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Replaces `file` with `content` so that no reader — the agent loading its
 * settings, or a crash halfway — ever sees a truncated file.
 *
 * - Written to a sibling temp file and renamed over the target, which is atomic
 *   on the same filesystem.
 * - A symlinked config (dotfiles repos do this to ~/.claude/settings.json) is
 *   followed and its target replaced; renaming over the link itself would
 *   silently turn it into a regular file and detach it from the repo.
 * - The existing file's mode is kept: settings can hold tokens, and a 0600
 *   file must not come back world-readable.
 * - The first time Stack changes a file that already existed, the original is
 *   kept as `<file>.stack-backup`. Never overwritten afterwards, so it stays
 *   the user's own version from before Stack ever touched it.
 */
export function writeFileAtomic(file: string, content: string, opts: { backup?: boolean } = {}): void {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* does not exist yet */ }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  let mode: number | undefined;
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') === content) return;
    // A rename only needs the DIRECTORY to be writable, so it would sail past a
    // file the user made read-only on purpose. Honour that explicitly.
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new ConfigFileError(`Stack couldn't update ${displayPath(file)}: the file is read-only. It was left untouched.`);
    }
    mode = fs.statSync(target).mode & 0o777;
    const backup = `${target}.stack-backup`;
    if (opts.backup && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
  }

  const tmp = path.join(dir, `.${path.basename(target)}.stack-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    // writeFileSync's mode is masked by the umask; chmod states it exactly.
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}
