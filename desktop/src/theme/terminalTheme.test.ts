import { describe, expect, it } from 'vitest';
import { terminalOptions, xtermTheme } from './terminalTheme';

const vars: Record<string, string> = {
  '--vscode-editor-background': '#1F1F1F',
  '--vscode-terminal-foreground': '#CCCCCC',
  '--vscode-terminal-ansiRed': '#cd3131',
  '--vscode-terminal-ansiBrightRed': '#f14c4c',
  '--vscode-terminal-selectionBackground': '#264F78',
  '--vscode-editor-font-family': " Menlo, Monaco, 'Courier New', monospace",
};
const get = (n: string) => vars[n] ?? '';

describe('xtermTheme', () => {
  it('reads the terminal keys and falls back like VS Code', () => {
    const t = xtermTheme(get);
    expect(t.background).toBe('#1F1F1F');
    expect(t.foreground).toBe('#CCCCCC');
    expect(t.cursor).toBe('#CCCCCC');
    expect(t.red).toBe('#cd3131');
    expect(t.brightRed).toBe('#f14c4c');
    expect(t.selectionBackground).toBe('#264F78');
  });
  it('prefers terminal.background when the theme sets it', () => {
    expect(xtermTheme((n) => (n === '--vscode-terminal-background' ? '#000' : get(n))).background).toBe('#000');
  });
  it('paints the background with the chrome token when it resolves to a colour', () => {
    expect(xtermTheme((n) => (n === '--app-bg' ? '#111111' : get(n))).background).toBe('#111111');
    expect(xtermTheme((n) => (n === '--app-bg' ? 'color-mix(in srgb, red, blue)' : get(n))).background).toBe('#1F1F1F');
  });
  it('uses the editor font', () => {
    expect(terminalOptions(get).fontFamily).toBe("Menlo, Monaco, 'Courier New', monospace");
  });
});
