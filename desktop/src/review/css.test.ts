import { describe, expect, it } from 'vitest';
import { reviewCss } from './css';

describe('reviewCss', () => {
  const css = reviewCss();
  it('has no page-level selectors left', () => {
    for (const sel of css.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('{'))) {
      expect(sel).not.toMatch(/^(html|body|#root|button|input|\*)/);
    }
  });
  it('drops the light and high-contrast body rules', () => {
    expect(css).not.toContain('body.vscode-');
    expect(css).toContain('.rv-root');
  });
});
