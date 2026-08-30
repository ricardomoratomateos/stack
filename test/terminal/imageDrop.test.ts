import { describe, it, expect } from 'vitest';
import { isImagePath, pickTerminalLabel, looksLikeScreenshot } from '../../src/terminal/imageDrop';

describe('isImagePath', () => {
  it.each(['a.png', 'Screenshot 2026-08-30 at 09.12.33.PNG', 'x.jpg', 'x.jpeg', 'x.webp', 'x.gif', 'x.heic'])('accepts %s', (f) => {
    expect(isImagePath(f)).toBe(true);
  });
  it.each(['notes.md', 'diagram.svg', 'a.png.txt', 'video.mov'])('rejects %s', (f) => {
    expect(isImagePath(f)).toBe(false);
  });
});

describe('pickTerminalLabel', () => {
  it('takes the terminal that was active before the image opened when the group holds several', () => {
    expect(pickTerminalLabel(['claude: develop', 'claude: feat/x'], 'claude: feat/x')).toBe('claude: feat/x');
  });
  it('falls back to the first viewer when the remembered one is gone from the group', () => {
    expect(pickTerminalLabel(['claude: develop', 'claude: feat/x'], 'claude: old')).toBe('claude: develop');
  });
  it('is the only viewer when there is one, and nothing when there is none', () => {
    expect(pickTerminalLabel(['claude: develop'], undefined)).toBe('claude: develop');
    expect(pickTerminalLabel([], 'claude: develop')).toBeUndefined();
  });
});

describe('looksLikeScreenshot', () => {
  const now = 1_000_000_000;
  it('accepts a file written in the last two minutes, wherever it is', () => {
    expect(looksLikeScreenshot({ file: '/tmp/x.png', mtimeMs: now - 90_000, nowMs: now, screenshotDir: undefined })).toBe(true);
  });
  it('rejects an old file outside the screenshots folder — that was opened on purpose', () => {
    expect(looksLikeScreenshot({ file: '/repo/docs/logo.png', mtimeMs: now - 3_600_000, nowMs: now, screenshotDir: '/Users/me/Desktop' })).toBe(false);
  });
  it('accepts an old file when it lives in the screenshots folder', () => {
    expect(looksLikeScreenshot({ file: '/Users/me/Desktop/shot.png', mtimeMs: now - 3_600_000, nowMs: now, screenshotDir: '/Users/me/Desktop' })).toBe(true);
    // Prefix match is on a path segment, not a string prefix.
    expect(looksLikeScreenshot({ file: '/Users/me/Desktop2/shot.png', mtimeMs: now - 3_600_000, nowMs: now, screenshotDir: '/Users/me/Desktop' })).toBe(false);
  });
  it('rejects when the file could not be stat-ed and is not in the folder', () => {
    expect(looksLikeScreenshot({ file: '/x.png', mtimeMs: undefined, nowMs: now, screenshotDir: undefined })).toBe(false);
  });
});
