import { describe, expect, it } from 'vitest';
import { dropText, shellEscapePath } from './fileDrop';

describe('file drops', () => {
  it('escapes paths like Terminal.app', () => {
    expect(shellEscapePath('/Users/r/Desktop/Captura de pantalla (1).png')).toBe('/Users/r/Desktop/Captura\\ de\\ pantalla\\ \\(1\\).png');
    expect(shellEscapePath("/tmp/it's.png")).toBe("/tmp/it\\'s.png");
  });
  it('joins several paths with spaces and ends with one', () => {
    expect(dropText(['/a.png', '/b c.jpg'])).toBe('/a.png /b\\ c.jpg ');
    expect(dropText([])).toBe('');
  });
});
