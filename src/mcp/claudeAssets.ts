import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The friendly half of the manager: a skill that tells Claude when the Stack
 * tools apply, and slash commands, so nobody has to type "use stack_status".
 * Shipped as markdown in resources/claude/ (next to stackd.js as `claude/` in
 * the app), copied into the user's ~/.claude with the MCP registration.
 *
 * Every file carries MARKER. Stack only ever overwrites a file that has it —
 * a `/stack` command the user wrote themselves is left alone, and simply wins.
 */
export const MARKER = '<!-- Installed by Stack (Settings → "Stack tools in Claude Code"); rewritten on every install. -->';

/** What every marker Stack has used starts with, the VS Code extension's included. */
const MARKER_PREFIX = '<!-- Installed by Stack';

/** The files, relative to both resources/claude/ and ~/.claude: what Stack owns. */
export const ASSET_FILES = [
  'skills/stack-manager/SKILL.md',
  'commands/stack.md',
  'commands/stack-task.md',
  'commands/stack-task-remove.md',
  'commands/stack-next.md',
] as const;

/** The shipped files' contents, read from `sourceDir` (resources/claude). */
export function claudeAssets(sourceDir: string): Record<string, string> {
  return Object.fromEntries(ASSET_FILES.map((rel) => [rel, fs.readFileSync(path.join(sourceDir, rel), 'utf8')]));
}

const ours = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER_PREFIX);
  } catch {
    return false;
  }
};

/**
 * Write the skill and commands under `claudeDir` (~/.claude). A file that
 * exists without a marker is the user's and is skipped. Returns what was
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
