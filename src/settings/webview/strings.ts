import type { SectionId } from '../draft';

/** Every user-facing string, in one place, so a translation is a mechanical pass. */
export const STR = {
  settings: 'Settings',
  loading: 'Loading settings…',

  scopeRepo: 'Repository',
  scopeMe: 'Just me',
  scopeRepoTitle: (file: string) => `Saved to ${file} — committed, so everyone who clones the repository gets it.`,
  scopeMeTitle: 'Saved to your VS Code settings — never travels with the repository.',
  legendRepo: 'This repository',
  legendRepoHint: 'Shared with your team',
  legendMe: 'Just me',
  legendMeHint: 'VS Code settings',
  fileMissing: 'Not created yet',
  openFile: 'Open file',

  noRepoTitle: 'No repository open',
  noRepoBody: 'Open a folder that is a git repository to configure how Stack treats it. Your own settings still work.',

  newFile: (file: string) => `${file} does not exist yet. Saving creates it — commit it and your team gets the same setup.`,
  legacyFile: (file: string) => `This repository’s settings are still in ${file}, where Foreman (Stack’s old name) kept them. Stack reads and saves that file until it finds a .stack/config.json — rename the .foreman folder to .stack, and the script paths that point into it, once nobody on the team runs Foreman any more.`,
  fileProblems: (file: string) => `${file} has problems`,
  fileProblemsHint: 'Fix them in the file, or save from here to overwrite it.',
  overrides: (keys: string) => `Your settings.json sets ${keys} for this repository. Those win over the file, so what you save here will not take effect for you until they go.`,
  clearOverrides: 'Remove my overrides',

  unsaved: 'Unsaved changes',
  inSections: (names: string) => `in ${names}`,
  discard: 'Discard',
  save: 'Save changes',
  saving: 'Saving…',
  saved: 'Saved',
  fixToSave: (n: number) => (n === 1 ? 'Fix 1 field to save' : `Fix ${n} fields to save`),

  // General
  agents: 'Coding agents',
  agentsHint: 'The default agent is what the main button on each worktree launches; the others sit behind its chevron.',
  installed: 'Installed',
  notFound: 'Not found on PATH',
  command: 'Command',
  commandHint: 'What Stack runs in the terminal. Add flags here if you always want them.',
  commandRequired: 'A command is required.',
  makeDefault: 'Make default',
  isDefault: 'Default',

  // Appearance
  sidebarStyle: 'Sidebar style',
  sidebarStyleHint: 'The same worktrees and actions in every style; only the layout and the colours differ. This page takes the style’s accent as you choose.',
  sessions: 'Terminals',
  sessionTabs: 'Session tabs',
  sessionTabsHint: 'A tab per session can be dragged into another editor group — an agent and a shell side by side. Applies to the next terminal Stack opens.',
  perSession: 'A tab per session',
  single: 'One terminal per worktree',

  // Worktrees
  worktreesLocation: 'Location',
  worktreesDir: 'Worktrees folder',
  worktreesDirHint: 'Where worktrees are created, relative to the repository root.',
  baseBranch: 'Start new work from',
  baseBranchHint: 'Preselected in the New task panel.',
  required: 'This can’t be empty.',
  behaviour: 'Behaviour',
  focusMode: 'Focus mode',
  focusModeHint: 'Switching worktree closes the other worktrees’ editor tabs and terminals.',
  scopeSearch: 'Scope search to the active worktree',
  scopeSearchHint: 'Search and Quick Open only look inside the worktree you are working in.',

  // Scripts
  setup: 'After creating a worktree',
  setupHint: 'Install dependencies, copy .env, boot services.',
  teardown: 'Before deleting a worktree',
  teardownHint: 'Stop what setup started, free what it reserved.',
  choose: 'Choose…',
  createForMe: 'Create one',
  scriptPlaceholder: 'Not set — nothing runs',
  scriptEnv: 'What your scripts receive',
  scriptEnvBody: 'Environment variables, plus one per port you generate under Docker. COMPOSE_PROJECT_NAME and COMPOSE_FILE are set too, so a plain `docker compose up -d` starts the very stack the worktree card shows and Stack stops.',

  // Docker
  dockerCard: 'Compose stack',
  dockerToggle: 'Docker stack per worktree',
  dockerToggleHint: 'A dedicated compose stack for each worktree, on ports that never collide.',
  dockerFound: (files: string) => `Found ${files} in this repository.`,
  dockerUse: 'Set it up',
  files: 'Compose files',
  composeFile: 'Compose file',
  composeFileHint: 'The base file, relative to the worktree.',
  overrideFile: 'Worktree override',
  overrideFileHint: 'Layered on top, in worktrees only.',
  overrideMore: 'Avoiding port collisions',
  overrideMoreBody: 'Compose adds an override’s `ports` to the compose file’s rather than replacing them, so a port hard-coded in the compose file is still published by every worktree and collides. Write it as ${HTTP_PORT} in the compose file, or start the override’s list with `ports: !override`.',
  ports: 'Ports',
  portsLabel: 'Variables to generate',
  portsHint: 'One per port. At least one is what enables the Docker button on each worktree. DEBUG_PORT reuses the debug port.',
  portsEmpty: 'None yet — add at least one.',
  portsFound: 'Found in your compose files',
  addPort: 'Add',
  portPlaceholder: 'HTTP_PORT',
  removePort: (p: string) => `Remove ${p}`,
  basePort: 'First port',
  basePortHint: 'Where the first worktree’s block starts.',
  portStride: 'Ports per worktree',
  portStrideHint: (n: number) => `Each worktree owns a block of ${n}.`,
  strideTight: (vars: number, stride: number) => `${vars} variables but only ${stride} ports per worktree — blocks would overlap.`,
  portRange: 'Enter a port from 1 to 65535.',

  // Debugging
  debugPorts: 'Ports',
  debugBasePort: 'First debug port',
  debugBasePortHint: 'Each worktree gets its own, counting up from here.',
  debugger: 'Debugger',
  debuggerHint: 'A starting template; edit it below for anything else.',
  custom: 'Custom',
  templateCard: 'Launch template',
  template: 'launch.json template',
  templateHint: '{{PORT}} becomes the worktree’s port, {{WORKTREE_PATH}} its folder. Any debugger VS Code supports.',
  templateBad: 'Not valid JSON.',
  templateShape: 'Needs a string "type" and "request".',
  templateOk: 'Valid',
  format: 'Format',
  stackHint: (stack: string) => `This looks like a ${stack} project.`,
  usePreset: 'Use that preset',

  // Notifications
  notifyCard: 'Attention',
  notify: 'Notify when an agent needs you',
  notifyHint: 'A native notification when an agent is waiting on you and VS Code is in the background.',
} as const;

