import { T } from '../tokens';

/**
 * Styles every layout shares: buttons, the launch split, popup menus, session
 * rows, the details block and the health strip.
 *
 * All of it reads CSS variables (`--fm-*`) that a layout's root class defines,
 * so the same markup takes the layout's palette, radius and density. That is
 * what lets the three looks be three stylesheets over one set of components
 * instead of three copies of them.
 */
export const SHARED_CSS = `
.fm {
  height: 100%; min-height: 0; position: relative;
  display: flex; flex-direction: column;
  background: var(--fm-bg); color: var(--fm-text);
  font-family: var(--fm-sans); font-size: var(--vscode-font-size, 13px);
  /* The sidebar can be dragged from ~240px to 500px+; layouts adapt to THEIR
     width, not the window's, so they use container queries. */
  container-type: inline-size; container-name: fm;
}
/* :where() keeps these at zero specificity, so a button class can set its own colour. */
:where(.fm) button { font: inherit; color: inherit; cursor: pointer; }
:where(.fm) button:disabled { cursor: default; }
.fm ul { list-style: none; }
.fm :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.fm-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-mono { font-family: var(--fm-mono); }

/* ── tones ── */
.fm { --fm-needs-text: var(--fm-needs); }
body.vscode-light .fm { --fm-needs-text: color-mix(in srgb, var(--fm-needs) 70%, #000); }

/* ── buttons ── */
.fm-btn {
  height: 26px; padding: 0 10px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--fm-border-strong); border-radius: var(--fm-btn-radius);
  background: transparent; color: var(--fm-text); font-size: 12px; white-space: nowrap;
  transition: background .1s, border-color .1s;
}
.fm-btn:hover:not(:disabled) { background: var(--fm-hover); }
.fm-btn:disabled { opacity: .45; }
.fm-btn-icon { width: 28px; padding: 0; }
.fm-btn-primary { background: var(--fm-primary-bg); color: var(--fm-primary-ink); border-color: transparent; font-weight: 600; }
.fm-btn-primary:hover:not(:disabled) { background: var(--fm-primary-bg); filter: brightness(1.1); }
.fm-btn-needs { background: var(--fm-needs); color: var(--fm-needs-ink, #1a1a1a); border-color: transparent; font-weight: 600; }
.fm-btn-needs:hover:not(:disabled) { background: var(--fm-needs); filter: brightness(1.08); }
.fm-btn-accent { background: var(--fm-accent-soft); border-color: var(--fm-accent-border); color: var(--fm-accent-text); font-weight: 500; }
.fm-btn-accent:hover:not(:disabled) { background: color-mix(in srgb, var(--fm-accent) 22%, transparent); }
.fm-btn-ok { background: var(--fm-ok-solid, var(--fm-ok)); color: #fff; border-color: transparent; font-weight: 600; }
.fm-btn-ok:hover:not(:disabled) { filter: brightness(1.1); background: var(--fm-ok-solid, var(--fm-ok)); }
.fm-btn-quiet { color: var(--fm-text-dim); border-color: var(--fm-border); }

/* High contrast: a filled button on a black sidebar needs its outline to be found. */
body.vscode-high-contrast .fm .fm-btn-primary, body.vscode-high-contrast-light .fm .fm-btn-primary,
body.vscode-high-contrast .fm .fm-split-solid .fm-split-main, body.vscode-high-contrast-light .fm .fm-split-solid .fm-split-main,
body.vscode-high-contrast .fm .fm-split-solid .fm-split-chev, body.vscode-high-contrast-light .fm .fm-split-solid .fm-split-chev {
  border-color: var(--vscode-contrastBorder, currentColor);
}

/* ── launch split ── */
.fm-split { position: relative; display: inline-flex; flex: none; }
.fm-split-main, .fm-split-chev {
  height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--fm-border-strong); background: transparent; color: var(--fm-text);
}
.fm-split-main { padding: 0 8px; gap: 6px; font-size: 12px; font-weight: 600; border-radius: var(--fm-btn-radius) 0 0 var(--fm-btn-radius); }
.fm-split-main:not(:has(.fm-split-label)) { width: 28px; padding: 0; }
.fm-split-chev { width: 22px; border-left-width: 0; border-radius: 0 var(--fm-btn-radius) var(--fm-btn-radius) 0; }
.fm-split-chev .codicon { font-size: 12px; }
.fm-split-mark { display: inline-flex; }
.fm-split-ghost .fm-split-main:hover, .fm-split-ghost .fm-split-chev:hover { background: var(--fm-hover); }
.fm-split-solid .fm-split-main, .fm-split-solid .fm-split-chev { background: var(--fm-primary-bg); color: var(--fm-primary-ink); border-color: transparent; }
.fm-split-solid .fm-split-chev { border-left: 1px solid rgba(0,0,0,.25); }
.fm-split-solid .fm-split-main:hover, .fm-split-solid .fm-split-chev:hover { filter: brightness(1.1); }
/* The provider's own colour disappears on a filled button of the same hue. */
.fm-split-solid .fm-split-mark svg * { stroke: currentColor; }

/* ── popup menus ── */
.fm-more { position: relative; flex: none; }
.fm-menu {
  position: absolute; top: 100%; left: 0; z-index: 30; margin-top: 3px;
  min-width: 170px; padding: 3px;
  background: ${T.menuBg}; color: ${T.menuFg};
  border: 1px solid ${T.menuBorder}; border-radius: 6px;
  /* A black shadow is invisible on a black sidebar; the theme's own widget
     shadow is the only one that shows up in every theme. */
  box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0,0,0,.35));
}
.fm-menu-up { top: auto; bottom: 100%; margin-top: 0; margin-bottom: 3px; }
.fm-menu-end { left: auto; right: 0; }
.fm-menu-item {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 4px 7px; border: 0; border-radius: 3px;
  background: transparent; color: inherit; font-size: 12px; text-align: left; white-space: nowrap;
}
.fm-menu-item:hover:not(:disabled), .fm-menu-item:focus-visible {
  background: color-mix(in srgb, var(--vscode-foreground) 10%, var(--vscode-list-activeSelectionBackground));
}
.fm-menu-item:disabled { opacity: .45; }
.fm-menu-item[data-dim] { opacity: .4; cursor: help; }
.fm-menu-label { flex: 1; }
.fm-menu-check { font-size: 11px; opacity: .7; }
.fm-menu-danger:hover:not(:disabled) { color: var(--vscode-errorForeground, #f14c4c); }
.fm-menu-sep { height: 1px; background: ${T.menuSepBg}; margin: 3px 0; }

/* ── sessions ── */
.fm-sessions { display: flex; flex-direction: column; border-top: 1px solid var(--fm-border); padding-top: 6px; }
.fm-sess { position: relative; border-radius: var(--fm-radius-sm); }
.fm-sess[data-dragging] { opacity: .4; }
.fm-sess[data-over] { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.fm-sess-main {
  width: 100%; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 8px; align-items: center;
  padding: 5px 4px; border: 0; border-radius: var(--fm-radius-sm); background: transparent; text-align: left;
}
.fm-sess-main:hover { background: var(--fm-hover); }
.fm-sess-mark { display: flex; align-items: center; justify-content: center; }
.fm-sess-prompt { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text-dim); }
.fm-sess-text { min-width: 0; display: flex; gap: 6px; align-items: baseline; }
.fm-sess-name { flex: none; max-width: 60%; font-size: 12px; color: var(--fm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-sess-sub { min-width: 0; font-size: 11.5px; color: var(--fm-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-sess-state { font-size: 11px; color: var(--fm-text-dim); white-space: nowrap; }
.fm-sess[data-state='permission'] .fm-sess-state { color: var(--fm-needs-text); }
.fm-sess[data-state='active'] .fm-sess-state { color: var(--fm-working-text, var(--fm-working)); }
.fm-sess[data-state='waiting'] .fm-sess-state { color: var(--fm-ok); }
.fm-sess-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fm-idle); }
.fm-sess[data-state='permission'] .fm-sess-dot { background: var(--fm-needs); animation: foreman-blink 1s ease-in-out infinite; }
.fm-sess[data-state='active'] .fm-sess-dot { background: var(--fm-working); animation: foreman-pulse 1.6s ease-in-out infinite; }
.fm-sess[data-state='waiting'] .fm-sess-dot { background: var(--fm-ok); }
.fm-sess[data-state='terminated'] .fm-sess-dot { background: var(--fm-bad); }
/* Rename and kill take the state label's place on hover or keyboard focus. */
.fm-sess-actions { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: none; gap: 2px; }
.fm-sess:hover .fm-sess-actions, .fm-sess:focus-within .fm-sess-actions { display: flex; }
.fm-sess:hover .fm-sess-state, .fm-sess:focus-within .fm-sess-state { visibility: hidden; }
.fm-sess-actions button {
  width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 4px; background: transparent; color: var(--fm-text-dim);
}
.fm-sess-actions button:hover { background: var(--fm-hover); color: var(--fm-text); }
.fm-sess-actions .codicon { font-size: 12px; }

/* ── details of the selected worktree ── */
.fm-det { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 5px 8px; font-size: 11.5px; margin: 0; }
.fm-det dt { color: var(--fm-text-faint); padding-top: 1px; }
.fm-det dd {
  margin: 0; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 3px 8px;
  font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text);
}
.fm-det .fm-det-wide { grid-column: 1 / -1; }
.fm-det [data-tone='ok'] { color: var(--fm-ok); }
.fm-det [data-tone='warn'] { color: var(--fm-warn); }
.fm-det [data-tone='bad'] { color: var(--fm-bad); }
.fm-det [data-tone='muted'] { color: var(--fm-text-dim); }
.fm-link {
  display: inline-flex; align-items: center; gap: 2px; max-width: 100%; padding: 0; border: 0; background: none;
  font: inherit; color: inherit; text-align: left;
}
.fm-link:hover:not(:disabled) { text-decoration: underline; }
.fm-link .codicon { font-size: 12px; margin-left: -3px; }
.fm-mini {
  width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--fm-border-strong); border-radius: 4px; background: transparent; color: var(--fm-text-dim);
}
.fm-mini:hover:not(:disabled) { background: var(--fm-hover); color: var(--fm-text); }
.fm-mini:disabled { opacity: .5; }
.fm-mini .codicon { font-size: 11px; }
.fm-ports { gap: 4px 6px; }
.fm-port {
  display: inline-flex; gap: 3px; padding: 0 5px; height: 18px; align-items: center;
  border: 1px solid var(--fm-border-strong); border-radius: 3px; background: transparent;
  font-family: var(--fm-mono); font-size: 10.5px; color: var(--fm-text);
}
button.fm-port:hover { background: var(--fm-hover); border-color: var(--fm-accent-border); }
.fm-port[data-static] { color: var(--fm-text-dim); border-style: dashed; }
.fm-port-label { color: var(--fm-text-dim); }
.fm-chip-text { font-family: var(--fm-mono); font-size: 10.5px; }
.fm-containers { width: 100%; display: flex; flex-direction: column; gap: 2px; padding-left: 2px; }
.fm-containers li { display: flex; align-items: center; gap: 6px; min-height: 18px; color: var(--fm-text-dim); }
.fm-container-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--fm-idle); }
.fm-containers [data-tone='ok'] .fm-container-dot { background: var(--fm-ok); }
.fm-containers [data-tone='bad'] .fm-container-dot { background: var(--fm-bad); }
.fm-container-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-container-state { flex: none; }
.fm-containers [data-tone='ok'] .fm-container-state { color: var(--fm-ok); }
.fm-containers [data-tone='bad'] .fm-container-state { color: var(--fm-bad); }
.fm-error { font-family: var(--fm-sans); font-size: 11.5px; color: var(--fm-bad); white-space: pre-wrap; overflow-wrap: anywhere; }

.fm-diff { display: inline-flex; gap: 5px; font-family: var(--fm-mono); font-size: 11px; white-space: nowrap; }
.fm-diff[data-files] { color: var(--fm-text-dim); }
.fm-add { color: var(--fm-add); }
.fm-del { color: var(--fm-del); }
.fm-pr { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text); }
.fm-pr-state { color: var(--fm-text-dim); }
.fm-pr[data-state='open'] .fm-pr-state { color: var(--fm-ok); }
.fm-pr[data-state='merged'] .fm-pr-state { color: var(--vscode-charts-purple, #b180d7); }
.fm-row-error {
  font-size: 11px; color: var(--fm-bad); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── empty / loading ── */
.fm-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
.fm-empty:has(.fm-loading-dot) { flex-direction: row; gap: 5px; }
.fm-empty-text { color: var(--fm-text-dim); }
.fm-loading-dot { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: var(--fm-text-faint); }

/* ── health strip ── */
.fm-health {
  flex: none; display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 7px 14px;
  border-top: 1px solid var(--fm-border);
  font-family: var(--fm-mono); font-size: 10.5px; color: var(--fm-text-dim);
}
.fm-health-dot { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--fm-ok); }
.fm-health-dot[data-tone='warn'] { background: var(--fm-warn); }
.fm-health-dot[data-tone='bad'] { background: var(--fm-bad); }

/* ── drag ── */
.fm-drag[data-dragging] { opacity: .4; }
.fm-drag[data-over] { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.fm-deleting { opacity: .45; pointer-events: none; }

@media (prefers-reduced-motion: reduce) {
  .fm *, .fm *::before, .fm *::after { animation: none !important; transition: none !important; }
}
`;

export const ROW_PARTS_CSS = `
.fm-ask {
  margin: 0 10px 10px var(--fm-indent, 38px); padding: 9px 10px;
  display: flex; flex-direction: column; gap: 8px;
  border-radius: var(--fm-radius);
  background: color-mix(in srgb, var(--fm-needs) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--fm-needs) 32%, transparent);
}
.fm-ask-text {
  font-family: var(--fm-mono); font-size: 11.5px; color: var(--fm-text);
  overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.fm-ask-text:not([data-command]) { font-family: var(--fm-sans); font-size: 12px; }
.fm-ask-quiet { color: var(--fm-text-dim); }
.fm-ask-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.fm-row-actions { margin: 0 10px 10px var(--fm-indent, 38px); display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
`;
