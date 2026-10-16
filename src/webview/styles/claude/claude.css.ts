/**
 * "Claude": warm terracotta on whatever the VS Code theme paints. Everything
 * but the accent comes from the theme, so it sits right in light and dark.
 */
export const CLAUDE_CSS = `
.fm-claude {
  --fm-sans: var(--vscode-font-family);
  --fm-mono: var(--vscode-editor-font-family, Menlo, monospace);
  --fm-bg: var(--vscode-sideBar-background);
  --fm-text: var(--vscode-foreground);
  --fm-text-dim: var(--vscode-descriptionForeground, color-mix(in srgb, var(--vscode-foreground) 70%, transparent));
  --fm-text-faint: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
  --fm-border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  --fm-border-strong: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  --fm-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
  --fm-radius: 8px; --fm-radius-sm: 6px; --fm-btn-radius: 6px;

  --fm-accent: #D97757;
  --fm-accent-text: #E8956F;
  --fm-accent-ink: #1A1A1A;
  --fm-accent-soft: color-mix(in srgb, var(--fm-accent) 12%, transparent);
  --fm-accent-border: color-mix(in srgb, var(--fm-accent) 55%, transparent);
  --fm-primary-bg: var(--fm-accent);
  --fm-primary-ink: #1A1A1A;

  --fm-needs: var(--vscode-editorWarning-foreground, #cca700);
  --fm-ok: var(--vscode-testing-iconPassed, #73c991);
  --fm-warn: var(--vscode-editorWarning-foreground, #cca700);
  --fm-bad: var(--vscode-testing-iconFailed, #f14c4c);
  --fm-working: var(--fm-accent);
  --fm-working-text: var(--fm-accent-text);
  --fm-idle: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
  --fm-add: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  --fm-del: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  --fm-indent: 38px;
}
body.vscode-light .fm-claude { --fm-accent-text: #B4532F; }
body.vscode-high-contrast .fm-claude, body.vscode-high-contrast-light .fm-claude {
  --fm-border: var(--vscode-contrastBorder, currentColor);
  --fm-border-strong: var(--vscode-contrastBorder, currentColor);
}

.cl-composer-wrap { flex: none; padding: 8px 12px 12px; }
.cl-composer {
  width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--fm-border-strong)); border-radius: 10px;
  text-align: left; transition: border-color .12s;
}
.cl-composer:hover { border-color: var(--fm-accent-border); }
.cl-prompt { font-family: var(--fm-mono); font-weight: 600; color: var(--fm-accent); }
.cl-placeholder { flex: 1; color: var(--vscode-input-placeholderForeground, var(--fm-text-dim)); }

.cl-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 12px; display: flex; flex-direction: column; }
.cl-list > .fm-empty { flex: 1; }
.cl-group { margin-bottom: 6px; }
.cl-group-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px;
  font-size: 11px; font-weight: 400; letter-spacing: .06em; text-transform: uppercase; color: var(--fm-text-dim);
}
.cl-group-label { font-weight: 600; }
.cl-group-count { font-family: var(--fm-mono); color: var(--fm-text-faint); }
.cl-group-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--fm-idle); }
.cl-group[data-group='needs'] .cl-group-dot { background: var(--fm-needs); }
.cl-group[data-group='review'] .cl-group-dot { background: var(--fm-ok); }
.cl-group[data-group='working'] .cl-group-dot { background: var(--fm-working); }
.cl-group[data-group='missing'] .cl-group-dot { background: transparent; border: 1px dashed var(--fm-text-faint); }

.cl-row {
  margin-bottom: 2px; border-radius: 10px; border: 1px solid transparent;
  transition: background .12s, border-color .12s;
  animation: stack-fadein .15s ease;
}
.cl-row[data-selected] { background: color-mix(in srgb, var(--fm-accent) 8%, transparent); border-color: color-mix(in srgb, var(--fm-accent) 35%, transparent); }
.cl-row-main {
  width: 100%; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 10px; align-items: start;
  padding: 9px 10px; border: 0; border-radius: 10px; background: transparent; text-align: left;
}
.cl-row:not([data-selected]) .cl-row-main:hover { background: var(--fm-hover); }
.cl-glyph { height: 18px; display: flex; align-items: center; justify-content: center; }
.cl-glyph-needs circle:first-child { fill: var(--fm-needs); }
.cl-glyph-needs path { stroke: #1a1a1a; }
.cl-glyph-ink { fill: #1a1a1a; }
.cl-glyph-review circle, .cl-glyph-review path { stroke: var(--fm-ok); }
.cl-glyph-idle circle { stroke: var(--fm-idle); }
.cl-glyph-working { font-size: 16px; line-height: 1; color: var(--fm-accent); }
.cl-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cl-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cl-name-text { font-weight: 500; color: var(--fm-text); }
.cl-row[data-group='idle'] .cl-name-text, .cl-row[data-group='missing'] .cl-name-text { color: var(--fm-text-dim); }
.cl-row[data-group='missing'] .cl-name-text { text-decoration: line-through; }
.cl-tag { flex: none; font-family: var(--fm-mono); font-size: 10px; color: var(--fm-text-dim); border: 1px solid var(--fm-border-strong); border-radius: 4px; padding: 0 4px; }
.cl-line { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--fm-text-dim); }
.cl-row[data-group='working'] .cl-line { color: color-mix(in srgb, var(--fm-accent-text) 70%, var(--fm-text-dim)); }
.cl-line-mark { flex: none; display: inline-flex; }
.cl-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; font-family: var(--fm-mono); font-size: 11px; }
.cl-when { color: var(--fm-text-faint); }
.cl-indent { margin: 0 10px 8px var(--fm-indent); }

.cl-expand { margin: 0 10px 10px var(--fm-indent); display: flex; flex-direction: column; gap: 8px; }
.cl-actions { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px; }
.cl-actions .fm-split-main { padding: 0 10px; }

.cl-foot {
  flex: none; max-height: 45%; overflow-y: auto;
  border-top: 1px solid var(--fm-border); padding: 10px 16px 12px;
  display: flex; flex-direction: column; gap: 8px; font-size: 12px;
}
.cl-foot-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.cl-foot-name { font-weight: 600; }
.cl-foot-branch { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text-dim); }

/* Narrow: a 240px sidebar keeps names readable by giving up the row's gutter. */
@container fm (max-width: 280px) {
  .cl-row-main { gap: 8px; padding: 8px 6px; }
  .cl-expand, .fm-ask, .fm-row-actions, .cl-indent { margin-left: 8px; margin-right: 8px; }
  .cl-composer-wrap { padding-left: 8px; padding-right: 8px; }
  .cl-foot { padding-left: 10px; padding-right: 10px; }
}
`;
