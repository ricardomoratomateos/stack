import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The friendly half of the manager: a skill that tells Claude when the Stack
 * tools apply, and three slash commands, so nobody has to type "use
 * stack_status". Shipped as markdown in resources/claude/, copied into the
 * user's ~/.claude with the MCP server and removed with it.
 *
 * Every file carries MARKER. Stack only ever overwrites or deletes a file that
 * has it — a `/stack` command the user wrote themselves is left alone, and
 * simply wins.
 */

export const MARKER = '<!-- Installed by Stack (VS Code). Removed when "Stack tools in Claude Code" is switched off. -->';

/**
 * The files, relative to both resources/claude/ in the extension and ~/.claude.
 * They live in the repo as plain markdown (resources/claude/…) so they can be
 * read and edited like any skill; this list is what Stack owns.
 */
export const ASSET_FILES = [
  'skills/stack-manager/SKILL.md',
  'commands/stack.md',
  'commands/stack-task.md',
  'commands/stack-next.md',
] as const;

/** The shipped files' contents, read from `sourceDir` (the extension's resources/claude). */
export function claudeAssets(sourceDir: string): Record<string, string> {
  return Object.fromEntries(ASSET_FILES.map((rel) => [rel, fs.readFileSync(path.join(sourceDir, rel), 'utf8')]));
}

const ours = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
};

/**
 * Write the skill and commands under `claudeDir` (~/.claude). A file that
 * exists without the marker is the user's and is skipped. Returns what was
 * skipped so the caller can say so.
 */
export function installClaudeAssets(claudeDir: string, sourceDir: string): { skipped: string[] } {
  const skipped: string[] = [];
  for (const [rel, body] of Object.entries(claudeAssets(sourceDir))) {
    const file = path.join(claudeDir, rel);
    if (fs.existsSync(file) && !ours(file)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { skipped };
}

/** Remove what Stack installed (marker only); the skill's folder goes too once empty. */
export function removeClaudeAssets(claudeDir: string): void {
  for (const rel of ASSET_FILES) {
    const file = path.join(claudeDir, rel);
    if (ours(file)) fs.rmSync(file, { force: true });
  }
  const skillDir = path.join(claudeDir, 'skills', 'stack-manager');
  try {
    if (fs.readdirSync(skillDir).length === 0) fs.rmdirSync(skillDir);
  } catch { /* not there */ }
}
