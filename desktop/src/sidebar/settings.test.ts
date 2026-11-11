import { describe, expect, it } from 'vitest';
import { resolveSidebarStyle } from './settings';

describe('resolveSidebarStyle', () => {
  const code = '{ "stack.sidebarStyle": "claude" }';
  it('prefers the stack settings file', () => {
    expect(resolveSidebarStyle({ sidebarStyle: 'mission' }, code)).toBe('mission');
    expect(resolveSidebarStyle({ 'stack.sidebarStyle': 'mission' }, code)).toBe('mission');
  });
  it('falls back to VS Code, then aside', () => {
    expect(resolveSidebarStyle({}, code)).toBe('claude');
    expect(resolveSidebarStyle({ sidebarStyle: 'bogus' }, code)).toBe('claude');
    expect(resolveSidebarStyle(null, null)).toBe('aside');
  });
});
