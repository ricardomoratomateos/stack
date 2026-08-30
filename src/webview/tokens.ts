export const T = {
  bg:          'var(--vscode-sideBar-background)',
  surface:     'var(--vscode-input-background)',
  surface2:    'var(--vscode-list-hoverBackground)',
  surface3:    'var(--vscode-list-activeSelectionBackground)',
  surface4:    'var(--vscode-list-inactiveSelectionBackground)',

  border:      'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
  borderLight: 'color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
  borderStrong:'var(--vscode-focusBorder)',

  textMuted:   'var(--vscode-disabledForeground)',
  textDim:     'var(--vscode-descriptionForeground)',
  textBody:    'var(--vscode-foreground)',
  textStrong:  'var(--vscode-foreground)',

  accent:      'var(--vscode-button-background)',
  accentInk:   'var(--vscode-button-foreground)',
  accentBg:    'color-mix(in srgb, var(--vscode-button-background) 15%, transparent)',

  green:       'var(--vscode-terminal-ansiGreen)',
  greenBg:     'color-mix(in srgb, var(--vscode-terminal-ansiGreen) 12%, transparent)',
  amber:       'var(--vscode-terminal-ansiYellow)',
  amberBg:     'color-mix(in srgb, var(--vscode-terminal-ansiYellow) 12%, transparent)',
  purple:      'var(--vscode-terminal-ansiMagenta)',
  purpleBg:    'color-mix(in srgb, var(--vscode-terminal-ansiMagenta) 12%, transparent)',
  red:         'var(--vscode-terminal-ansiRed)',
  redBg:       'color-mix(in srgb, var(--vscode-terminal-ansiRed) 10%, transparent)',
  blue:        'var(--vscode-terminal-ansiBlue)',
  blueBg:      'color-mix(in srgb, var(--vscode-terminal-ansiBlue) 12%, transparent)',

  sans:        'var(--vscode-font-family)',
  mono:        'var(--vscode-editor-font-family)',
  fontSize:    'var(--vscode-font-size, 13px)',

  // Popup menus have their own theme keys — a menu painted from list/sideBar
  // colours reads as part of the sidebar rather than as a thing floating above
  // it. Each falls back to the nearest general token for themes that skip them.
  // The menu is the same surface as a selected worktree card, deliberately:
  // menu.background is VSCode's *workbench* menu colour and stays grey in
  // themes with a black sidebar, and sideBar-background made the menu vanish
  // into the panel. The border matches the fill rather than drawing a
  // contrasting line — the drop shadow is what lifts it off the card.
  // Painted OVER an opaque widget base: in many themes the selection colour
  // carries alpha, and used bare it let the card underneath bleed through the
  // menu. The gradient trick keeps the tint while the base guarantees opacity.
  menuBg:      'linear-gradient(var(--vscode-list-activeSelectionBackground, transparent), var(--vscode-list-activeSelectionBackground, transparent)), var(--vscode-editorWidget-background, var(--vscode-sideBar-background))',
  menuFg:      'var(--vscode-list-activeSelectionForeground, var(--vscode-foreground))',
  menuBorder:  'var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background))',
  menuSepBg:   'color-mix(in srgb, var(--vscode-foreground) 12%, transparent)',

  // sideBarSectionHeader-foreground, which is exactly what the native view
  // header beside these uses. Swapping it for plain `foreground` made ours the
  // bright one instead — the mismatch just pointed the other way.
  sectionHeaderFg: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground))',
  titleFg:         'var(--vscode-sideBarTitle-foreground, var(--vscode-foreground))',
} as const;

/**
 * Matches VS Code's native pane-header title, which these sections sit directly
 * below.
 *
 * No `textTransform: uppercase`: current VS Code renders a view's contributed
 * name verbatim, so forcing caps here made our sections shout "AGENTS" under a
 * native "Worktrees" and the imitation gave itself away.
 */
export const SECTION_TITLE_STYLE = {
  // Tracks the workbench font size rather than the old hardcoded 11px: the
  // native header it sits next to uses it, so a literal here drifts the moment
  // VS Code (or the user's font-size setting) moves.
  fontSize: T.fontSize,
  // Semibold, which is what `.pane-header .title` asks for in the modern UI.
  // Not 700 (the classic value) and emphatically not 400, which was a guess read
  // backwards off a screenshot.
  fontWeight: 'var(--vscode-fontWeight-semiBold, 600)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

export const GLOBAL_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font-family: ${T.sans};
  font-size: ${T.fontSize};
  background: ${T.bg};
  color: ${T.textBody};
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
a { color: inherit; text-decoration: none; }
button { font-family: inherit; font-size: inherit; cursor: pointer; }
input, textarea { font-family: inherit; font-size: inherit; }
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent); border-radius: 3px; }
::selection { background: color-mix(in srgb, var(--vscode-button-background) 35%, transparent); }

