import { ASIDE_CSS } from '../../webview/styles/aside/aside.css';
import { CLAUDE_CSS } from '../../webview/styles/claude/claude.css';
import { MISSION_CSS } from '../../webview/styles/mission/mission.css';

/**
 * The settings page wears the sidebar's palette: the root carries `fm-<style>`,
 * so the `--fm-*` variables the sidebar layouts define (accent, radius,
 * borders, light/dark/high-contrast) are the ones this page reads. Only what a
 * form needs on top — the ink on the accent, the focus ring, field surfaces —
 * is defined here.
 */
export const SETTINGS_CSS = ASIDE_CSS + CLAUDE_CSS + MISSION_CSS + `
body { background: var(--vscode-editor-background); overflow: hidden; }

.st {
  --st-accent: var(--fm-accent);
  --st-accent-text: var(--fm-accent-text, var(--fm-accent));
  --st-ink: #0a0a0a;
  --st-ring: var(--fm-accent);
  --st-page: var(--vscode-editor-background);
  --st-nav: var(--fm-bg);
  --st-card: color-mix(in srgb, var(--vscode-foreground) 3%, var(--st-page));
  --st-field: var(--vscode-input-background, color-mix(in srgb, var(--vscode-foreground) 6%, var(--st-page)));
  --st-field-border: var(--vscode-input-border, var(--fm-border-strong));
  --st-line: var(--fm-border);
  --st-dim: var(--fm-text-dim);
  --st-faint: var(--fm-text-faint);
  --st-r: var(--fm-radius, 6px);
  --st-rb: var(--fm-btn-radius, 6px);

  display: grid; grid-template-columns: 236px minmax(0, 1fr); height: 100vh;
  background: var(--st-page); color: var(--vscode-foreground);
  font-family: var(--fm-sans); font-size: var(--vscode-font-size, 13px); line-height: 1.45;
}
.st.fm-claude { --st-ink: #1a1a1a; }
.st.fm-mission { --st-ink: #06121f; }
body.vscode-light .st.fm-mission { --st-ink: #ffffff; }
/* Lime on white is a poor ring; the style's dark-lime text colour is the readable one. */
body.vscode-light .st.fm-aside { --st-ring: var(--fm-accent-text); }
.st.fm-aside { --st-nav: color-mix(in srgb, var(--fm-bg) 100%, transparent); }
body.vscode-high-contrast .st, body.vscode-high-contrast-light .st {
  --st-ring: var(--vscode-focusBorder);
  --st-nav: var(--vscode-editor-background);
  --st-card: transparent;
  --st-field: var(--vscode-input-background);
  --st-field-border: var(--vscode-contrastBorder, currentColor);
  --st-line: var(--vscode-contrastBorder, currentColor);
}

/* An app-like panel: its labels are not text to select, and the I-beam belongs to the fields only. */
.st { user-select: none; -webkit-user-select: none; cursor: default; }
.st input, .st textarea, .st [contenteditable='true'] { user-select: text; -webkit-user-select: text; cursor: text; }
.st select, .st input[type='checkbox'], .st input[type='radio'], .st button, .st summary, .st label[for], .st .st-pick, .st .st-style { cursor: pointer; }
.st button:disabled { cursor: default; }
/* The install command is there to be copied. */
.st .st-install { user-select: all; -webkit-user-select: all; cursor: text; }

.st code, .st .mono { font-family: var(--fm-mono); }
.st h1, .st h2, .st h3, .st p, .st ul { margin: 0; padding: 0; list-style: none; }
:where(.st) button { font: inherit; color: inherit; }
.st :focus-visible { outline: 2px solid var(--st-ring); outline-offset: 2px; }
.st .codicon { font-size: 14px; }

/* ── nav ── */
.st-nav {
  display: flex; flex-direction: column; gap: 4px; min-height: 0; overflow-y: auto;
  padding: 14px 10px 12px; background: var(--st-nav); border-right: 1px solid var(--st-line);
}
.st-brand { display: flex; align-items: center; gap: 9px; padding: 2px 8px 16px; }
.st-mark { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border-radius: var(--st-rb); background: var(--st-accent); color: var(--st-ink); }
.st-brand-name { font-weight: 600; letter-spacing: -.01em; }
.st-brand-sub { color: var(--st-faint); }
.st-navlist { display: flex; flex-direction: column; gap: 2px; }
.st-navitem {
  position: relative; height: 32px; display: flex; align-items: center; gap: 10px; padding: 0 10px; width: 100%;
  border: 0; border-radius: var(--st-rb); background: transparent; color: var(--st-dim); text-align: left;
  transition: background .1s, color .1s;
}
.st-navitem:hover { background: var(--fm-hover); color: var(--vscode-foreground); }
.st-navitem[aria-current='page'] { background: var(--fm-accent-soft); color: var(--vscode-foreground); }
.st-navitem[aria-current='page'] .codicon:first-child { color: var(--st-accent-text); }
.st-navitem[aria-current='page']::before { content: ''; position: absolute; left: -10px; top: 7px; bottom: 7px; width: 3px; border-radius: 0 3px 3px 0; background: var(--st-accent); }
.st-navlabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--st-accent); }
.st-dot[data-kind='error'] { background: var(--fm-bad); }
.st-legend { margin-top: auto; padding: 14px 8px 0; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--st-line); }
.st-legend-title { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--st-faint); }
.st-legend-item { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 8px; align-items: start; color: var(--st-dim); }
.st-legend-item .codicon { margin-top: 2px; }
.st-legend-item strong { font-weight: 500; color: var(--vscode-foreground); }
.st-legend-item small { display: block; font-size: 11.5px; color: var(--st-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-legend-item[data-state='missing'] small { font-style: italic; }

.st-link { display: block; margin-top: 2px; padding: 0; border: 0; background: none; font-size: 11.5px; color: var(--st-accent-text); text-align: left; }
.st-link:hover { text-decoration: underline; }

/* ── main ── */
.st-main { min-width: 0; min-height: 0; overflow-y: auto; scroll-padding-bottom: 96px; display: flex; flex-direction: column; }
.st-content { width: 100%; flex: 1 0 auto; max-width: 780px; margin: 0 auto; padding: 32px 40px 24px; display: flex; flex-direction: column; gap: 16px; }
.st-head { padding-bottom: 6px; }
.st-head h2 { font-size: 20px; font-weight: 600; letter-spacing: -.015em; }
.st-head p { margin-top: 4px; color: var(--st-dim); }

.st-head-scopes { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--st-dim); }
.st-head-scopes li { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.st-head-scopes .codicon { font-size: 13px; }
.st-head-scopes li:first-child .codicon { color: var(--st-accent-text); }
.st-head-scopes strong { font-weight: 500; color: var(--vscode-foreground); }
.st-head-scopes code { font-size: 11.5px; padding: 1px 6px; border-radius: 4px; background: var(--fm-hover); border: 1px solid var(--st-line); color: var(--vscode-foreground); }

/* ── cards ── */
.st-card { background: var(--st-card); border: 1px solid var(--st-line); border-radius: calc(var(--st-r) + 2px); }
.st-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 18px 0; }
.st-card-titles h3 { font-size: 13px; font-weight: 600; }
.st-card-titles p { margin-top: 2px; color: var(--st-dim); font-size: 12px; }
.st-card-body { padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 16px; }
.st-card-body > .st-row { margin-left: -18px; margin-right: -18px; padding-left: 18px; padding-right: 18px; }
.st-card-body > .st-row + .st-row { margin-top: -4px; }
.st-scope {
  flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; margin-top: 1px;
  border: 1px solid var(--st-line); border-radius: 999px; font-size: 11px; color: var(--st-dim); white-space: nowrap;
}
.st-scope .codicon { font-size: 12px; }
.st-scope[data-scope='repo'] .codicon { color: var(--st-accent-text); }

/* ── rows & fields ── */
.st-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-top: 12px; padding-bottom: 12px; border-top: 1px solid var(--st-line); }
.st-card-body > .st-row:first-child { border-top: 0; padding-top: 0; }
.st-card-body > .st-row:last-child { padding-bottom: 0; }
.st-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; cursor: pointer; }
.st-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
.st-grid.one { grid-template-columns: minmax(0, 1fr); }
.st-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.st-label { font-weight: 500; color: var(--vscode-foreground); }
.st-note { font-size: 12px; color: var(--st-dim); line-height: 1.4; }
.st-note-bad { color: var(--fm-bad); }
body.vscode-light .st-note-bad { color: color-mix(in srgb, var(--fm-bad) 85%, #000); }

.st-input {
  width: 100%; height: 32px; padding: 0 10px; border-radius: var(--st-rb);
  background: var(--st-field); color: var(--vscode-input-foreground, var(--vscode-foreground));
  border: 1px solid var(--st-field-border); font: inherit; outline: none;
  transition: border-color .12s, box-shadow .12s;
}
.st-input.mono { font-family: var(--fm-mono); font-size: 12px; }
.st-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--st-faint)); }
.st-input:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 35%, transparent); }
.st-input:focus { border-color: var(--st-ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-ring) 24%, transparent); }
.st-input[aria-invalid='true'] { border-color: var(--fm-bad); }
.st-input[aria-invalid='true']:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--fm-bad) 24%, transparent); }
body.vscode-high-contrast .st-input:focus, body.vscode-high-contrast-light .st-input:focus { box-shadow: none; outline: 1px solid var(--st-ring); }
.st-input-short { max-width: 200px; }
textarea.st-input { height: auto; padding: 10px 12px; line-height: 1.6; resize: vertical; tab-size: 2; }
.st-select { position: relative; display: block; }
.st-field > .st-select { max-width: 400px; }
.st-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.st-select select { appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer; }
.st-select .codicon { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--st-dim); }
.st-filerow { display: flex; gap: 8px; align-items: center; }
.st-filerow .st-input { flex: 1; min-width: 0; }

/* ── buttons ── */
.st-btn {
  height: 32px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px;
  border: 1px solid var(--st-field-border); border-radius: var(--st-rb); background: transparent; white-space: nowrap;
  transition: background .1s, border-color .1s, filter .1s;
}
.st-btn:hover:not(:disabled) { background: var(--fm-hover); border-color: color-mix(in srgb, var(--vscode-foreground) 35%, transparent); }
.st-btn:disabled { opacity: .45; }
.st-btn.sm { height: 26px; padding: 0 9px; font-size: 12px; }
.st-btn.primary, .st-btn.accent { background: var(--st-accent); color: var(--st-ink); border-color: transparent; font-weight: 600; }
.st-btn.primary:hover:not(:disabled), .st-btn.accent:hover:not(:disabled) { background: var(--st-accent); filter: brightness(1.08); border-color: transparent; }
.st-btn.ghost { border-color: transparent; color: var(--st-dim); }
.st-btn.ghost:hover:not(:disabled) { color: var(--vscode-foreground); }
body.vscode-high-contrast .st-btn.primary, body.vscode-high-contrast-light .st-btn.primary,
body.vscode-high-contrast .st-btn.accent, body.vscode-high-contrast-light .st-btn.accent { border-color: var(--vscode-contrastBorder, currentColor); }

/* ── switch ── */
.st-switch {
  appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 36px; height: 20px; margin: 0; cursor: pointer;
  border-radius: 999px; background: color-mix(in srgb, var(--vscode-foreground) 22%, transparent); transition: background .15s;
}
.st-switch::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s, background .15s;
}
.st-switch:checked { background: var(--st-accent); }
.st-switch:checked::after { transform: translateX(16px); background: var(--st-ink); box-shadow: none; }
body.vscode-light .st-switch:not(:checked) { background: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
body.vscode-high-contrast .st-switch, body.vscode-high-contrast-light .st-switch { border: 1px solid var(--vscode-contrastBorder, currentColor); }

/* ── banners ── */
.st-banner {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--st-r);
  border: 1px solid color-mix(in srgb, var(--st-tone) 35%, transparent); background: color-mix(in srgb, var(--st-tone) 9%, transparent);
}
.st-banner[data-tone='info'] { --st-tone: var(--fm-review, var(--vscode-foreground)); }
.st-banner[data-tone='warn'] { --st-tone: var(--fm-warn); }
.st-banner[data-tone='accent'] { --st-tone: var(--st-accent-text); }
.st-banner > .codicon { margin-top: 2px; color: var(--st-tone); }
.st-banner-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.st-banner-text strong { font-weight: 600; }
.st-banner-text div { color: var(--st-dim); }
.st-banner ul { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.st-banner li { font-family: var(--fm-mono); font-size: 12px; color: var(--vscode-foreground); }
.st-banner .st-btn { align-self: center; }
.st-empty { padding: 48px 24px; text-align: center; color: var(--st-dim); border: 1px dashed var(--fm-border-strong); border-radius: calc(var(--st-r) + 2px); }
.st-empty .codicon { font-size: 22px; color: var(--st-faint); }
.st-empty h3 { margin: 8px 0 4px; font-size: 14px; color: var(--vscode-foreground); }

/* ── agents ── */
.st-agent { display: grid; grid-template-columns: 32px minmax(150px, 1fr) minmax(0, 1.2fr) 108px; align-items: center; gap: 14px; padding: 12px 18px; margin: 0 -18px; border-top: 1px solid var(--st-line); }
.st-agent:first-child { border-top: 0; padding-top: 0; }
.st-agent:last-child { padding-bottom: 0; }
.st-agent-mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--st-r); border: 1px solid var(--st-line); background: var(--fm-hover); }
.st-agent-name { font-weight: 600; display: block; }
.st-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-dim); }
.st-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--st-faint); }
.st-status[data-ok='true']::before { background: var(--fm-ok); }
.st-install { display: block; margin-top: 2px; font-size: 11px; color: var(--st-faint); }
.st-pick { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 26px; padding: 0 10px; border: 1px solid var(--st-line); border-radius: 999px; font-size: 12px; color: var(--st-dim); cursor: pointer; white-space: nowrap; transition: background .1s, border-color .1s; }
.st-pick:hover { background: var(--fm-hover); color: var(--vscode-foreground); }
.st-pick input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.st-pick:has(input:checked) { background: var(--fm-accent-soft); border-color: var(--fm-accent-border); color: var(--st-accent-text); font-weight: 600; }
.st-pick:has(input:focus-visible) { outline: 2px solid var(--st-ring); outline-offset: 2px; }

/* ── sidebar style cards ── */
.st-styles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.st-style { position: relative; display: flex; flex-direction: column; border: 1px solid var(--st-line); border-radius: calc(var(--st-r) + 2px); overflow: hidden; cursor: pointer; background: var(--st-page); transition: border-color .12s, box-shadow .12s, transform .12s; }
.st-style:hover { border-color: var(--fm-border-strong); transform: translateY(-1px); }
.st-style input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; z-index: 2; }
.st-style:has(input:checked) { border-color: var(--st-accent-text); box-shadow: 0 0 0 1px var(--st-accent-text); }
.st-style:has(input:focus-visible) { outline: 2px solid var(--st-ring); outline-offset: 2px; }
.st-style-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 3px; border-top: 1px solid var(--st-line); }
.st-style-name { display: flex; align-items: center; gap: 7px; font-weight: 600; }
.st-swatch { width: 9px; height: 9px; border-radius: 50%; background: var(--fm-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
.st-style-check { margin-left: auto; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 50%; background: var(--fm-accent); color: var(--st-ink); opacity: 0; transform: scale(.7); transition: opacity .12s, transform .12s; }
.st-style-check .codicon { font-size: 11px; }
.st-style:has(input:checked) .st-style-check { opacity: 1; transform: none; }
.st-style-desc { font-size: 12px; color: var(--st-dim); }

/* the miniatures: drawn with the style's own --fm-* variables, so they are the real palette */
.st-pv { height: 168px; padding: 10px; display: flex; flex-direction: column; gap: 7px; background: var(--fm-bg); color: var(--fm-text); font-size: 8.5px; line-height: 1.2; overflow: hidden; pointer-events: none; }
.st-pv-bar { height: 5px; border-radius: 3px; background: var(--fm-text-faint); opacity: .55; }
.st-pv-bar.w1 { width: 34%; } .st-pv-bar.w2 { width: 52%; } .st-pv-bar.w3 { width: 68%; } .st-pv-bar.w4 { width: 24%; }
.st-pv-bar.strong { background: var(--fm-text); opacity: .8; }
.st-pv-brand { display: flex; align-items: center; gap: 6px; }
.st-pv-mark { width: 12px; height: 12px; border-radius: 3px; background: var(--fm-accent); }
.st-pv-composer { display: flex; align-items: center; gap: 6px; padding: 6px 7px; border: 1px solid var(--fm-border-strong); background: var(--fm-surface, transparent); }
.fm-aside .st-pv-composer { border-radius: 5px; border-color: var(--fm-border); }
.fm-claude .st-pv-composer { border-radius: 9px; }
.st-pv-composer .st-pv-bar { flex: 1; }
.st-pv-pill { padding: 3px 6px; border-radius: 3px; background: var(--fm-accent); color: var(--st-ink); font-weight: 700; font-size: 8px; }
.st-pv-prompt { font-family: var(--fm-mono); font-weight: 700; color: var(--fm-accent); }
.st-pv-chips { display: flex; gap: 4px; }
.st-pv-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px; border: 1px solid var(--fm-border); border-radius: 3px; color: var(--fm-text-dim); }
.st-pv-chip[data-on] { background: var(--fm-selected, var(--fm-hover)); border-color: var(--fm-text-faint); color: var(--fm-text); }
.st-pv-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--fm-idle); flex: none; }
.st-pv-dot.needs { background: var(--fm-needs); } .st-pv-dot.work { background: var(--fm-working); } .st-pv-dot.ok { background: var(--fm-ok); }
.st-pv-group { font-family: var(--fm-mono); font-size: 7.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--fm-text-faint); padding-top: 2px; display: flex; align-items: center; gap: 4px; }
.st-pv-row { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 5px; border: 1px solid transparent; }
.st-pv-row .st-pv-bar { flex: 1; }
.st-pv-row[data-sel] { background: var(--fm-selected, var(--fm-accent-soft)); border-color: var(--fm-border-strong); }
.fm-claude .st-pv-row { border-radius: 8px; }
.fm-claude .st-pv-row[data-sel] { background: color-mix(in srgb, var(--fm-accent) 9%, transparent); border-color: color-mix(in srgb, var(--fm-accent) 40%, transparent); }
.st-pv-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.st-pv-stat { padding: 4px 5px; border: 1px solid var(--fm-border); border-radius: 4px; background: var(--fm-card); }
.st-pv-stat b { display: block; font-family: var(--fm-mono); font-size: 12px; line-height: 1.1; }
.st-pv-stat span { font-size: 6.5px; letter-spacing: .03em; text-transform: uppercase; color: var(--fm-text-dim); }
.st-pv-stat[data-on] { border-color: var(--fm-accent); background: var(--fm-accent-soft); }
.st-pv-queue { padding: 5px 6px; border: 1px solid color-mix(in srgb, var(--fm-needs) 35%, transparent); background: color-mix(in srgb, var(--fm-needs) 8%, transparent); border-radius: 5px; display: flex; flex-direction: column; gap: 4px; }
.st-pv-queue em { font-style: normal; font-size: 7px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fm-needs); }
.st-pv-card { padding: 6px; border: 1px solid var(--fm-border); border-radius: 5px; background: var(--fm-card); display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.st-pv-card .st-pv-bar:first-child { grid-column: 1 / -1; }
.st-pv-strip { margin-top: auto; display: flex; height: 4px; border-radius: 2px; overflow: hidden; gap: 1px; }
.st-pv-strip i { flex: 1; background: var(--fm-idle); opacity: .5; } .st-pv-strip i.a { background: var(--fm-accent); opacity: 1; flex: 2; }

/* ── ports, chips ── */
.st-chips { display: flex; flex-direction: column; gap: 10px; }
.st-chip-list { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; align-items: center; }
.st-chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 999px; border: 1px solid var(--fm-border-strong); background: var(--fm-hover); }
.st-chip code { font-size: 12px; }
.st-chip button { width: 18px; height: 18px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--st-dim); }
.st-chip button:hover { background: var(--fm-hover); color: var(--vscode-foreground); }
.st-chip .codicon { font-size: 11px; }
.st-chip.suggest { padding: 0 10px 0 7px; gap: 4px; background: transparent; border-style: dashed; cursor: pointer; color: var(--st-dim); }
.st-chip.suggest:hover { background: var(--fm-accent-soft); border-color: var(--fm-accent-border); color: var(--st-accent-text); }
.st-chip-empty { font-size: 12px; color: var(--st-faint); }
.st-suggest { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* ── details, editor ── */
.st-details { border: 1px solid var(--st-line); border-radius: var(--st-r); }
.st-details summary { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; color: var(--st-dim); list-style: none; }
.st-details summary::-webkit-details-marker { display: none; }
.st-details summary::before { content: '\\eab6'; display: inline-block; font-family: codicon; font-size: 12px; transition: transform .12s; }
.st-details[open] summary::before { transform: rotate(90deg); }
.st-details summary:hover { color: var(--vscode-foreground); }
.st-details > div { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.st-envs { display: flex; flex-wrap: wrap; gap: 6px; }
.st-envs code { padding: 2px 7px; font-size: 11.5px; border-radius: 4px; background: var(--fm-hover); border: 1px solid var(--st-line); }
.st-editor-head { display: flex; align-items: center; gap: 10px; }
.st-editor-head .st-label { flex: 1; }
.st-valid { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fm-ok); }
.st-valid[data-bad='true'] { color: var(--fm-bad); }
body.vscode-light .st-valid { color: color-mix(in srgb, var(--fm-ok) 85%, #000); }
body.vscode-light .st-valid[data-bad='true'] { color: color-mix(in srgb, var(--fm-bad) 85%, #000); }
.st-valid .codicon { font-size: 13px; }

/* ── save bar ── */
.st-bar-wrap { position: sticky; bottom: 0; padding: 0 40px 20px; pointer-events: none; }
.st-bar {
  pointer-events: auto; max-width: 700px; margin: 0 auto; display: flex; align-items: center; gap: 12px; padding: 9px 9px 9px 16px;
  border: 1px solid var(--fm-border-strong); border-radius: calc(var(--st-r) + 4px);
  background: color-mix(in srgb, var(--vscode-foreground) 8%, var(--st-page));
  box-shadow: 0 8px 28px rgba(0,0,0,.28); animation: stack-fadein .18s ease;
}
body.vscode-light .st-bar { box-shadow: 0 6px 22px rgba(0,0,0,.12); background: var(--st-page); }
body.vscode-high-contrast .st-bar, body.vscode-high-contrast-light .st-bar { background: var(--st-page); border-color: var(--vscode-contrastBorder, currentColor); box-shadow: none; }
.st-bar-msg { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.st-bar-msg span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-bar-msg small { color: var(--st-dim); font-size: 12px; }
.st-bar-msg .codicon[data-tone='ok'] { color: var(--fm-ok); }
.st-bar-msg .codicon[data-tone='bad'] { color: var(--fm-bad); }
.st-bar-actions { display: flex; gap: 6px; flex: none; }

/* ── narrow: the nav becomes a strip of tabs ── */
@media (max-width: 780px) {
  .st { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .st-nav { flex-direction: row; align-items: center; gap: 6px; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--st-line); overflow-x: auto; overflow-y: hidden; }
  .st-brand { padding: 0 6px 0 0; }
  .st-brand-sub, .st-legend { display: none; }
  .st-navlist { flex-direction: row; gap: 4px; }
  .st-navitem { width: auto; flex: none; padding: 0 12px; }
  .st-navitem[aria-current='page']::before { left: 10px; right: 10px; top: auto; bottom: -9px; width: auto; height: 2px; border-radius: 2px 2px 0 0; }
  .st-content { padding: 20px 16px 16px; }
  .st-bar-wrap { padding: 0 12px 12px; }
  .st-agent { grid-template-columns: 32px minmax(0, 1fr) auto; row-gap: 10px; }
  .st-agent .st-field { grid-column: 1 / -1; order: 5; }
    .st-bar { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .st *, .st { transition: none !important; animation: none !important; } }
`;
