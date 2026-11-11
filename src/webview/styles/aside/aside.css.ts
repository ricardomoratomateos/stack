/**
 * "Aside": monochrome, one lime accent, small radii. Paints its own palette in
 * dark themes and an inverted one in light themes; in high-contrast themes it
 * steps aside and uses the theme's colours, since a fixed palette cannot promise
 * the contrast those themes exist to guarantee.
 */
export const ASIDE_CSS = `
.fm-aside {
  --fm-sans: var(--vscode-font-family);
  --fm-mono: var(--vscode-editor-font-family, ui-monospace, monospace);

  --fm-bg: #111111;
  --fm-surface: #171717;
  --fm-selected: #1a1a1a;
  --fm-text: #fafafa;
  --fm-text-dim: #a3a3a3;
  --fm-text-faint: #737373;
  --fm-border: #262626;
  --fm-border-strong: #404040;
  --fm-hover: rgba(255, 255, 255, 0.05);
  --fm-radius: 4px; --fm-radius-sm: 4px; --fm-btn-radius: 4px;

  --fm-accent: #c8ff00;
  --fm-accent-text: #c8ff00;
  --fm-accent-ink: #0a0a0a;
  --fm-accent-soft: rgba(200, 255, 0, 0.08);
  --fm-accent-border: rgba(200, 255, 0, 0.35);
  --fm-primary-bg: #fafafa;
  --fm-primary-ink: #0a0a0a;

  /* In Aside "needs you" is the one thing that gets the accent. */
  --fm-needs: #c8ff00;
  --fm-needs-ink: #0a0a0a;
  --fm-ok: #4ade80;
  --fm-warn: #fbbf24;
  --fm-bad: #f07167;
  --fm-review: #3b82f6;
  --fm-working: #fafafa;
  --fm-idle: #525252;
  --fm-add: #4ade80;
  --fm-del: #f07167;
  --fm-indent: 32px; /* row inset 8 + 8 + dot 14 + gap 8 less border: the text column */
}
body.vscode-light .fm-aside {
  --fm-bg: #fafafa;
  --fm-surface: #ffffff;
  --fm-selected: #f0f0f0;
  --fm-text: #0a0a0a;
  --fm-text-dim: #525252;
  --fm-text-faint: #737373;
  --fm-border: #e5e5e5;
  --fm-border-strong: #d4d4d4;
  --fm-hover: rgba(0, 0, 0, 0.05);
  /* Lime is a fill on light, never text: it has no contrast against white. */
  --fm-accent-text: #4d6b00;
  --fm-accent-soft: rgba(200, 255, 0, 0.22);
  --fm-accent-border: rgba(77, 107, 0, 0.45);
  --fm-primary-bg: #0a0a0a;
  --fm-primary-ink: #fafafa;
  --fm-needs-text: #4d6b00;
  --fm-ok: #15803d;
  --fm-warn: #b45309;
  --fm-bad: #dc2626;
  --fm-review: #2563eb;
  --fm-working: #0a0a0a;
  --fm-idle: #a3a3a3;
  --fm-add: #15803d;
  --fm-del: #dc2626;
}
body.vscode-high-contrast .fm-aside, body.vscode-high-contrast-light .fm-aside {
  --fm-bg: var(--vscode-sideBar-background);
  --fm-surface: var(--vscode-sideBar-background);
  --fm-selected: var(--vscode-list-activeSelectionBackground, transparent);
  --fm-text: var(--vscode-foreground);
  --fm-text-dim: var(--vscode-foreground);
  --fm-text-faint: var(--vscode-foreground);
  --fm-border: var(--vscode-contrastBorder, currentColor);
  --fm-border-strong: var(--vscode-contrastBorder, currentColor);
  --fm-accent: var(--vscode-focusBorder);
  --fm-accent-text: var(--vscode-textLink-foreground, var(--vscode-foreground));
  --fm-accent-border: var(--vscode-focusBorder);
  --fm-needs: var(--vscode-editorWarning-foreground, #ffff00);
  --fm-needs-text: var(--vscode-editorWarning-foreground, #ffff00);
  --fm-primary-bg: var(--vscode-button-background);
  --fm-primary-ink: var(--vscode-button-foreground);
  --fm-working: var(--vscode-foreground);
  --fm-idle: var(--vscode-foreground);
}

.as-brand { flex: none; height: 36px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--fm-border))); }
.as-mark { width: 20px; height: 20px; flex: none; border-radius: 4px; background: var(--fm-accent); display: flex; align-items: center; justify-content: center; color: var(--fm-accent-ink, #0a0a0a); }
.as-wordmark { font-weight: 600; letter-spacing: -.01em; }
.as-sub { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text-faint); }

.as-host-slot { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }

.as-composer-wrap { flex: none; padding: 0 16px 8px; }
.as-composer {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px;
  background: var(--fm-surface); border: 1px solid var(--fm-border); border-radius: 6px; text-align: left;
  transition: border-color .12s;
}
.as-composer:hover { border-color: var(--fm-border-strong); }
.as-placeholder { flex: 1; color: var(--fm-text-faint); }
.as-new { flex: none; height: 24px; padding: 0 10px; display: flex; align-items: center; border-radius: 4px; background: var(--fm-accent); color: var(--fm-accent-ink, #0a0a0a); font-size: 12px; font-weight: 600; }

.as-chips { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px; height: 28px; margin: 4px 16px; }
.as-chip {
  height: 24px; display: flex; align-items: center; gap: 4px; padding: 0 4px; margin: 0 -4px; border-radius: 4px;
  background: transparent; border: 0; color: var(--fm-text-dim); font-family: var(--fm-mono); font-size: 11px; white-space: nowrap;
  min-width: 0; overflow: hidden;
}
.as-chip:hover { background: var(--fm-hover); }
.as-chip[aria-pressed='true'] { background: var(--fm-selected); color: var(--fm-text); }
.as-chip-n { font-family: var(--fm-mono); color: var(--fm-text); }
.as-chip[data-zero] { opacity: .4; }
.as-pinned { flex: none; padding: 8px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--fm-border))); }
.as-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 16px; display: flex; flex-direction: column; }
.as-list > .fm-empty { flex: 1; }
.as-group-head {
  padding: 12px 8px 8px; font-family: var(--fm-mono); font-size: 11px; font-weight: 400;
  letter-spacing: .08em; text-transform: uppercase; color: var(--fm-text-faint);
}

.as-row { margin-bottom: 2px; border-radius: 6px; border: 1px solid transparent; animation: stack-fadein .15s ease; }
.as-row[data-selected] { background: var(--fm-selected); border-color: var(--fm-border-strong); }
.as-row-main {
  width: 100%; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: 8px; align-items: start;
  padding: 12px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left;
}
.as-row:not([data-selected]) .as-row-main:hover { background: var(--fm-hover); }
.as-dot-wrap { height: 18px; display: flex; align-items: center; justify-content: center; }
.as-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.as-name { font-weight: 500; color: var(--fm-text); }
.as-row[data-group='idle'] .as-name, .as-row[data-group='missing'] .as-name { color: var(--fm-text-dim); }
.as-row[data-group='missing'] .as-name { text-decoration: line-through; }
.as-line { font-size: 12px; line-height: 1.4; color: var(--fm-text-dim); }
.as-provider { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text-faint); }
.as-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-family: var(--fm-mono); font-size: 11px; }
.as-when { color: var(--fm-text-faint); }
.as-indent { margin: 0 16px 8px var(--fm-indent); }

.as-expand { margin: 4px 16px 12px var(--fm-indent); display: flex; flex-direction: column; gap: 12px; }
.as-expand .fm-det { border-top: 1px solid var(--fm-border); padding-top: 12px; }
.as-expand .fm-sessions { padding-top: 4px; }
.as-actions { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px; }
.as-actions .fm-split-main { padding: 0 10px; }
.fm-aside .fm-sess-main { grid-template-columns: 10px minmax(0, 1fr) auto; }
.fm-aside .fm-sess-name, .fm-aside .fm-sess-sub { font-family: var(--fm-mono); font-size: 11px; }
.fm-aside .fm-health { border-top-color: var(--fm-border); }

@container fm (max-width: 280px) {
  .as-row-main { gap: 8px; padding: 8px 6px; }
  .as-expand, .fm-ask, .fm-row-actions, .as-indent { margin-left: 8px; margin-right: 8px; }
  .as-brand, .as-composer-wrap { padding-left: 8px; padding-right: 8px; }
  .as-chips { margin-left: 8px; margin-right: 8px; }
}
`;