export const SECTION_META: Record<SectionId, { label: string; icon: string; title: string; description: string }> = {
  general: { label: 'General', icon: 'hubot', title: 'General', description: 'Which coding agents Stack launches, and how.' },
  appearance: { label: 'Appearance', icon: 'symbol-color', title: 'Appearance', description: 'How the sidebar looks and how sessions open.' },
  worktrees: { label: 'Worktrees', icon: 'git-branch', title: 'Worktrees', description: 'Where worktrees live, what they start from, and how switching behaves.' },
  scripts: { label: 'Scripts', icon: 'terminal', title: 'Setup & teardown scripts', description: 'Run something when a worktree is created and before it is deleted.' },
  docker: { label: 'Docker', icon: 'server-environment', title: 'Docker', description: 'A compose stack per worktree, on ports that never collide.' },
  debugging: { label: 'Debugging', icon: 'debug-alt', title: 'Debugging', description: 'Each worktree gets its own launch.json on its own port, so you can step-debug several at once.' },
  notifications: { label: 'Notifications', icon: 'bell', title: 'Notifications', description: 'When Stack should get your attention.' },
};

/** Where each section's fields are saved — the page header says it once, in words. */
export const SECTION_SCOPES: Record<SectionId, ('repo' | 'me')[]> = {
  general: ['me'], appearance: ['me'], worktrees: ['repo', 'me'], scripts: ['repo'], docker: ['repo'], debugging: ['repo'], notifications: ['me'],
};