@keyframes foreman-bounce {
  0%,80%,100% { transform: translateY(0); }
  40%         { transform: translateY(-4px); }
}
@keyframes foreman-pulse {
  0%,100% { opacity: 1; }
  50%     { opacity: 0.3; }
}
@keyframes foreman-blink {
  0%,100% { opacity: 1; }
  50%     { opacity: 0.15; }
}
@keyframes foreman-fadein {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}

.u-dot-active  { animation: foreman-pulse 1.6s ease-in-out infinite; }
.u-dot-perm    { animation: foreman-blink 1.0s ease-in-out infinite; }
.u-dot-1 { animation: foreman-bounce 1.2s ease-in-out infinite; }
.u-dot-2 { animation: foreman-bounce 1.2s ease-in-out 0.15s infinite; }
.u-dot-3 { animation: foreman-bounce 1.2s ease-in-out 0.30s infinite; }
.u-fadein { animation: foreman-fadein .2s ease; }

/* Popup menu rows. Hover lifts the row by mixing foreground INTO the menu's own
   fill, rather than using list-hoverBackground: that token is meant to sit on
   the sidebar's background, and over the (lighter) selection colour it can read
   as darker than the row it is highlighting. */
.u-menu-item:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 10%, var(--vscode-list-activeSelectionBackground)) !important;
}
/* A dimmed row is not launchable; say so with the cursor before the click. */
.u-menu-item[data-disabled='true'] { cursor: help; }

/* Collapsible section headers.

   Transcribed from VS Code's own stylesheet rather than guessed off a
   screenshot — three attempts at eyeballing this got the weight, the background
   and the height wrong in turn. The source is
   Contents/Resources/app/out/vs/workbench/workbench.desktop.main.css, rule
   ".style-override .monaco-pane-view .pane > .pane-header", which is the modern
   UI (it renders view titles capitalised rather than uppercase — the giveaway
   that this is the branch in play):

     height: var(--pane-header-size)          -> 28px here, 22px classic
     margin: 0 var(--vscode-spacing-size40)   -> 4px
     padding: 0 0 0 var(--vscode-spacing-size40)
     border-radius: var(--vscode-cornerRadius-small)
     background: sideBar-background, hover list-hoverBackground
     :before -> a rule along the TOP, inset a further 4px each side

   The design tokens do not reach a webview (only theme *colours* are injected),
   so each carries the fallback VS Code itself writes. "--pane-header-size" is
   not a "--vscode-*" variable at all and cannot arrive here, hence the literal.

   Consequences worth naming: the header is inset from the panel edges and
   rounded, so its hover is a rounded rect rather than a full-bleed band; and
   the separator belongs to the header above it, not below its content. */
.u-section-header {
  position: relative;
  height: 28px;
  /* Chromium sizes a <button> to fit-content even when display:flex makes it a
     block-level flex container, so without this the header shrank to wrap its
     own label: the hover highlight came out as a pill around "Docker 3/3 up"
     instead of a row, and the hint's margin-left:auto had no space to push
     into. The native header is a div and needs no such help.

     Not "width: 100%" — with the global border-box that is the full container
     width PLUS the horizontal margins, overflowing by 8px, and body's
     overflow-x:hidden turns that into a silently clipped hint rather than a
     scrollbar. */
  width: calc(100% - 2 * var(--vscode-spacing-size40, 4px));
  margin: 0 var(--vscode-spacing-size40, 4px);
  padding: 0 0 0 var(--vscode-spacing-size40, 4px);
  border-radius: var(--vscode-cornerRadius-small, 4px);
  background: transparent;
}
.u-section-header:hover { background: var(--vscode-list-hoverBackground); }
.u-section-header::before {
  content: '';
  position: absolute; top: 0;
  /* Inset within a header that is itself margin-inset, so the line stops 8px
     short of each panel edge. A full-bleed border was the difference that read
     as "the lines are wrong". */
  left: var(--vscode-spacing-size40, 4px);
  right: var(--vscode-spacing-size40, 4px);
  height: var(--vscode-strokeThickness, 1px);
  background: var(--vscode-sideBarSectionHeader-border,
              var(--vscode-panel-border,
              color-mix(in srgb, var(--vscode-foreground) 6%, transparent)));
  pointer-events: none;
}
`;
