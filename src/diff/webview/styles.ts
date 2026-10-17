/**
 * Review panel styles.
 *
 * Surfaces and diff colours come from the user's VS Code theme, so the panel
 * matches the editor beside it. Only the accent (primary button, focus ring,
 * selected states) is the product's own, and it follows `stack.sidebarStyle`:
 * the same lime / terracotta / blue the sidebar wears, set on the root as
 * `data-style` and updated live.
 */
export const DIFF_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  overflow: hidden;
}
button, input, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; }
button:disabled { cursor: default; }

/* ── tokens ── */
.rv-root {
  --rv-bg: var(--vscode-editor-background);
  --rv-fg: var(--vscode-editor-foreground, var(--vscode-foreground));
  --rv-dim: var(--vscode-descriptionForeground, color-mix(in srgb, var(--rv-fg) 65%, transparent));
  --rv-line: color-mix(in srgb, var(--rv-fg) 12%, transparent);
  --rv-line-strong: color-mix(in srgb, var(--rv-fg) 24%, transparent);
  --rv-hover: color-mix(in srgb, var(--rv-fg) 7%, transparent);
  --rv-surface: color-mix(in srgb, var(--rv-fg) 4.5%, var(--rv-bg));
  --rv-surface-2: color-mix(in srgb, var(--rv-fg) 8%, var(--rv-bg));
  --rv-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  --rv-code-size: var(--vscode-editor-font-size, 13px);
  --rv-lh: 20px;
  --rv-radius: 6px;

  --rv-add-bg: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, .16));
  --rv-del-bg: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, .16));
  --rv-add-word: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, .34));
  --rv-del-word: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, .34));
  --rv-add-gutter: var(--vscode-diffEditorGutter-insertedLineBackground, var(--rv-add-bg));
  --rv-del-gutter: var(--vscode-diffEditorGutter-removedLineBackground, var(--rv-del-bg));
  --rv-ln-fg: var(--vscode-editorLineNumber-foreground, var(--rv-dim));
  --rv-add-fg: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
  --rv-del-fg: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
  --rv-mod-fg: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
  --rv-ren-fg: var(--vscode-gitDecoration-renamedResourceForeground, #a371f7);

  --rv-accent: #c8ff00;
  --rv-accent-ink: #0a0a0a;
  --rv-accent-text: #c8ff00;
  --rv-accent-soft: color-mix(in srgb, var(--rv-accent) 13%, transparent);
  --rv-accent-border: color-mix(in srgb, var(--rv-accent) 45%, transparent);

  height: 100%; display: flex; flex-direction: column; min-width: 0;
  container-type: inline-size; container-name: rv;
  color: var(--rv-fg); background: var(--rv-bg);
  font-size: 12.5px; line-height: 1.4;
}
.rv-root[data-style='aside'] { --rv-accent: #c8ff00; --rv-accent-ink: #0a0a0a; --rv-accent-text: #c8ff00; }
body.vscode-light .rv-root[data-style='aside'] { --rv-accent-text: #4d6b00; --rv-accent-soft: color-mix(in srgb, var(--rv-accent) 28%, transparent); --rv-accent-border: rgba(77, 107, 0, .5); }
.rv-root[data-style='claude'] { --rv-accent: #D97757; --rv-accent-ink: #1a1a1a; --rv-accent-text: #E8956F; }
body.vscode-light .rv-root[data-style='claude'] { --rv-accent-text: #B4532F; }
.rv-root[data-style='mission'] { --rv-accent: #4FA3F7; --rv-accent-ink: #06101d; --rv-accent-text: #4FA3F7; }
body.vscode-light .rv-root[data-style='mission'] { --rv-accent: #0B6BCB; --rv-accent-ink: #ffffff; --rv-accent-text: #0B6BCB; }
body.vscode-high-contrast .rv-root, body.vscode-high-contrast-light .rv-root {
  --rv-accent: var(--vscode-button-background, var(--vscode-focusBorder));
  --rv-accent-ink: var(--vscode-button-foreground, #fff);
  --rv-accent-text: var(--vscode-textLink-foreground, var(--vscode-foreground));
  --rv-accent-soft: transparent;
  --rv-accent-border: var(--vscode-focusBorder);
  --rv-line: var(--vscode-contrastBorder, currentColor);
  --rv-line-strong: var(--vscode-contrastBorder, currentColor);
  --rv-hover: var(--vscode-list-hoverBackground, transparent);
  --rv-add-bg: transparent; --rv-del-bg: transparent;
  --rv-add-gutter: transparent; --rv-del-gutter: transparent;
}

/* ── interaction defaults: chrome is not text ──
   Nothing but code and real inputs can be selected or shows the I-beam. */
.rv-root, .rv-root * { user-select: none; -webkit-user-select: none; cursor: default; }
.rv-root .rv-code, .rv-root .rv-code *, .rv-root input[type='text'], .rv-root textarea { user-select: text; -webkit-user-select: text; cursor: text; }
.rv-root button:not(:disabled), .rv-root button:not(:disabled) *, .rv-root label, .rv-root label *,
.rv-root .rv-ln, .rv-root .rv-ln * { cursor: pointer; }
.rv-root .rv-empty, .rv-root .rv-empty-row * { cursor: default; }
.rv-root .codicon[class*='codicon-'] { font-size: 14px; line-height: 1; }
.rv-root :focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--rv-accent-text)); outline-offset: -1px; }
.rv-root textarea:focus-visible, .rv-root input[type='text']:focus-visible { outline: none; }
.rv-spacer { flex: 1; min-width: 0; }
.rv-dot { opacity: .5; margin: 0 1px; }
.rv-kbd {
  display: inline-block; min-width: 16px; padding: 0 4px; text-align: center;
  font: 600 10.5px/16px var(--rv-mono);
  border: 1px solid var(--rv-line-strong); border-radius: 4px; background: var(--rv-hover); color: inherit;
}
.rv-add-n { color: var(--rv-add-fg); }
.rv-del-n { color: var(--rv-del-fg); }
.rv-tag {
  font-size: 10px; padding: 0 6px; border-radius: 9px; line-height: 16px;
  color: var(--rv-del-fg); background: color-mix(in srgb, var(--rv-del-fg) 14%, transparent);
}

/* ── buttons ── */
.rv-btn {
  height: 26px; padding: 0 11px; display: inline-flex; align-items: center; gap: 6px; flex: none;
  border-radius: var(--rv-radius); box-shadow: inset 0 0 0 1px var(--rv-line-strong); font-size: 12px; white-space: nowrap;
  transition: background .1s;
}
.rv-btn:hover:not(:disabled) { background: var(--rv-hover); }
.rv-btn-primary { background: var(--rv-accent); color: var(--rv-accent-ink); box-shadow: none; font-weight: 600; }
.rv-btn-primary:hover:not(:disabled) { background: var(--rv-accent); filter: brightness(1.08); }
.rv-btn-primary:disabled { background: transparent; color: var(--rv-dim); box-shadow: inset 0 0 0 1px var(--rv-line-strong); }
.rv-icon-btn {
  width: 24px; height: 24px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 5px; color: var(--rv-dim);
}
.rv-icon-btn:hover:not(:disabled) { background: var(--rv-hover); color: var(--rv-fg); }
.rv-icon-btn:disabled { opacity: .5; }
.rv-icon-btn[aria-pressed='true'] { color: var(--rv-accent-text); }
.rv-icon-btn.rv-danger:hover { color: var(--rv-del-fg); }

/* ── toolbar ── */
.rv-toolbar {
  flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 7px 12px;
  border-bottom: 1px solid var(--rv-line); background: var(--rv-bg);
}
.rv-title { display: flex; align-items: center; gap: 8px; min-width: 0; margin-right: 4px; }
.rv-title-main { font-weight: 600; font-size: 13px; letter-spacing: -.005em; }
.rv-title-label {
  min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 1px 9px; border-radius: 10px; font-size: 11.5px; color: var(--rv-dim); background: var(--rv-hover);
}
.rv-seg { display: inline-flex; flex: none; padding: 2px; gap: 2px; border-radius: 7px; box-shadow: inset 0 0 0 1px var(--rv-line); }
.rv-seg button {
  height: 22px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
  border-radius: 5px; font-size: 12px; color: var(--rv-dim); transition: background .1s, color .1s;
}
.rv-seg button:hover { color: var(--rv-fg); background: var(--rv-hover); }
.rv-seg button.is-on { background: var(--rv-accent-soft); color: var(--rv-accent-text); box-shadow: inset 0 0 0 1px var(--rv-accent-border); }
.rv-tgl {
  height: 26px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px; flex: none;
  border-radius: 7px; font-size: 12px; color: var(--rv-dim); box-shadow: inset 0 0 0 1px var(--rv-line);
}
.rv-tgl:hover { color: var(--rv-fg); background: var(--rv-hover); }
.rv-tgl.is-on { background: var(--rv-accent-soft); color: var(--rv-accent-text); box-shadow: inset 0 0 0 1px var(--rv-accent-border); }
.rv-summary { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: 12px; color: var(--rv-dim); font-variant-numeric: tabular-nums; }
.rv-summary .rv-add-n, .rv-summary .rv-del-n { font-family: var(--rv-mono); font-size: 12px; }
.rv-send {
  height: 28px; padding: 0 12px; display: inline-flex; align-items: center; gap: 7px; flex: none;
  border-radius: 7px; font-size: 12px; font-weight: 600;
  background: var(--rv-accent); color: var(--rv-accent-ink); transition: filter .1s;
}
.rv-send:hover:not(:disabled) { filter: brightness(1.08); }
.rv-send:disabled { background: transparent; color: var(--rv-dim); font-weight: 500; box-shadow: inset 0 0 0 1px var(--rv-line-strong); }
.rv-send .rv-kbd { background: rgba(0, 0, 0, .13); border-color: rgba(0, 0, 0, .22); }
body.vscode-high-contrast .rv-send, body.vscode-high-contrast-light .rv-send { box-shadow: inset 0 0 0 1px var(--vscode-contrastBorder, currentColor); }
@container rv (max-width: 1180px) {
  .rv-summary .rv-dot, .rv-summary .rv-del-n ~ * { display: none; }
  .rv-title-label { max-width: 150px; }
}
@container rv (max-width: 1020px) {
  .rv-seg button span, .rv-tgl span, .rv-title-label { display: none; }
  .rv-seg button { padding: 0 7px; }
  .rv-tgl { padding: 0 7px; }
}
@container rv (max-width: 720px) {
  .rv-summary, .rv-send .rv-kbd { display: none; }
}

/* ── layout ── */
.rv-main { flex: 1; min-height: 0; display: flex; }
.rv-side { flex: none; display: flex; min-width: 0; background: var(--vscode-sideBar-background, var(--rv-surface)); border-right: 1px solid var(--rv-line); }
.rv-resizer { flex: none; width: 5px; margin-left: -3px; z-index: 5; cursor: col-resize !important; transition: background .12s; }
.rv-resizer:hover, .rv-resizer:active { background: var(--rv-accent-border); }
/* No top padding: sticky offsets are measured from the scroller's content box, so padding here would park file headers 12px below the toolbar. */
.rv-scroll { flex: 1; min-width: 0; overflow: auto; position: relative; padding: 0 16px 8px; outline: none; }
.rv-stream { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding-top: 12px; }
.rv-end { padding: 22px 12px 28px; text-align: center; color: var(--rv-dim); font-size: 12px; }
.rv-end .rv-kbd { margin: 0 2px; }

/* ── file tree ── */
.rv-tree { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rv-filter {
  flex: none; margin: 10px 10px 0; height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 4px 0 9px;
  border-radius: 7px; background: var(--vscode-input-background, var(--rv-surface-2)); box-shadow: inset 0 0 0 1px var(--rv-line);
  color: var(--rv-dim); transition: box-shadow .12s;
}
.rv-filter:focus-within { box-shadow: inset 0 0 0 1px var(--rv-accent-text), 0 0 0 3px var(--rv-accent-soft); color: var(--rv-fg); }
.rv-filter input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; outline: none; color: var(--rv-fg); font-size: 12.5px; }
.rv-filter input::placeholder { color: var(--rv-dim); opacity: .8; }
.rv-tree-meta { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 14px 6px; font-size: 11px; color: var(--rv-dim); }
.rv-tree-viewed { display: inline-flex; align-items: center; gap: 3px; }
.rv-tree-list { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 12px; }
.rv-tree-empty { padding: 14px 10px; color: var(--rv-dim); font-size: 12px; }
.rv-trow {
  width: 100%; display: flex; align-items: flex-start; gap: 6px; text-align: left;
  padding-top: 3px; padding-bottom: 3px; padding-right: 8px; border-radius: 5px; min-height: 26px;
  font-size: 12.5px; line-height: 18px; position: relative;
}
.rv-trow:hover { background: var(--rv-hover); }
.rv-trow .codicon { margin-top: 2px; }
.rv-trow-dir { color: var(--rv-dim); }
.rv-trow-dir .rv-chev { flex: none; }
.rv-trow-dir:hover { color: var(--rv-fg); }
.rv-tname { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.rv-tname-file { color: var(--rv-fg); }
.rv-tmeta { flex: none; font-size: 11px; opacity: .7; }
.rv-trow-file .rv-st { margin-top: 1px; }
.rv-trow .rv-counts { margin-top: 1px; }
.rv-trow-file.is-active { background: var(--rv-accent-soft); }
.rv-trow-file.is-active::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px; border-radius: 2px; background: var(--rv-accent-text); }
body.vscode-high-contrast .rv-trow-file.is-active, body.vscode-high-contrast-light .rv-trow-file.is-active { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
.rv-trow-file.is-viewed .rv-tname, .rv-trow-file.is-viewed .rv-st { opacity: .5; }
.rv-tcheck { color: var(--rv-add-fg); margin-top: 2px; flex: none; }

/* ── status pill, counts, comment badge ── */
.rv-st {
  flex: none; width: 17px; height: 17px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px; font: 700 10px/1 var(--rv-mono);
  color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 32%, transparent);
}
.rv-st-A { --c: var(--rv-add-fg); } .rv-st-M { --c: var(--rv-mod-fg); } .rv-st-D { --c: var(--rv-del-fg); } .rv-st-R { --c: var(--rv-ren-fg); }
.rv-counts { display: inline-flex; gap: 6px; flex: none; font: 11.5px/18px var(--rv-mono); font-variant-numeric: tabular-nums; }
.rv-cbadge {
  flex: none; display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px; border-radius: 9px;
  font-size: 11px; font-weight: 600; background: var(--rv-accent-soft); color: var(--rv-accent-text); box-shadow: inset 0 0 0 1px var(--rv-accent-border);
}
.rv-cbadge .codicon { font-size: 11px !important; margin: 0 !important; }

/* ── file card ── */
.rv-file { border: 1px solid var(--rv-line); border-radius: 9px; overflow: clip; background: var(--rv-bg); min-width: 0; }
.rv-fh {
  position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 5px 10px 5px 6px;
  background: var(--rv-surface); border-bottom: 1px solid var(--rv-line);
}
.rv-file.is-closed .rv-fh { border-bottom-color: transparent; }
.rv-fh-path { min-width: 0; flex: 0 1 auto; display: inline; text-align: left; font-family: var(--rv-mono); font-size: 12.5px; line-height: 1.35; overflow-wrap: anywhere; }
.rv-dir { color: var(--rv-dim); }
.rv-name { font-weight: 600; color: var(--rv-fg); }
.rv-from { display: inline-flex; align-items: center; gap: 4px; min-width: 0; color: var(--rv-dim); font: 11.5px var(--rv-mono); overflow-wrap: anywhere; }
.rv-viewed { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--rv-dim); flex: none; }
.rv-viewed:hover { background: var(--rv-hover); color: var(--rv-fg); }
.rv-viewed input { accent-color: var(--rv-accent); width: 14px; height: 14px; margin: 0; }
.rv-file.is-viewed .rv-viewed { color: var(--rv-accent-text); }
.rv-file.is-viewed .rv-fh-path { opacity: .7; }
.rv-fb { min-width: 0; }
.rv-skeleton {
  background: repeating-linear-gradient(to bottom, transparent 0, transparent 7px, color-mix(in srgb, var(--rv-fg) 5%, transparent) 7px, color-mix(in srgb, var(--rv-fg) 5%, transparent) 13px, transparent 13px, transparent 20px);
}
.rv-note { display: flex; align-items: center; gap: 10px; padding: 14px 16px; color: var(--rv-dim); font-size: 12.5px; }
.rv-note-heavy .rv-btn { margin-left: auto; }
.rv-more { display: flex; justify-content: center; padding: 10px; border-top: 1px solid var(--rv-line); background: var(--rv-surface); }

/* ── lines ── */
.rv-body { --lnw: 52px; }
.rv-pane { overflow-x: auto; overflow-y: hidden; container-type: inline-size; min-width: 0; }
.rv-lines {
  width: max-content; min-width: 100%;
  font-family: var(--rv-mono); font-size: var(--rv-code-size); line-height: var(--rv-lh); tab-size: 4;
}
.rv-body.is-wrap .rv-lines { width: 100%; }
.rv-row { display: flex; min-height: var(--rv-lh); }
.rv-ln {
  flex: none; width: var(--lnw); position: sticky; left: 0; z-index: 1; padding: 0 9px 0 0; text-align: right;
  color: var(--rv-ln-fg); font-size: calc(var(--rv-code-size) - 1px); background: var(--rv-bg); font-variant-numeric: tabular-nums;
}
.rv-ln-2 { left: var(--lnw); }
.rv-code { flex: 1 0 auto; position: relative; padding: 0 18px 0 26px; white-space: pre; }
.rv-body.is-wrap .rv-code { flex: 1 1 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.rv-code::before { content: attr(data-sign); position: absolute; left: 8px; opacity: .55; user-select: none; }

.rv-add > .rv-code, .rv-code.rv-add { background-color: var(--rv-add-bg); }
.rv-del > .rv-code, .rv-code.rv-del { background-color: var(--rv-del-bg); }
.rv-add > .rv-ln, .rv-ln.rv-add { background: linear-gradient(var(--rv-add-gutter), var(--rv-add-gutter)), linear-gradient(var(--rv-add-gutter), var(--rv-add-gutter)), var(--rv-bg); color: var(--rv-add-fg); }
.rv-del > .rv-ln, .rv-ln.rv-del { background: linear-gradient(var(--rv-del-gutter), var(--rv-del-gutter)), linear-gradient(var(--rv-del-gutter), var(--rv-del-gutter)), var(--rv-bg); color: var(--rv-del-fg); }
.rv-add > .rv-ln, .rv-del > .rv-ln, .rv-ln.rv-add, .rv-ln.rv-del { color-scheme: normal; }
/* Layered twice: the theme's word colour is tuned for the editor's own line colour and reads faint over ours. */
.rv-w { background: linear-gradient(var(--rv-add-word), var(--rv-add-word)), var(--rv-add-word); border-radius: 3px; }
.rv-del .rv-w { background: linear-gradient(var(--rv-del-word), var(--rv-del-word)), var(--rv-del-word); }
body.vscode-high-contrast .rv-w, body.vscode-high-contrast-light .rv-w { background: none; outline: 1px solid var(--vscode-contrastActiveBorder, currentColor); }
body.vscode-high-contrast .rv-add > .rv-code::before, body.vscode-high-contrast-light .rv-add > .rv-code::before { opacity: 1; color: var(--rv-add-fg); }
body.vscode-high-contrast .rv-del > .rv-code::before, body.vscode-high-contrast-light .rv-del > .rv-code::before { opacity: 1; color: var(--rv-del-fg); }
.rv-row:hover > .rv-code:not(.rv-empty) { background-image: linear-gradient(var(--rv-hover), var(--rv-hover)); }
.rv-empty {
  background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--rv-fg) 9%, transparent) 5px 6px) !important;
}
.rv-empty::before { content: none; }

/* the "+" that appears in the gutter where a click would comment */
.rv-plus::before {
  content: '+'; position: absolute; left: 6px; top: calc((var(--rv-lh) - 16px) / 2); width: 16px; height: 16px; border-radius: 4px;
  background: var(--rv-accent); color: var(--rv-accent-ink); font: 700 14px/16px var(--vscode-font-family); text-align: center;
  opacity: 0; transform: scale(.85); transition: opacity .08s, transform .08s; pointer-events: none;
}
.rv-row:hover > .rv-plus::before, .rv-row:hover .rv-plus::before, .rv-cursor.rv-plus::before, .rv-cursor > .rv-plus::before { opacity: 1; transform: none; }
.rv-ln-2.rv-plus::before { left: 6px; }
.rv-ln-1.rv-plus::before { left: 6px; }

.rv-row.has-cm > .rv-ln:first-child, .rv-ln.has-cm { box-shadow: inset 3px 0 0 var(--rv-accent); }
.rv-cursor > .rv-code, .rv-cursor.rv-code { background-image: linear-gradient(var(--rv-accent-soft), var(--rv-accent-soft)); }
.rv-cursor > .rv-ln:first-child, .rv-cursor > .rv-ln-1 { box-shadow: inset 2px 0 0 var(--rv-accent-text); }

/* hunk header: a quiet separator, not a banner */
.rv-hunk {
  position: sticky; left: 0; width: 100cqw; height: 26px; display: flex; align-items: center; scroll-margin-top: 44px;
  border-top: 1px solid var(--rv-line); border-bottom: 1px solid var(--rv-line);
  background: color-mix(in srgb, var(--rv-fg) 3%, var(--rv-bg)); color: var(--rv-dim);
  font-family: var(--rv-mono); font-size: calc(var(--rv-code-size) - 1.5px);
}
.rv-lines > .rv-hunk:first-child { border-top: 0; }
.rv-hunk-in { display: flex; gap: 12px; padding: 0 14px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rv-hunk-range { flex: none; opacity: .75; }
.rv-hunk-ctx { min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: .95; }

/* split */
.rv-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.rv-split > .rv-pane + .rv-pane { border-left: 1px solid var(--rv-line-strong); }
.rv-split .rv-ln { left: 0; width: var(--lnw); }
.rv-split-wrap .rv-pair > .rv-ln { position: static; }
.rv-split-wrap .rv-pair > .rv-ln:nth-child(3) { border-left: 1px solid var(--rv-line-strong); }
.rv-split-wrap .rv-code { flex: 1 1 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.rv-split-wrap .rv-pair > .rv-ln.rv-plus { position: relative; }
.rv-pair-cm { display: flex; }
.rv-pair-half { flex: 1 1 0; min-width: 0; }
.rv-pair-half + .rv-pair-half { border-left: 1px solid var(--rv-line-strong); }
.rv-pair-half .rv-cm { position: static; width: auto; }
.rv-filler { background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--rv-fg) 8%, transparent) 5px 6px); }

