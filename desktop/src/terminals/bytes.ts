/** Output frame from the backend: u32 LE pane number, then the raw bytes (`%12` -> 12). */
export function decodeFrame(buf: ArrayBuffer | Uint8Array): { pane: string; data: Uint8Array } | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 4) return null;
  const n = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
  return { pane: `%${n}`, data: u8.subarray(4) };
}

/** Join chunks into one array (the chunk itself when there is only one). */
export function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
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
