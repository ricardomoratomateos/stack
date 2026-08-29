import { describe, it, expect } from 'vitest';
import { DEBUG_PRESETS, STACK_ORDER, presetFor } from '../../src/settings/presets';

describe('debug presets', () => {
  it.each(STACK_ORDER)('%s has the shape the repo config validator requires and a port slot', (stack) => {
    const { template, label } = DEBUG_PRESETS[stack];
    expect(label).toBeTruthy();
    expect(typeof template.type).toBe('string');
    expect(typeof template.request).toBe('string');
    expect(JSON.stringify(template)).toContain('"{{PORT}}"');
  });

  it('the PHP preset maps the container path onto the worktree', () => {
    expect(DEBUG_PRESETS.php.template.pathMappings).toEqual({ '/var/www': '{{WORKTREE_PATH}}' });
  });

  it('recognises which preset a template is by its debugger type', () => {
    expect(presetFor(DEBUG_PRESETS.php.template)).toBe('php');
    expect(presetFor({ type: 'node', request: 'attach', name: 'x', port: 1 })).toBe('node');
    expect(presetFor({ type: 'coreclr', request: 'attach', name: 'x', port: 1 })).toBeUndefined();
  });
});
