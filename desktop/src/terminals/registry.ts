import { Terminal, type ILink } from '@xterm/xterm';
import { findUrls, opensLink } from './links';
import { documentVar, terminalOptions, xtermTheme } from '../theme/terminalTheme';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import type { TmuxApi } from './api';
import { concatChunks, nextHistoryStart, toTerminalText } from './bytes';
import { lastLines } from './lastLines';
import { modesSequence, parsePaneModes, screenSequence } from './paneModes';
import { log } from '../log';

export const SCROLLBACK = 2000;

/**
 * Plain-text URLs on buffer row `y` (1-based), found in its whole wrapped line so a
 * URL that wraps onto the next row is one link. Each string offset maps back to
 * its cell, so wide characters before the URL don't shift the range.
 */
function plainLinks(term: Terminal, y: number, activate: (e: MouseEvent, url: string) => void): ILink[] | undefined {
  const buf = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const cells: { x: number; y: number }[] = [];
  for (let row = first; row <= last; row++) {
    const line = buf.getLine(row);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1 });
      text += chars;
    }
  }
  const links = findUrls(text)
    .map(({ url, start, end }): ILink => ({
      text: url,
      range: { start: cells[start], end: cells[end - 1] },
      activate: (e) => activate(e, url),
    }))
    .filter((l) => l.range.start.y <= y && l.range.end.y >= y);
  return links.length ? links : undefined;
}

interface Entry {
  term: Terminal;
  webgl?: WebglAddon;
  fit: FitAddon;
  observer?: ResizeObserver;
  el?: HTMLElement;
  /** Output queued until the initial capture is written. */
  pending: Uint8Array[] | null;
  /** Missed output while hidden: redo the capture when shown again. */
  stale: boolean;
  /** History depth requested by the last capture. */
  loaded: number;
  /** Lines the last capture returned. */
  count: number;
  loadingHistory: boolean;
  /** Output waiting for the next animation frame. */
  queue: Uint8Array[];
  queued: number;
}

/** Output a shown pane may hold before a frame (a hidden window runs no frames); beyond it the pane resyncs. */
export const MAX_QUEUED = 8 * 1024 * 1024;

export interface Scheduler {
  request(cb: () => void): void;
}
const rafScheduler: Scheduler = { request: (cb) => void requestAnimationFrame(cb) };

/**
 * One xterm per pane, created lazily. A terminal is only attached to the DOM
 * (and gets the WebGL renderer) while shown; hidden ones keep their state but
 * stop receiving output, so they are resynced from `capture-pane` on show.
 */
