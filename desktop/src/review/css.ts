import { DIFF_CSS } from '@core/diff/webview/styles';

/**
 * The extension's review stylesheet, adapted to live inside the app: its page-level rules (html/body/#root
 * and the bare element resets) are scoped to `.review-host`, and the rules for VS Code's light and
 * high-contrast body classes are dropped, since the app has no such classes.
 */
export function reviewCss(css: string = DIFF_CSS): string {
  const at = css.indexOf('/* ── tokens');
  const body = at < 0 ? css : css.slice(at);
  const reset = `
.review-host *, .review-host *::before, .review-host *::after { box-sizing: border-box; margin: 0; padding: 0; }
.review-host { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); }
.review-host button, .review-host input, .review-host textarea { font: inherit; color: inherit; }
.review-host button { background: none; border: 0; }
.review-host button:disabled { cursor: default; }
`;
  return reset + body.replace(/^body\.vscode-[^{]*\{[^}]*\}\n?/gm, '');
}
