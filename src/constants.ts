export const EXTENSION_ID = 'unmess';
export const STORE_KEY = 'unmess.store';
export const COMMENTS_KEY_PREFIX = 'unmess.comments.';
export const SIDEBAR_VIEW_ID = 'unmess-sidebar';

export const NOTIFY_HOOK_SCRIPT = 'notify.sh';
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const OPENCODE_PLUGIN_PATH = '.config/opencode/plugin/unmess-notify.js';

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