/* ── comments ── */
.rv-cm { position: sticky; left: 0; width: 100cqw; padding: 8px 14px 10px; background: var(--rv-bg); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; z-index: 2; }
.rv-card {
  border-radius: 9px; background: var(--rv-surface); box-shadow: inset 0 0 0 1px var(--rv-line-strong); overflow: hidden;
  transition: box-shadow .12s;
}
/* Editing: the card stays neutral — the accent is the input's alone, and only
   while it has focus. Two accent outlines (card + input) read as noise. */
.rv-card.is-editing { box-shadow: inset 0 0 0 1px var(--rv-line-strong); }
.rv-card:not(.is-editing) { box-shadow: inset 2px 0 0 var(--rv-accent), inset 0 0 0 1px var(--rv-line); }
.rv-card-head { display: flex; align-items: center; gap: 8px; padding: 6px 6px 0 10px; min-height: 30px; }
.rv-card-loc { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font: 11.5px var(--rv-mono); color: var(--rv-dim); }
.rv-card-loc .codicon { color: var(--rv-accent-text); flex: none; }
.rv-card-loc:hover { color: var(--rv-fg); }
.rv-card-loc:hover .rv-card-path { text-decoration: underline; }
.rv-card-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-card-line { flex: none; color: var(--rv-fg); font-weight: 600; margin-left: -4px; }
.rv-card-actions { display: inline-flex; align-items: center; gap: 2px; }
.rv-confirm { height: 22px; padding: 0 8px; border-radius: 5px; font-size: 11.5px; font-weight: 600; color: #fff; background: var(--vscode-errorForeground, #f14c4c); }
.rv-card-body { padding: 2px 12px 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.rv-input {
  display: block; width: calc(100% - 20px); min-height: 56px; margin: 4px 10px 0; padding: 8px 10px; resize: none; overflow: auto;
  border: 0; border-radius: 7px; outline: none; font: 13px/1.45 var(--vscode-font-family);
  color: var(--vscode-input-foreground, var(--rv-fg)); background: var(--vscode-input-background, var(--rv-bg));
  box-shadow: inset 0 0 0 1px var(--rv-line-strong); transition: box-shadow .12s;
}
.rv-input:focus { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rv-accent-text) 50%, var(--rv-line-strong)); }
.rv-input::placeholder { color: var(--rv-dim); opacity: .85; }
.rv-card-foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px 10px; }
.rv-hint { font-size: 11.5px; color: var(--rv-dim); display: inline-flex; align-items: center; gap: 4px; min-width: 0; }

