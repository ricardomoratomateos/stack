/** The retired VS Code extension's `<publisher>.<name>`: what VS Code keyed its storage on (stackd's one-time import reads it). */
export const EXTENSION_ID = 'ricardomoratomateos.stack-agents';
export const STORE_KEY = 'stack.store';

export const NOTIFY_HOOK_SCRIPT = 'notify.sh';
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const OPENCODE_PLUGIN_PATH = '.config/opencode/plugin/stack-notify.js';

/**
 * Branch names tried, in order, when a repository's main line has to be guessed.
 *
 * Shared so the guess cannot drift between the one that picks a base for a new
 * worktree and the one the review panel diffs against.
 */
export const MAIN_BRANCH_CANDIDATES = ['main', 'master', 'develop'];
