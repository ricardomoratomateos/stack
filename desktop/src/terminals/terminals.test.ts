import { describe, expect, it } from 'vitest';
import { base64ToBytes, nextHistoryStart, toTerminalText } from './bytes';
import { lastLines, type LineBuffer } from './lastLines';
import { PaneBook, type PaneInfo } from './paneBook';

const buf = (lines: string[]): LineBuffer => ({
  length: lines.length,
  getLine: (y) => (lines[y] === undefined ? undefined : { translateToString: () => lines[y].replace(/\s+$/, '') }),
});

const pane = (id: string): PaneInfo => ({ id, session: 's', window: '@0', window_index: 0, window_name: 'w', cols: 80, rows: 24, active: false, command: 'zsh' });

describe('lastLines', () => {
  it('returns the last n lines', () => {
    expect(lastLines(buf(['a', 'b', 'c', 'd']), 2)).toEqual(['c', 'd']);
  });
  it('skips the blank rows below the cursor', () => {
    expect(lastLines(buf(['a', 'b', 'c', '', '  ', '']), 2)).toEqual(['b', 'c']);
  });
  it('keeps blank lines in the middle and handles short buffers', () => {
    expect(lastLines(buf(['a', '', 'b']), 6)).toEqual(['a', '', 'b']);
    expect(lastLines(buf([]), 6)).toEqual([]);
    expect(lastLines(buf(['', '']), 6)).toEqual([]);
  });
});

describe('PaneBook', () => {
  it('reports added and removed panes', () => {
    const b = new PaneBook();
    expect(b.update('s', [pane('%0'), pane('%1')])).toEqual({ added: ['%0', '%1'], removed: [] });
    expect(b.update('s', [pane('%1'), pane('%2')])).toEqual({ added: ['%2'], removed: ['%0'] });
    expect(b.list().map((p) => p.id)).toEqual(['%1', '%2']);
  });
  it('tracks visibility and drops it with the pane', () => {
    const b = new PaneBook();
    b.update('s', [pane('%0'), pane('%1')]);
    expect(b.setVisible(['%1', '%9'])).toEqual(['%1']);
    expect(b.isVisible('%1')).toBe(true);
    b.update('s', [pane('%0')]);
    expect(b.visible()).toEqual([]);
  });
  it('keeps sessions apart', () => {
    const b = new PaneBook();
    b.update('a', [{ ...pane('%0'), session: 'a' }]);
    b.update('b', [{ ...pane('%1'), session: 'b' }]);
    b.update('a', []);
    expect(b.list().map((p) => p.id)).toEqual(['%1']);
    expect(b.sessionPanes('b')).toHaveLength(1);
    expect(b.removeSession('b')).toEqual(['%1']);
    expect(b.list()).toEqual([]);
  });
});

describe('bytes helpers', () => {
  it('decodes base64 including non-utf8 bytes', () => {
    expect(Array.from(base64ToBytes('G1swbf8='))).toEqual([0x1b, 0x5b, 0x30, 0x6d, 0xff]);
  });
  it('converts captured text to CRLF', () => {
    expect(toTerminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });
  it('grows history in steps up to a cap', () => {
    expect(nextHistoryStart(2000)).toBe(-3000);
    expect(nextHistoryStart(19500)).toBe(-20000);
    expect(nextHistoryStart(20000)).toBeNull();
  });
});
