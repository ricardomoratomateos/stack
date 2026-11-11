import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIZES, LINE_H, clampSize, dragValue, heightFromLines, initialLayout, linesFromHeight, maxPanelWidth, modeFromQuery,
  cycleMaximized, toggleMaximized, nextMode, parseLayout, resetSize, resize, serializeLayout, setMode, stripInput, stripRows,
} from './layout';

describe('mode state', () => {
  it('starts in full with the default sizes', () => {
    const s = initialLayout();
    expect(s.mode).toBe('full');
    expect(s.sizes).toEqual(DEFAULT_SIZES);
  });
  it('cycles full -> half -> float -> full', () => {
    expect(nextMode('full')).toBe('half');
    expect(nextMode('half')).toBe('float');
    expect(nextMode('float')).toBe('full');
  });
  it('setMode changes mode and side, and is stable when nothing changes', () => {
    const s = initialLayout();
    expect(setMode(s, 'half', 'left')).toMatchObject({ mode: 'half', side: 'left' });
    expect(setMode(s, 'full')).toBe(s);
  });
  it('remembers sizes per mode', () => {
    let s = resize(initialLayout(), 'full', 'sidebar', 400);
    s = resize(s, 'half', 'sidebar', 250);
    s = resize(s, 'full', 'manager', 500);
    s = resize(s, 'float', 'lines', 9);
    expect(s.sizes.full).toMatchObject({ sidebar: 400, manager: 500 });
    expect(s.sizes.half.sidebar).toBe(250);
    expect(s.sizes.float.lines).toBe(9);
    expect(s.sizes.half.lines).toBe(6);
  });
  it('clamps widths and lines', () => {
    expect(clampSize('full', 'sidebar', 10)).toBe(200);
    expect(clampSize('full', 'sidebar', 5000)).toBe(600);
    expect(clampSize('half', 'sidebar', 5000)).toBe(360);
    expect(clampSize('full', 'manager', 10)).toBe(280);
    expect(clampSize('half', 'lines', 1)).toBe(3);
    expect(clampSize('half', 'lines', 99)).toBe(12);
    expect(clampSize('half', 'lines', 6.4)).toBe(6);
    expect(clampSize('full', 'sidebar', NaN)).toBe(340);
  });
  it('double-click reset goes back to the default of that mode', () => {
    const s = resetSize(resize(initialLayout(), 'half', 'sidebar', 300), 'half', 'sidebar');
    expect(s.sizes.half.sidebar).toBe(220);
  });
  it('round-trips through JSON and survives garbage', () => {
    const s = resize(setMode(initialLayout(), 'float', 'left'), 'full', 'sidebar', 410);
    expect(parseLayout(serializeLayout(s))).toEqual(s);
    expect(parseLayout('nope')).toEqual(initialLayout());
    expect(parseLayout(null)).toEqual(initialLayout());
    expect(parseLayout('{"mode":"x","sizes":{"full":{"sidebar":"wide","manager":1}}}').sizes.full).toEqual({ sidebar: 340, manager: 280, lines: 6 });
  });
  it('reads ?mode=', () => {
    expect(modeFromQuery('?mode=half')).toBe('half');
    expect(modeFromQuery('?mode=nope')).toBeUndefined();
    expect(modeFromQuery('')).toBeUndefined();
  });
});

describe('splitters', () => {
  it('drag moves by the delta within min/max, inverted for a panel on the far side', () => {
    expect(dragValue(300, 40, 200, 600)).toBe(340);
    expect(dragValue(300, -400, 200, 600)).toBe(200);
    expect(dragValue(440, 40, 280, 900, true)).toBe(400);
    expect(dragValue(440, -900, 280, 900, true)).toBe(900);
  });
  it('the strip snaps to whole lines and the drag changes N', () => {
    expect(linesFromHeight(heightFromLines(8))).toBe(8);
    expect(linesFromHeight(6 * LINE_H + 5)).toBe(6);
    expect(linesFromHeight(6 * LINE_H + 9)).toBe(7);
    expect(linesFromHeight(0)).toBe(3);
    expect(linesFromHeight(10_000)).toBe(12);
    const px = dragValue(heightFromLines(6), -3 * LINE_H - 2, heightFromLines(3), heightFromLines(12), true);
    expect(linesFromHeight(px)).toBe(9);
  });
  it('leaves the centre its minimum width', () => {
    expect(maxPanelWidth(1200, 440)).toBe(440);
    expect(maxPanelWidth(300, 440)).toBe(0);
  });
});

describe('manager strip', () => {
  it('types the text then Enter, as one line', () => {
    expect(stripInput('ls')).toEqual([108, 115, 13]);
    expect(stripInput('a\nb')).toEqual([97, 32, 98, 13]);
    expect(stripInput('')).toEqual([13]);
  });
  it('shows exactly N rows, the last ones, padded on top', () => {
    expect(stripRows(['a', 'b', 'c', 'd'], 3)).toEqual(['b', 'c', 'd']);
    expect(stripRows(['a'], 3)).toEqual(['', '', 'a']);
  });
});

describe('maximize', () => {
  it('double-click maximizes a panel and restores on the second', () => {
    expect(toggleMaximized(null, 'session')).toBe('session');
    expect(toggleMaximized('session', 'session')).toBeNull();
    expect(toggleMaximized('session', 'manager')).toBe('manager');
    expect(toggleMaximized('manager', 'manager')).toBeNull();
  });
  it('⌘⇧Enter toggles in Full/Half and walks session, Manager, restore in Float', () => {
    expect(cycleMaximized(null, 'full')).toBe('session');
    expect(cycleMaximized('session', 'half')).toBeNull();
    expect(cycleMaximized('manager', 'full')).toBeNull();
    expect(cycleMaximized(null, 'float')).toBe('session');
    expect(cycleMaximized('session', 'float')).toBe('manager');
    expect(cycleMaximized('manager', 'float')).toBeNull();
  });
  it('restoring keeps the splitter sizes (maximize does not touch them)', () => {
    const s = resize(initialLayout(), 'full', 'sidebar', 420);
    const max = toggleMaximized(null, 'session');
    expect(toggleMaximized(max, 'session')).toBeNull();
    expect(s.sizes.full.sidebar).toBe(420);
  });
});
