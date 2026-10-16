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
`;
