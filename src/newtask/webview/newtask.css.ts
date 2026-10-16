/**
 * Styles for the new-task composer.
 *
 * The page wears the sidebar style's accent: lime for Aside, terracotta for
 * Claude, the theme's button blue for Mission control. Everything else follows
 * the VS Code theme, except Aside, which paints its own near-black / near-white
 * palette in dark and light themes like the sidebar does (high contrast steps
 * aside everywhere, since a fixed palette cannot promise the contrast those
 * themes exist for).
 */
export const NEWTASK_CSS = `
html, body { background: var(--vscode-editor-background); }

.nt {
  --nt-bg: var(--vscode-editor-background);
  --nt-fg: var(--vscode-foreground);
  --nt-dim: var(--vscode-descriptionForeground, color-mix(in srgb, var(--nt-fg) 70%, transparent));
  --nt-faint: color-mix(in srgb, var(--nt-fg) 55%, transparent);
  --nt-card: color-mix(in srgb, var(--nt-fg) 4%, var(--nt-bg));
  --nt-border: color-mix(in srgb, var(--nt-fg) 15%, transparent);
  --nt-hover: color-mix(in srgb, var(--nt-fg) 9%, transparent);
  --nt-pop: var(--vscode-editorWidget-background, var(--nt-bg));
  --nt-pop-border: var(--vscode-editorWidget-border, var(--nt-border));
  --nt-error: var(--vscode-errorForeground, #f14c4c);
  --nt-sans: var(--vscode-font-family);
  --nt-mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
  --nt-radius: 10px; --nt-chip-radius: 6px; --nt-btn-radius: 8px;
  --nt-accent: var(--vscode-button-background, #0e639c);
  --nt-accent-ink: var(--vscode-button-foreground, #fff);
  --nt-accent-text: var(--vscode-textLink-foreground, var(--nt-fg));
  --nt-ring: var(--nt-accent-text);

  height: 100%; overflow-y: auto;
  background: var(--nt-bg); color: var(--nt-fg);
  font-family: var(--nt-sans); font-size: var(--vscode-font-size, 13px);
}

/* ── the three accents ── */
.nt-aside {
  --nt-bg: #111111; --nt-fg: #fafafa; --nt-dim: #a3a3a3; --nt-faint: #8a8a8a;
  --nt-card: #171717; --nt-border: #2a2a2a; --nt-hover: rgba(255, 255, 255, 0.07);
  --nt-pop: #1a1a1a; --nt-pop-border: #333333;
  --nt-error: #f07167;
  --nt-radius: 6px; --nt-chip-radius: 4px; --nt-btn-radius: 4px;
  --nt-accent: #c8ff00; --nt-accent-ink: #0a0a0a; --nt-accent-text: #c8ff00;
}
body.vscode-light .nt-aside {
  --nt-bg: #fafafa; --nt-fg: #0a0a0a; --nt-dim: #525252; --nt-faint: #6b6b6b;
  --nt-card: #ffffff; --nt-border: #e0e0e0; --nt-hover: rgba(0, 0, 0, 0.06);
  --nt-pop: #ffffff; --nt-pop-border: #d4d4d4;
  --nt-error: #dc2626;
  /* Lime is a fill on light, never text or a ring: it has no contrast against white. */
  --nt-accent-text: #4d6b00;
}
.nt-claude {
  --nt-radius: 12px; --nt-chip-radius: 8px; --nt-btn-radius: 9px;
  --nt-accent: #D97757; --nt-accent-ink: #1A1A1A; --nt-accent-text: #E8956F;
}
body.vscode-light .nt-claude { --nt-accent-text: #B4532F; }
.nt-mission {
  --nt-radius: 8px; --nt-chip-radius: 5px; --nt-btn-radius: 6px;
  --nt-accent: var(--vscode-button-background, #0e639c);
  --nt-accent-ink: var(--vscode-button-foreground, #fff);
  --nt-accent-text: #4FA3F7; --nt-ring: var(--vscode-focusBorder, #4FA3F7);
}
body.vscode-light .nt-mission { --nt-accent-text: #0B6BCB; }

body.vscode-high-contrast .nt, body.vscode-high-contrast-light .nt {
  --nt-bg: var(--vscode-editor-background); --nt-fg: var(--vscode-foreground);
  --nt-dim: var(--vscode-foreground); --nt-faint: var(--vscode-foreground);
  --nt-card: var(--vscode-editor-background);
  --nt-border: var(--vscode-contrastBorder, currentColor);
  --nt-pop: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --nt-pop-border: var(--vscode-contrastBorder, currentColor);
  --nt-hover: var(--vscode-list-hoverBackground, transparent);
  --nt-error: var(--vscode-errorForeground, #f48771);
  --nt-accent: var(--vscode-button-background); --nt-accent-ink: var(--vscode-button-foreground);
  --nt-accent-text: var(--vscode-textLink-foreground, var(--vscode-foreground));
  --nt-ring: var(--vscode-focusBorder);
}

/* ── layout ── */
.nt-col { max-width: 720px; margin: 0 auto; padding: clamp(28px, 11vh, 112px) 24px 48px; }
@media (max-width: 520px) { .nt-col { padding-left: 14px; padding-right: 14px; } }
.nt-title { font-size: 22px; font-weight: 600; letter-spacing: -.012em; line-height: 1.25; color: var(--nt-fg); }
.nt-title-input {
  display: block; width: 100%; margin: 0 0 0 -6px; padding: 2px 6px;
  border: 1px solid transparent; border-radius: var(--nt-chip-radius); outline: none;
  background: transparent; color: inherit; font: inherit; letter-spacing: inherit;
}
.nt-title-input::placeholder { color: var(--nt-fg); opacity: .55; }
.nt-title-input:hover { border-color: var(--nt-border, var(--nt-hover)); }
.nt-title-input:focus { border-color: var(--nt-ring); }
.nt-sub { margin-top: 6px; color: var(--nt-dim); font-size: 13px; line-height: 1.5; }

/* ── the composer card ── */
.nt-card {
  margin-top: 24px;
  background: var(--nt-card); border: 1px solid var(--nt-border); border-radius: var(--nt-radius);
  transition: border-color .12s, box-shadow .12s;
}
.nt-card:hover { border-color: color-mix(in srgb, var(--nt-fg) 26%, transparent); }
.nt-card:focus-within {
  border-color: var(--nt-ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nt-ring) 20%, transparent);
}
body.vscode-high-contrast .nt-card:focus-within, body.vscode-high-contrast-light .nt-card:focus-within { box-shadow: none; outline: 1px solid var(--nt-ring); }

.nt-text {
  display: block; width: 100%; resize: none; overflow-y: auto;
  min-height: calc(5 * 1.6em + 28px); max-height: 60vh;
  padding: 16px 18px 12px; border: 0; outline: none; background: transparent;
  font: inherit; font-size: 14px; line-height: 1.6; color: var(--nt-fg);
  caret-color: var(--nt-accent-text);
}
.nt-text::placeholder { color: var(--nt-faint); opacity: 1; }

.nt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 2px; padding: 6px 8px 8px 10px; }
.nt-anchor { position: relative; display: inline-flex; align-items: center; }
.nt-spacer { flex: 1; min-width: 4px; }

.nt-chip {
  height: 28px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  border: 1px solid transparent; border-radius: var(--nt-chip-radius);
  background: transparent; color: var(--nt-dim); font: inherit; font-size: 12px; white-space: nowrap;
  cursor: pointer; transition: background .1s, color .1s;
}
.nt-chip:hover:not(:disabled), .nt-chip[aria-expanded='true'] { background: var(--nt-hover); color: var(--nt-fg); }
.nt-chip:disabled { cursor: default; opacity: .6; }
.nt-chip:focus-visible, .nt-send:focus-visible, .nt-link:focus-visible, .nt-reset:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--nt-ring)); outline-offset: 1px; }
.nt-chip .codicon { font-size: 13px; }
.nt-chip .nt-chev { font-size: 10px; opacity: .7; }
.nt-mono { font-family: var(--nt-mono); }
.nt-chip-label { overflow: hidden; text-overflow: ellipsis; max-width: 28ch; }
.nt-placeholder { color: var(--nt-faint); }
.nt-chip[data-dim] { opacity: .6; }
.nt-chip[aria-invalid='true'] { color: var(--nt-error); }
.nt-mark { display: inline-flex; }

.nt-branch-edit {
  height: 28px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  border: 1px solid var(--nt-ring); border-radius: var(--nt-chip-radius);
  background: var(--nt-bg); color: var(--nt-dim);
}
.nt-branch-edit .codicon { font-size: 13px; }
.nt-branch-edit[data-invalid] { border-color: var(--nt-error); }
.nt-branch-input {
  height: 100%; padding: 0; min-width: 12ch; max-width: 100%;
  border: 0; outline: none; background: transparent;
  color: var(--nt-fg); font-family: var(--nt-mono); font-size: 12px;
}
.nt-reset {
  width: 20px; height: 20px; margin-left: -2px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--nt-chip-radius); background: transparent; color: var(--nt-faint); cursor: pointer;
}
.nt-reset:hover { background: var(--nt-hover); color: var(--nt-fg); }
.nt-reset .codicon { font-size: 12px; }
.nt-inline-error { display: inline-flex; align-items: center; gap: 5px; margin: 0 6px; color: var(--nt-error); font-size: 12px; }
.nt-inline-error .codicon { font-size: 13px; }

.nt-send {
  width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: var(--nt-btn-radius);
  background: var(--nt-accent); color: var(--nt-accent-ink); cursor: pointer;
  transition: filter .1s, background .1s, color .1s;
}
.nt-send .codicon { font-size: 16px; }
.nt-send:hover:not(:disabled) { filter: brightness(1.1); }
/* Muted, not erased: it has to read as "not yet", not as "not there". */
.nt-send:disabled {
  cursor: not-allowed;
  background: color-mix(in srgb, var(--nt-fg) 10%, transparent);
  color: color-mix(in srgb, var(--nt-fg) 42%, transparent);
  border-color: color-mix(in srgb, var(--nt-fg) 12%, transparent);
}
.nt-send[aria-busy='true']:disabled { cursor: progress; background: var(--nt-accent); color: var(--nt-accent-ink); opacity: .75; border-color: transparent; }
body.vscode-high-contrast .nt-send, body.vscode-high-contrast-light .nt-send { border-color: var(--vscode-contrastBorder, currentColor); }

/* ── popovers ── */
.nt-pop {
  position: absolute; z-index: 20; top: calc(100% + 4px); left: 0;
  min-width: 220px; max-width: min(380px, 86vw); padding: 4px;
  background: var(--nt-pop); color: var(--nt-fg);
  border: 1px solid var(--nt-pop-border); border-radius: calc(var(--nt-chip-radius) + 2px);
  box-shadow: 0 6px 18px var(--vscode-widget-shadow, rgba(0, 0, 0, .35));
  outline: none;
}
.nt-pop-up { top: auto; bottom: calc(100% + 4px); }
.nt-search {
  width: 100%; height: 28px; margin-bottom: 4px; padding: 0 8px;
  border: 0; border-bottom: 1px solid var(--nt-border); border-radius: 0; outline: none;
  background: transparent; color: var(--nt-fg); font: inherit; font-size: 12px;
}
.nt-search::placeholder { color: var(--nt-faint); }
.nt-list { max-height: 240px; overflow-y: auto; }
.nt-opt {
  min-height: 26px; padding: 0 8px; display: flex; align-items: center; gap: 8px;
  border-radius: var(--nt-chip-radius); font-size: 12px; cursor: pointer;
}
.nt-opt[data-active] { background: var(--nt-hover); }
.nt-opt[data-dim] { opacity: .55; }
.nt-opt-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt-opt-hint { color: var(--nt-faint); font-size: 11px; }
.nt-opt .codicon-check { font-size: 12px; color: var(--nt-accent-text); }
.nt-empty { padding: 8px; color: var(--nt-faint); font-size: 12px; }

/* ── below the card ── */
.nt-note { margin-top: 12px; padding: 0 4px; color: var(--nt-dim); font-size: 12px; line-height: 1.6; }
.nt-note code {
  display: inline-block; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
  font-family: var(--nt-mono); color: var(--nt-fg); font-size: 11.5px;
}
.nt-warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.nt-link { border: 0; padding: 0; background: none; color: var(--nt-accent-text); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.nt-failure {
  margin-top: 12px; padding: 9px 12px; display: flex; align-items: flex-start; gap: 8px;
  border: 1px solid color-mix(in srgb, var(--nt-error) 45%, transparent); border-radius: var(--nt-chip-radius);
  background: color-mix(in srgb, var(--nt-error) 9%, transparent); color: var(--nt-fg); font-size: 12px; line-height: 1.5;
  user-select: text;
}
.nt-failure .codicon { color: var(--nt-error); margin-top: 1px; }
`;
