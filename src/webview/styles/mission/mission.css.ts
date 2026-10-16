/**
 * "Mission control": counters that filter, an attention queue, and cards with a
 * metadata grid. The theme paints everything except the blue accent.
 */
export const MISSION_CSS = `
.fm-mission {
  --fm-sans: var(--vscode-font-family);
  --fm-mono: var(--vscode-editor-font-family, Menlo, monospace);
  --fm-bg: var(--vscode-sideBar-background);
  --fm-text: var(--vscode-foreground);
  --fm-text-dim: var(--vscode-descriptionForeground, color-mix(in srgb, var(--vscode-foreground) 70%, transparent));
  --fm-text-faint: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
  --fm-border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  --fm-border-strong: color-mix(in srgb, var(--vscode-foreground) 24%, transparent);
  --fm-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
  --fm-card: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
  --fm-radius: 6px; --fm-radius-sm: 4px; --fm-btn-radius: 5px;

  --fm-accent: #4FA3F7;
  --fm-accent-text: #4FA3F7;
  --fm-accent-soft: color-mix(in srgb, var(--fm-accent) 14%, transparent);
  --fm-accent-border: color-mix(in srgb, var(--fm-accent) 55%, transparent);
  --fm-primary-bg: var(--vscode-button-background, #0E639C);
  --fm-primary-ink: var(--vscode-button-foreground, #fff);

  --fm-needs: var(--vscode-editorWarning-foreground, #cca700);
  --fm-ok: var(--vscode-testing-iconPassed, #73c991);
  --fm-ok-solid: #2E7D4F;
  --fm-warn: var(--vscode-editorWarning-foreground, #cca700);
  --fm-bad: var(--vscode-testing-iconFailed, #f14c4c);
  --fm-working: var(--fm-accent);
  --fm-idle: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
  --fm-add: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  --fm-del: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
}
body.vscode-light .fm-mission { --fm-accent: #0B6BCB; --fm-accent-text: #0B6BCB; }
body.vscode-high-contrast .fm-mission, body.vscode-high-contrast-light .fm-mission {
  --fm-border: var(--vscode-contrastBorder, currentColor);
  --fm-border-strong: var(--vscode-contrastBorder, currentColor);
}

/* counters */
.ms-stats { flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 8px 12px 10px; }
.ms-stat {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0;
  padding: 6px 7px; border-radius: 6px; text-align: left;
  background: var(--fm-card); border: 1px solid var(--fm-border);
  transition: background .1s, border-color .1s;
}
.ms-stat:hover { background: var(--fm-hover); }
.ms-stat-n { font-family: var(--fm-mono); font-size: 18px; font-weight: 700; line-height: 1.1; }
.ms-stat-label { max-width: 100%; font-size: 9.5px; letter-spacing: .03em; text-transform: uppercase; color: var(--fm-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-stat[data-group='needs'] .ms-stat-n { color: var(--fm-needs-text); }
.ms-stat[data-group='review'] .ms-stat-n { color: var(--fm-ok); }
.ms-stat[data-group='working'] .ms-stat-n { color: var(--fm-accent-text); }
.ms-stat[data-group='idle'] .ms-stat-n { color: var(--fm-text-dim); }
.ms-stat[aria-pressed='true'] { border-color: var(--fm-accent); background: var(--fm-accent-soft); }
.ms-stat[data-group='needs'][aria-pressed='true'] { border-color: var(--fm-needs); background: color-mix(in srgb, var(--fm-needs) 14%, transparent); }
.ms-stat[data-group='review'][aria-pressed='true'] { border-color: var(--fm-ok); background: color-mix(in srgb, var(--fm-ok) 14%, transparent); }
.ms-stat[data-group='idle'][aria-pressed='true'] { border-color: var(--fm-text-dim); background: color-mix(in srgb, var(--fm-text-dim) 12%, transparent); }

/* attention queue */
.ms-queue {
  flex: none; margin: 0 12px 10px; max-height: 34%; overflow-y: auto;
  border: 1px solid color-mix(in srgb, var(--fm-needs) 30%, transparent);
  background: color-mix(in srgb, var(--fm-needs) 7%, transparent); border-radius: 6px;
}
.ms-queue-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--fm-needs) 25%, transparent);
}
.ms-queue-title { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fm-needs-text); }
.ms-queue-hint { font-family: var(--fm-mono); font-size: 10.5px; color: var(--fm-text-dim); white-space: nowrap; }
.ms-q {
  width: 100%; display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 8px; align-items: center;
  padding: 7px 10px; border: 0; background: transparent; text-align: left;
}
.ms-q:hover { background: var(--fm-hover); }
.ms-q-text { min-width: 0; display: flex; flex-direction: column; }
.ms-q-name { font-size: 12.5px; }
.ms-q-why { font-size: 11.5px; color: var(--fm-text-dim); }

/* badges */
.ms-badge {
  flex: none; min-width: 74px; text-align: center; padding: 2px 6px; border-radius: 3px;
  font-family: var(--fm-mono); font-size: 9.5px; font-weight: 700; letter-spacing: .06em;
  color: var(--fm-text-dim); background: color-mix(in srgb, var(--fm-text-dim) 14%, transparent);
}
.ms-badge[data-group='needs'] { color: var(--fm-needs-text); background: color-mix(in srgb, var(--fm-needs) 18%, transparent); }
.ms-badge[data-group='review'] { color: var(--fm-ok); background: color-mix(in srgb, var(--fm-ok) 15%, transparent); }
.ms-badge[data-group='working'] { color: var(--fm-accent-text); background: var(--fm-accent-soft); }
.ms-badge[data-group='missing'] { background: transparent; border: 1px dashed var(--fm-border-strong); }
.ms-when { font-family: var(--fm-mono); font-size: 11px; color: var(--fm-text-faint); }

/* cards */
.ms-cards { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.ms-cards > .fm-empty { flex: 1; }
.ms-card {
  flex: none; border-radius: 6px; background: var(--fm-card); border: 1px solid var(--fm-border);
  transition: background .12s, border-color .12s; animation: stack-fadein .15s ease;
}
.ms-card[data-group='idle'], .ms-card[data-group='missing'] { opacity: .88; }
.ms-card[data-group='missing'] { border-style: dashed; }
.ms-card[data-selected] { border-color: var(--fm-accent); background: color-mix(in srgb, var(--fm-accent) 8%, var(--fm-card)); opacity: 1; }
.ms-card-main {
  width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px;
  border: 0; border-radius: 6px; background: transparent; text-align: left;
}
.ms-card:not([data-selected]) .ms-card-main:hover { background: var(--fm-hover); }
.ms-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ms-name { flex: 1; min-width: 0; font-weight: 600; }
.ms-card-line { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--fm-text-dim); }
.ms-provider { flex: none; font-family: var(--fm-mono); font-size: 10.5px; color: var(--fm-text-dim); border: 1px solid var(--fm-border-strong); border-radius: 3px; padding: 0 4px; }
.ms-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin-top: 2px; font-family: var(--fm-mono); font-size: 11px; }
.ms-meta > span { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ms-k { flex: none; color: var(--fm-text-faint); }
.ms-v[data-tone='ok'] { color: var(--fm-ok); }
.ms-v[data-tone='warn'] { color: var(--fm-warn); }
.ms-v[data-tone='bad'] { color: var(--fm-bad); }
.ms-v[data-tone='muted'] { color: var(--fm-text-dim); }
.ms-pad { margin: 0 12px 8px; }
.ms-expand { padding: 0 12px 10px; display: flex; flex-direction: column; gap: 10px; }
.ms-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 0 12px 10px; }
.ms-expand .ms-actions { padding: 0; }
.ms-spacer { flex: 1; }
.ms-mono { font-family: var(--fm-mono); font-size: 11px; }
/* The state markers in session rows are dots here. */
.fm-mission .fm-sess-main { grid-template-columns: 8px minmax(0, 1fr) auto; }

/* Narrow: two counters per row rather than four crushed ones. */
@container fm (max-width: 310px) {
  .ms-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-left: 8px; padding-right: 8px; }
  .ms-queue { margin-left: 8px; margin-right: 8px; }
  .ms-q { grid-template-columns: 70px minmax(0, 1fr) auto; }
  .ms-badge { min-width: 62px; }
  .ms-cards { padding-left: 8px; padding-right: 8px; }
  .ms-meta { grid-template-columns: minmax(0, 1fr); }
}
`;