export class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private shown = new Set<string>();

  private dirty = new Set<string>();
  private scheduled = false;

  constructor(private api: TmuxApi, private scheduler: Scheduler = rafScheduler) {}

  /** Re-reads the theme (the chrome palette just landed on <html>) into every open terminal. */
  refreshTheme(): void {
    const theme = xtermTheme(documentVar);
    for (const e of this.entries.values()) e.term.options.theme = theme;
  }

  has(pane: string): boolean {
    return this.entries.has(pane);
  }

  /** Terminal for a pane, created on first use (not yet in the DOM). */
  terminal(pane: string): Terminal {
    return this.ensure(pane).term;
  }

  /** Called for every output chunk; written to xterm once per animation frame, per pane. */
  feed(pane: string, bytes: Uint8Array): void {
    const e = this.entries.get(pane);
    if (!e) return this.ack(bytes.length);
    if (!this.shown.has(pane)) {
      // hidden panes are paused by the backend; whatever slipped through is not enough
      e.stale = true;
      return this.ack(bytes.length);
    }
    if (e.pending) {
      e.pending.push(bytes);
      return;
    }
    e.queue.push(bytes);
    e.queued += bytes.length;
    if (e.queued > MAX_QUEUED) {
      this.ack(e.queued);
      e.queue = [];
      e.queued = 0;
      e.stale = true;
      this.dirty.delete(pane);
      void this.sync(pane);
      return;
    }
    this.dirty.add(pane);
    if (!this.scheduled) {
      this.scheduled = true;
      this.scheduler.request(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const panes = [...this.dirty];
    this.dirty.clear();
    for (const pane of panes) {
      const e = this.entries.get(pane);
      if (!e || e.queue.length === 0 || e.pending) continue;
      const data = concatChunks(e.queue, e.queued);
      e.queue = [];
      e.queued = 0;
      this.write(e, data);
    }
  }

  /** Write to xterm and tell the backend once it is parsed (that is what paces the flow). */
  private write(e: Entry, data: Uint8Array): void {
    e.term.write(data, () => this.ack(data.length));
  }

  private ack(bytes: number): void {
    if (bytes > 0) void this.api.ackOutput(bytes).catch(() => {});
  }

  /** Last `n` lines of a pane's buffer (for the Manager strip). */
  lines(pane: string, n: number): string[] {
    const e = this.entries.get(pane);
    return e ? lastLines(e.term.buffer.active, n) : [];
  }

  /** Subscribe to writes of a pane's terminal; returns unsubscribe. */
  onChange(pane: string, cb: () => void): () => void {
    const d = this.ensure(pane).term.onWriteParsed(cb);
    return () => d.dispose();
  }

  /** Render `pane` into `el` (replacing whatever was in it). */
  show(pane: string, el: HTMLElement): void {
    const e = this.ensure(pane);
    this.shown.add(pane);
    if (e.el !== el) {
      el.replaceChildren();
      if (e.el) this.detach(e);
      e.el = el;
      el.dataset.pane = pane;
      // xterm ignores a second `open()`: move its existing element into the new host instead.
      if (e.term.element) el.appendChild(e.term.element);
      else e.term.open(el);
      this.enableWebgl(e);
      e.term.refresh(0, e.term.rows - 1);
      let raf = 0;
      e.observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => this.fit(pane, e));
      });
      e.observer.observe(el);
    }
    // Size the pane's own window to this element first, then fill it, so the capture matches.
    const sized = this.fit(pane, e, true);
    if (e.stale || e.loaded === 0) void sized.then(() => this.sync(pane));
  }

  /** Paste text into a pane the way the user's paste would (bracketed when the app asked for it). */
  paste(pane: string, text: string): void {
    void this.api.pasteText(pane, text).catch(() => {});
  }

  /** Focus a pane's terminal (it must be shown). */
  focus(pane: string): void {
    this.entries.get(pane)?.term.focus();
  }

  /**
   * Fit the terminal to its element. `term.onResize` already tells tmux when
   * the size changes; `force` tells it anyway (the window may have been sized
   * by another view since this one was last shown).
   */
  private async fit(pane: string, e: Entry, force = false): Promise<void> {
    const before = [e.term.cols, e.term.rows];
    try {
      e.fit.fit();
    } catch {
      return; // not laid out yet
    }
    if (force && before[0] === e.term.cols && before[1] === e.term.rows) {
      await this.api.resize(pane, e.term.cols, e.term.rows).catch(() => {});
    }
  }

  /** Stop rendering `pane` (keeps its buffer). */
  hide(pane: string): void {
    const e = this.entries.get(pane);
    this.shown.delete(pane);
    if (e) this.detach(e);
  }

  /** Track a pane that is read but not rendered (Manager strip). */
  watch(pane: string): void {
    const e = this.ensure(pane);
    this.shown.add(pane);
    if (e.stale || e.loaded === 0) void this.sync(pane);
  }

  unwatch(pane: string): void {
    const e = this.entries.get(pane);
    if (e && !e.el) this.shown.delete(pane);
  }

  /** Panes that must keep receiving output. */
  active(): string[] {
    return [...this.shown];
  }

  dispose(pane: string): void {
    const e = this.entries.get(pane);
    if (!e) return;
    this.ack(e.queued);
    this.detach(e);
    e.term.dispose();
    this.entries.delete(pane);
    this.shown.delete(pane);
    this.dirty.delete(pane);
  }

  disposeAll(): void {
    for (const p of [...this.entries.keys()]) this.dispose(p);
  }

  private detach(e: Entry): void {
    e.observer?.disconnect();
    e.observer = undefined;
    e.webgl?.dispose();
    e.webgl = undefined;
    e.el?.replaceChildren();
    e.el = undefined;
    e.stale = true;
  }

  private enableWebgl(e: Entry): void {
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
        e.webgl = undefined; // falls back to the DOM renderer
      });
      e.term.loadAddon(gl);
      e.webgl = gl;
    } catch {
      // no WebGL: xterm keeps its DOM renderer
    }
  }

  private ensure(pane: string): Entry {
    let e = this.entries.get(pane);
    if (e) return e;
    const open = (e: MouseEvent, url: string) => {
      if (!opensLink(e)) return;
      void this.api.openUrl(url).catch((err) => log('warn', 'link', url, String(err)));
    };
    const term = new Terminal({
      scrollback: SCROLLBACK,
      ...terminalOptions(documentVar),
      allowProposedApi: true,
      // OSC 8 hyperlinks: xterm's default asks with confirm() and window.open, neither of which works here.
      linkHandler: { activate: open },
    });
    term.registerLinkProvider({ provideLinks: (y, cb) => cb(plainLinks(term, y, open)) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    e = { term, fit, pending: null, queue: [], queued: 0, stale: false, loaded: 0, count: 0, loadingHistory: false };
    const entry = e;
    term.onData((s) => void this.api.write(pane, [...new TextEncoder().encode(s)]));
    term.onBinary((s) => void this.api.write(pane, [...s].map((c) => c.charCodeAt(0) & 0xff)));
    term.onResize(({ cols, rows }) => void this.api.resize(pane, cols, rows));
    // ⌘V: WKWebView hands a paste event no image data, so ask macOS what is on the clipboard.
    // An image → Ctrl+V, which is how Claude Code and Codex attach one; text → a normal paste.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === 'Tab') return false; // ⌃Tab is the worktree switcher, not the pane's
      if (ev.type !== 'keydown' || !ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.toLowerCase() !== 'v') return true;
      ev.preventDefault();
      void this.api.clipboardPaste().then(
        (c) => (c.image ? this.api.write(pane, [0x16]) : c.text ? this.api.pasteText(pane, c.text) : undefined),
        () => {},
      );
      return false;
    });
    term.onScroll((top) => {
      if (top === 0 && entry.loaded > 0 && term.buffer.active.type === 'normal') void this.loadOlder(pane);
    });
    this.entries.set(pane, e);
    return e;
  }

  /** Reset and refill the terminal from tmux (screen plus `SCROLLBACK` lines). */
  private async sync(pane: string): Promise<void> {
    const e = this.entries.get(pane);
    if (!e) return;
    e.stale = false;
    this.ack(e.queued);
    e.queue = [];
    e.queued = 0;
    e.pending = [];
    try {
      // reset() drops the modes the program set (alternate screen, mouse reporting…): read them first.
      const started = performance.now();
      // One round trip: capture, modes and cursor go to tmux together.
      const [text, rawModes, cursor] = await Promise.all([
        this.api.capture(pane, -SCROLLBACK),
        this.api.paneModes(pane).catch(() => ''),
        this.api.paneCursor(pane).catch(() => null),
      ]);
      const fetched = performance.now();
      // On the alternate screen the history lines scroll straight off: what stays is its screen.
      const modes = parsePaneModes(rawModes);
      e.term.reset();
      if (modes) e.term.write(screenSequence(modes));
      e.term.write(toTerminalText(text));
      // The capture leaves xterm's cursor after the last character and visible: put it where tmux has it.
      if (cursor) e.term.write(`\x1b[${cursor[1] + 1};${cursor[0] + 1}H\x1b[?25${cursor[2] ? 'h' : 'l'}`);
      e.term.write(modes ? modesSequence(modes) : '', () =>
        log('info', 'sync', pane, `tmux ${Math.round(fetched - started)}ms`, `draw ${Math.round(performance.now() - fetched)}ms`, `${text.length}B`, modes?.alt ? 'alt' : ''));
      e.loaded = SCROLLBACK;
      e.count = text.split('\n').length;
    } catch {
      e.stale = true;
    }
    const queued = e.pending;
    e.pending = null;
    for (const b of queued ?? []) this.write(e, b);
  }

  /** Scrolled to the top: refill with more history and keep the scrollback in step. */
  private async loadOlder(pane: string): Promise<void> {
    const e = this.entries.get(pane);
    if (!e || e.loadingHistory) return;
    const start = nextHistoryStart(e.loaded);
    if (start === null) return;
    e.loadingHistory = true;
    try {
      const text = await this.api.capture(pane, start);
      const count = text.split('\n').length;
      if (count <= e.count) {
        e.loaded = Number.MAX_SAFE_INTEGER; // nothing older: stop asking
        return;
      }
      this.ack(e.queued);
      e.queue = [];
      e.queued = 0;
      e.pending = [];
      e.term.options.scrollback = -start;
      e.term.reset();
      e.term.write(toTerminalText(text), () => e.term.scrollToTop());
      e.loaded = -start;
      e.count = count;
      const queued = e.pending;
      e.pending = null;
      for (const b of queued ?? []) this.write(e, b);
    } catch {
      // keep what we have
    } finally {
      e.loadingHistory = false;
    }
  }
}
