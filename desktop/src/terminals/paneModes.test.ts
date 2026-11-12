import { describe, expect, it } from 'vitest';
import { modesSequence, parsePaneModes, screenSequence } from './paneModes';

describe('paneModes', () => {
  it('reads tmux reply in PANE_MODES order', () => {
    expect(parsePaneModes('1 0 0 1 1 0 0 0\n')).toEqual({
      alt: true, mouseStandard: false, mouseButton: false, mouseAll: true, mouseSgr: true, mouseUtf8: false, keypadCursor: false, keypad: false,
    });
    expect(parsePaneModes('1 0 0')).toBeNull();
    expect(parsePaneModes('x 0 0 0 0 0 0 0')).toBeNull();
  });

  it('puts an agent on the alternate screen with any-event SGR mouse back (Claude Code)', () => {
    const m = parsePaneModes('1 0 0 1 1 0 0 0')!;
    expect(screenSequence(m)).toBe('\x1b[?1049h');
    expect(modesSequence(m)).toBe('\x1b[?1003h\x1b[?1006h');
  });

  it('a plain shell needs nothing', () => {
    const m = parsePaneModes('0 0 0 0 0 0 0 0')!;
    expect(screenSequence(m)).toBe('');
    expect(modesSequence(m)).toBe('');
  });

  it('only the widest mouse tracking mode, plus keypad modes', () => {
    expect(modesSequence(parsePaneModes('0 1 1 0 0 1 1 1')!)).toBe('\x1b[?1002h\x1b[?1005h\x1b[?1h\x1b=');
  });
});
