import { describe, expect, it } from 'vitest';
import { codeActionOf, doubleShift, type KeyLike } from './keymap';

const key = (code: string, mods: Partial<KeyLike> = {}, k = ''): KeyLike =>
  ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('Code tab keys (PhpStorm)', () => {
  it('maps the navigation keys', () => {
    expect(codeActionOf(key('KeyO', { metaKey: true, shiftKey: true }))).toBe('go-to-file');
    expect(codeActionOf(key('KeyO', { metaKey: true }))).toBe('go-to-symbol');
    expect(codeActionOf(key('KeyO', { metaKey: true, altKey: true }))).toBe('go-to-symbol');
    expect(codeActionOf(key('KeyF', { metaKey: true, shiftKey: true }))).toBe('find-in-path');
    expect(codeActionOf(key('KeyE', { metaKey: true }))).toBe('recent-files');
    expect(codeActionOf(key('BracketLeft', { metaKey: true }))).toBe('back');
    expect(codeActionOf(key('BracketRight', { metaKey: true }))).toBe('forward');
  });

  it('keeps VS Code\'s and leaves the rest alone', () => {
    expect(codeActionOf(key('KeyP', { metaKey: true }))).toBe('go-to-file');
    expect(codeActionOf(key('KeyT', { metaKey: true }))).toBe('go-to-symbol');
    expect(codeActionOf(key('Minus', { ctrlKey: true }, '-'))).toBe('back');
    expect(codeActionOf(key('Minus', { ctrlKey: true, shiftKey: true }, '_'))).toBe('forward');
    expect(codeActionOf(key('KeyF', { metaKey: true }))).toBe('find-in-file'); // Monaco's find widget
    expect(codeActionOf(key('KeyF', { metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(codeActionOf(key('Digit1', { metaKey: true }))).toBeNull(); // the app's task switching
  });

  it('spots ⇧⇧ and nothing else', () => {
    const d = doubleShift(300);
    const down = { type: 'keydown', key: 'Shift' }, up = { type: 'keyup', key: 'Shift' };
    expect(d(down, 0) || d(up, 10) || d(down, 100)).toBe(false);
    expect(d(up, 150)).toBe(true);
    // Shift used for a capital in between: not a pair.
    expect(d(down, 1000) || d(up, 1010) || d(down, 1050) || d({ type: 'keydown', key: 'A' }, 1060) || d(up, 1100)).toBe(false);
    // Too slow.
    expect(d(down, 2000) || d(up, 2010) || d(down, 2500) || d(up, 2510)).toBe(false);
  });
});
