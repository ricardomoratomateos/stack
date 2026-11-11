export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `capture-pane` text uses bare `\n`; terminals need `\r\n`. */
export function toTerminalText(captured: string): string {
  return captured.replace(/\r?\n/g, '\r\n');
}

/** Lines to load when the user scrolled to the top having `loaded` lines of history. */
export function nextHistoryStart(loaded: number, step = 1000, max = 20000): number | null {
  const want = loaded + step;
  if (loaded >= max) return null;
  return -Math.min(want, max);
}
