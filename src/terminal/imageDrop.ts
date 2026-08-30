import * as path from 'node:path';

/** File types the built-in image preview opens — what a screenshot drop produces. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

/**
 * Which terminal in the drop's editor group receives the image.
 *
 * VS Code opens a dropped file beside the group's active tab, so when the group
 * holds several agent viewers the one that was active just before the image
 * took over is the one the user dropped onto. With one viewer there is nothing
 * to choose; with none, nobody in this group can take it.
 */
export function pickTerminalLabel(labels: readonly string[], lastActive: string | undefined): string | undefined {
  if (lastActive !== undefined && labels.includes(lastActive)) return lastActive;
  return labels[0];
}

/**
 * Whether an image that just opened plausibly arrived by drop rather than by a
 * deliberate double-click in the Explorer: fresh off the disk, or from the
 * folder macOS drops screenshots into. Keeps Foreman from hijacking every
 * image the user opens on purpose.
 */
export function looksLikeScreenshot(opts: {
  file: string;
  mtimeMs: number | undefined;
  nowMs: number;
  screenshotDir: string | undefined;
  maxAgeMs?: number;
}): boolean {
  const maxAge = opts.maxAgeMs ?? 2 * 60_000;
  if (opts.mtimeMs !== undefined && opts.nowMs - opts.mtimeMs <= maxAge) return true;
  if (opts.screenshotDir && opts.file.startsWith(opts.screenshotDir + path.sep)) return true;
  return false;
}
