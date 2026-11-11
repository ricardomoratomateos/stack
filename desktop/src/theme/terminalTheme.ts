import type { ITerminalOptions, ITheme } from '@xterm/xterm';

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const;

/**
 * The xterm theme from the `--vscode-terminal-*` variables, the way VS Code's terminal reads its
 * theme keys: `terminal.background` falls back to the editor background (the terminal sits in the
 * editor area), the cursor to the terminal foreground.
 */
export function xtermTheme(get: (cssVar: string) => string): ITheme {
  const v = (key: string, ...fallbacks: string[]): string | undefined => {
    for (const k of [key, ...fallbacks]) {
      const value = get(`--vscode-${k.replace(/\./g, '-')}`).trim();
      if (value) return value;
    }
    return undefined;
  };
  const theme: ITheme = {
    background: v('terminal.background', 'editor.background'),
    foreground: v('terminal.foreground', 'editor.foreground'),
    cursor: v('terminalCursor.foreground', 'terminal.foreground'),
    cursorAccent: v('terminalCursor.background', 'terminal.background', 'editor.background'),
    selectionBackground: v('terminal.selectionBackground'),
    selectionInactiveBackground: v('terminal.inactiveSelectionBackground'),
  };
  const t = theme as Record<string, string | undefined>;
  ANSI.forEach((name) => {
    t[name.toLowerCase()] = v(`terminal.ansi${name}`);
    t[`bright${name}`] = v(`terminal.ansiBright${name}`);
  });
  return theme;
}

/** What VS Code's terminal uses by default (`terminal.integrated.*`), with the editor's font. */
export function terminalOptions(get: (cssVar: string) => string): ITerminalOptions {
  return {
    fontFamily: get('--vscode-editor-font-family').trim() || "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 12, // VS Code default on macOS (editor.fontSize = 12)
    lineHeight: 1,
    cursorBlink: false,
    cursorStyle: 'block',
    theme: xtermTheme(get),
  };
}

/** Reads the variables from the document the app runs in. */
export const documentVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name);
