import type { DebugTemplate } from '../types';
import type { Stack } from './types';

/**
 * A launch.json template per stack, so picking "PHP" fills in the Xdebug shape
 * instead of asking the user to know it. Each is passed through whole by
 * WorktreeManager; `"{{PORT}}"` becomes the worktree's port as a number wherever
 * it appears, `{{WORKTREE_PATH}}` its checkout path.
 */
export const DEBUG_PRESETS: Record<Stack, { label: string; template: DebugTemplate }> = {
  node: {
    label: 'Node.js — attach',
    template: { type: 'node', request: 'attach', name: 'Unmess: Debug', port: '{{PORT}}' },
  },
  php: {
    label: 'PHP — Xdebug',
    template: {
      type: 'php',
      request: 'launch',
      name: 'Unmess: Xdebug',
      port: '{{PORT}}',
      pathMappings: { '/var/www': '{{WORKTREE_PATH}}' },
    },
  },
  python: {
    label: 'Python — debugpy attach',
    template: {
      type: 'debugpy',
      request: 'attach',
      name: 'Unmess: Debug',
      port: '{{PORT}}',
      connect: { host: 'localhost', port: '{{PORT}}' },
    },
  },
  go: {
    label: 'Go — Delve remote',
    template: { type: 'go', request: 'attach', mode: 'remote', name: 'Unmess: Debug', host: '127.0.0.1', port: '{{PORT}}' },
  },
};

export const STACK_ORDER: Stack[] = ['node', 'php', 'python', 'go'];

/** Which preset a template is (by debugger type), if it is one at all. */
export function presetFor(template: DebugTemplate): Stack | undefined {
  return STACK_ORDER.find((s) => DEBUG_PRESETS[s].template.type === template.type);
}