/* ── states ── */
.rv-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 72px 24px; text-align: center; color: var(--rv-dim); font-size: 13px; }
.rv-state p { max-width: 640px; overflow-wrap: anywhere; color: var(--rv-fg); }
.rv-state .rv-state-icon { font-size: 30px !important; color: var(--rv-dim); }
.rv-shimmer { height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--rv-hover), var(--rv-surface-2), var(--rv-hover)); background-size: 200% 100%; animation: rv-shimmer 1.4s ease-in-out infinite; }
@keyframes rv-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.rv-spin { animation: rv-spin 1s linear infinite; }
@keyframes rv-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rv-shimmer, .rv-spin { animation: none; } }

.rv-toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 30; max-width: min(560px, calc(100vw - 32px));
  padding: 9px 14px; border-radius: 9px; font-size: 12.5px;
  background: var(--vscode-notifications-background, var(--rv-surface-2)); color: var(--vscode-notifications-foreground, var(--rv-fg));
  box-shadow: inset 0 0 0 1px var(--rv-line-strong), 0 6px 22px rgba(0, 0, 0, .35);
}
.rv-pop {
  position: fixed; top: 48px; right: 12px; z-index: 25; width: 330px; padding: 12px 14px 14px; border-radius: 10px;
  background: var(--vscode-editorWidget-background, var(--rv-surface-2)); box-shadow: inset 0 0 0 1px var(--rv-line-strong), 0 10px 30px rgba(0, 0, 0, .4);
}
.rv-pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.rv-pop dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; align-items: center; }
.rv-pop dt { display: flex; gap: 4px; }
.rv-pop dd { font-size: 12px; color: var(--rv-dim); }
.rv-backdrop { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .5); }
.rv-dialog {
  width: min(400px, calc(100vw - 32px)); padding: 16px; border-radius: 12px;
  background: var(--vscode-editorWidget-background, var(--rv-bg)); box-shadow: inset 0 0 0 1px var(--rv-line-strong), 0 20px 50px rgba(0, 0, 0, .5);
}
.rv-dialog h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.rv-opt {
  width: 100%; display: flex; align-items: center; gap: 12px; text-align: left; padding: 10px 12px; margin-bottom: 8px;
  border-radius: 9px; box-shadow: inset 0 0 0 1px var(--rv-line); transition: background .1s, box-shadow .1s;
}
.rv-opt:hover:not(:disabled), .rv-opt:focus-visible { background: var(--rv-accent-soft); box-shadow: inset 0 0 0 1px var(--rv-accent-border); outline: none; }
.rv-opt:disabled { opacity: .45; }
.rv-opt > .codicon { font-size: 16px !important; color: var(--rv-accent-text); flex: none; }
.rv-opt-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rv-opt-text strong { font-size: 13px; }
.rv-opt-text span { font-size: 11.5px; color: var(--rv-dim); }
.rv-dialog-cancel { width: 100%; justify-content: center; box-shadow: none; color: var(--rv-dim); }
`;
