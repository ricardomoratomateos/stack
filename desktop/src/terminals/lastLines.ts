/** The slice of xterm's buffer the helper needs (lets tests use a fake). */
export interface LineBuffer {
  length: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * Last `n` non-trailing-empty lines of a buffer: trailing blank rows (the
 * unused part of the viewport) are dropped first, so a fresh prompt shows.
 */
export function lastLines(buffer: LineBuffer, n: number): string[] {
  let end = buffer.length;
  while (end > 0 && (buffer.getLine(end - 1)?.translateToString(true) ?? '') === '') end--;
  const out: string[] = [];
  for (let y = Math.max(0, end - n); y < end; y++) {
    out.push(buffer.getLine(y)?.translateToString(true) ?? '');
  }
  return out;
}
