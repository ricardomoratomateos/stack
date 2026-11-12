import { describe, expect, it } from 'vitest';
import { dropIndex } from '../../src/webview/usePointerReorder';

// Rows 40px tall with 2px gaps, except row 3: the selected card, expanded to 240px.
const rows = (heights: number[]) => {
  let y = 0;
  return heights.map((h) => {
    const r = { top: y, bottom: y + h };
    y += h + 2;
    return r;
  });
};

describe('dropIndex', () => {
  const r = rows([40, 40, 40, 240, 40]);

  it('stays put without movement', () => {
    expect(dropIndex(r, 3, 0)).toBe(3);
  });

  it('a tall card dragged to the top of the list lands first', () => {
    expect(dropIndex(r, 3, r[0].top - r[3].top)).toBe(0);
    expect(dropIndex(r, 3, r[1].top - r[3].top)).toBe(1);
  });

  it('a short row passes another once its leading edge crosses the middle', () => {
    expect(dropIndex(r, 0, 20)).toBe(0);
    expect(dropIndex(r, 0, 23)).toBe(1);
    expect(dropIndex(r, 4, r[3].top + 121 - r[4].top)).toBe(4);
    expect(dropIndex(r, 4, r[3].top + 119 - r[4].top)).toBe(3);
  });

  it('a tall card dragged to the bottom lands last', () => {
    expect(dropIndex(r, 3, r[4].bottom - r[3].bottom)).toBe(4);
  });
});
