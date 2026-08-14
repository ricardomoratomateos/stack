import { describe, it, expect } from 'vitest';
import { displayLabel, truncateLabel, MAX_DISPLAY_LABEL } from '../../src/worktree/displayLabel';

describe('truncateLabel', () => {
  it('leaves a string shorter than the cap untouched', () => {
    expect(truncateLabel('feat/login')).toBe('feat/login');
  });

  it('leaves a string exactly at the cap untouched (no stray ellipsis)', () => {
    const exact = 'x'.repeat(MAX_DISPLAY_LABEL);
    expect(truncateLabel(exact)).toBe(exact);
  });

  it('caps one character past the limit', () => {
    const over = 'x'.repeat(MAX_DISPLAY_LABEL + 1);
    expect(truncateLabel(over)).toBe(`${'x'.repeat(MAX_DISPLAY_LABEL)}…`);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    // 32 chars ending in a space, so a naive slice would read "… …".
    const text = `${'a'.repeat(MAX_DISPLAY_LABEL - 1)} bcdef`;
    expect(truncateLabel(text)).toBe(`${'a'.repeat(MAX_DISPLAY_LABEL - 1)}…`);
  });

  it('honours an explicit shorter cap', () => {
    expect(truncateLabel('abcdefghij', 4)).toBe('abcd…');
  });
});

describe('displayLabel', () => {
  it('prefers the alias over the branch', () => {
    expect(displayLabel({ alias: 'Fix the bug', branch: 'feat/x' })).toBe('Fix the bug');
  });

  it('falls back to the branch when there is no alias', () => {
    expect(displayLabel({ branch: 'feat/x' })).toBe('feat/x');
  });

  it('caps a sentence-long alias — the case that made terminal tabs unusable', () => {
    const wt = { alias: '[Shop] Al marcar un pedido como enviado, el descuento se pierde al recalcular el total.', branch: 'as-7161' };
    expect(displayLabel(wt)).toBe('[Shop] Al marcar un pedido como…');
  });

  it('caps a sentence-long branch too (branches can be long as well)', () => {
    const wt = { branch: 'feature/some-extremely-long-branch-name-nobody-should-write' };
    expect(displayLabel(wt)).toBe('feature/some-extremely-long-bran…');
  });
});
