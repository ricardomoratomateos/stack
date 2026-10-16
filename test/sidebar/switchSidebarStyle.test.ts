import { describe, it, expect, vi } from 'vitest';
import { switchSidebarStyle, type SidebarStylePickItem } from '../../src/sidebar/switchSidebarStyle';
import { DEFAULT_SIDEBAR_STYLE, SIDEBAR_STYLES, normalizeSidebarStyle } from '../../src/sidebarStyle';
import type { SidebarStyle } from '../../src/sidebarStyle';

function setup(current: SidebarStyle, choose: (items: SidebarStylePickItem[]) => SidebarStylePickItem | undefined) {
  const pick = vi.fn(async (items: SidebarStylePickItem[]) => choose(items));
  const save = vi.fn(async () => {});
  return { pick, save, run: () => switchSidebarStyle({ current: () => current, pick, save }) };
}

describe('switchSidebarStyle', () => {
  it('offers every style, the current one first and marked', async () => {
    const t = setup('mission', () => undefined);
    await t.run();
    const items = t.pick.mock.calls[0][0];
    expect(items.map((i) => i.style)).toEqual(['mission', 'aside', 'claude']);
    expect(items[0].description).toBe('current');
    expect(items[1].description).toBeUndefined();
    expect(items.every((i) => i.label && i.detail)).toBe(true);
  });

  it('saves the style that was picked', async () => {
    const t = setup('aside', (items) => items.find((i) => i.style === 'claude'));
    await expect(t.run()).resolves.toBe('claude');
    expect(t.save).toHaveBeenCalledWith('claude');
  });

  it('writes nothing when the pick is dismissed or is the current style', async () => {
    const dismissed = setup('aside', () => undefined);
    await expect(dismissed.run()).resolves.toBeUndefined();
    const same = setup('aside', (items) => items[0]);
    await expect(same.run()).resolves.toBeUndefined();
    expect(dismissed.save).not.toHaveBeenCalled();
    expect(same.save).not.toHaveBeenCalled();
  });
});

describe('normalizeSidebarStyle', () => {
  it('keeps the known styles and defaults anything else', () => {
    for (const style of SIDEBAR_STYLES) expect(normalizeSidebarStyle(style)).toBe(style);
    expect(normalizeSidebarStyle('neon')).toBe(DEFAULT_SIDEBAR_STYLE);
    expect(normalizeSidebarStyle(undefined)).toBe(DEFAULT_SIDEBAR_STYLE);
    expect(normalizeSidebarStyle(3)).toBe(DEFAULT_SIDEBAR_STYLE);
  });
});
