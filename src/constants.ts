export const EXTENSION_ID = 'foreman';
export const STORE_KEY = 'foreman.store';
export const COMMENTS_KEY_PREFIX = 'foreman.comments.';
export const SIDEBAR_VIEW_ID = 'foreman-sidebar';

export const NOTIFY_HOOK_SCRIPT = 'notify.sh';
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const OPENCODE_PLUGIN_PATH = '.config/opencode/plugin/foreman-notify.js';
export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const GROK_HOOKS_PATH = '.grok/hooks.json';
/** Enables Codex's hook system, which is experimental and off by default. */
export const CODEX_CONFIG_PATH = '.codex/config.toml';

/**
 * Branch names tried, in order, when a repository's main line has to be guessed.
 *
 * Shared so the guess cannot drift between the one that picks a base for a new
 * worktree and the one the review panel diffs against.
 */
export const MAIN_BRANCH_CANDIDATES = ['main', 'master', 'develop'];

export const LAUNCH_JSON_PATH = '.vscode/launch.json';
export const SETTINGS_JSON_PATH = '.vscode/settings.json';

export const WORKTREE_SETTINGS_EXCLUSIONS = {
  'files.watcherExclude': {
    '**/node_modules/**': true,
    '**/vendor/**': true,
    '**/var/cache/**': true,
  },
  'files.exclude': {
    '**/node_modules': true,
    '**/vendor': true,
  },
  'intelephense.files.exclude': [
    '**/node_modules/**',
    '**/vendor/**',
    '**/var/cache/**',
  ],
};
