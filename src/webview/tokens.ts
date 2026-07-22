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

  sectionHeaderFg: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground))',
  sectionHeaderBg: 'var(--vscode-sideBarSectionHeader-background, transparent)',
  titleFg:         'var(--vscode-sideBarTitle-foreground, var(--vscode-foreground))',
} as const;

/** Matches VS Code's native pane-header title (.pane-header h3.title). */
export const SECTION_TITLE_STYLE = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
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
`;
