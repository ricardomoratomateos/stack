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
  menuBg:      'var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background))',
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
 * above (the "Screenshot drop" view is a real one).
 *
 * No `textTransform: uppercase`: current VS Code renders a view's contributed
 * name verbatim, so forcing caps here made our sections shout "AGENTS" next to
 * a native "Screenshot drop" and the imitation gave itself away.
 */
export const SECTION_TITLE_STYLE = {
  // Tracks the workbench font size rather than the old hardcoded 11px: the
  // native header it sits next to uses it, so a literal here drifts the moment
  // VS Code (or the user's font-size setting) moves.
  fontSize: T.fontSize,
  // Bold, because the native pane header beside these is. Dropping this to 400
  // was a guess read off a screenshot, and it was backwards: losing the
  // uppercase did not mean losing the weight.
  fontWeight: 700,
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

@keyframes unmess-bounce {
  0%,80%,100% { transform: translateY(0); }
  40%         { transform: translateY(-4px); }
}
@keyframes unmess-pulse {
  0%,100% { opacity: 1; }
  50%     { opacity: 0.3; }
}
@keyframes unmess-blink {
  0%,100% { opacity: 1; }
  50%     { opacity: 0.15; }
}
@keyframes unmess-fadein {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}

.u-dot-active  { animation: unmess-pulse 1.6s ease-in-out infinite; }
.u-dot-perm    { animation: unmess-blink 1.0s ease-in-out infinite; }
.u-dot-1 { animation: unmess-bounce 1.2s ease-in-out infinite; }
.u-dot-2 { animation: unmess-bounce 1.2s ease-in-out 0.15s infinite; }
.u-dot-3 { animation: unmess-bounce 1.2s ease-in-out 0.30s infinite; }
.u-fadein { animation: unmess-fadein .2s ease; }

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

   No background of their own, and a hover highlight instead — which is what the
   native pane header beside these does. sideBarSectionHeader-background is a
   real, visible fill in most themes (it is meant for the headers of *stacked*
   views, which do sit on a band), so painting it here put a grey bar under
   AGENTS / GIT / DOCKER next to a transparent "Screenshot Drop", and ours were
   the only ones that did not light up under the pointer. Those two together were
   the giveaway, not the type. */
.u-section-header { background: transparent; }
.u-section-header:hover { background: var(--vscode-list-hoverBackground); }

/* Sections are divided from each other, but not from whatever follows the
   webview: VS Code draws its own boundary above the next pane header, and ours
   landing 1px above it made a double line and stole a pixel from a gap that was
   already 3px wider than the native rhythm. */
.u-section { border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.u-section:last-child { border-bottom: none; }
`;
