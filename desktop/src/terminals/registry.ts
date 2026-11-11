import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TmuxApi } from './api';
import { base64ToBytes, nextHistoryStart, toTerminalText } from './bytes';
import { lastLines } from './lastLines';

export const SCROLLBACK = 2000;

interface Entry {
  term: Terminal;
  webgl?: WebglAddon;
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
}

/**
 * One xterm per pane, created lazily. A terminal is only attached to the DOM
 * (and gets the WebGL renderer) while shown; hidden ones keep their state but
 * stop receiving output, so they are resynced from `capture-pane` on show.
 */
export class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private shown = new Set<string>();

  constructor(private api: TmuxApi) {}

  has(pane: string): boolean {
    return this.entries.has(pane);
  }

  /** Terminal for a pane, created on first use (not yet in the DOM). */
  terminal(pane: string): Terminal {
    return this.ensure(pane).term;
  }

  /** Called for every `tmux://output` event. */
  feed(pane: string, b64: string): void {
    const e = this.entries.get(pane);
    if (!e) return;
    if (!this.shown.has(pane)) {
      // hidden panes are paused by the backend; whatever slipped through is not enough
      e.stale = true;
      return;
    }
    const bytes = base64ToBytes(b64);
    if (e.pending) e.pending.push(bytes);
    else e.term.write(bytes);
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
      e.term.open(el);
      this.enableWebgl(e);
    }
    if (e.stale || e.loaded === 0) void this.sync(pane);
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
    this.detach(e);
    e.term.dispose();
    this.entries.delete(pane);
    this.shown.delete(pane);
  }

  disposeAll(): void {
    for (const p of [...this.entries.keys()]) this.dispose(p);
  }

  private detach(e: Entry): void {
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
    const term = new Terminal({
      scrollback: SCROLLBACK,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
    });
    e = { term, pending: null, stale: false, loaded: 0, count: 0, loadingHistory: false };
    const entry = e;
    term.onData((s) => void this.api.write(pane, [...new TextEncoder().encode(s)]));
    term.onBinary((s) => void this.api.write(pane, [...s].map((c) => c.charCodeAt(0) & 0xff)));
    term.onResize(({ cols, rows }) => void this.api.resize(pane, cols, rows));
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
    e.pending = [];
    try {
      const text = await this.api.capture(pane, -SCROLLBACK);
      e.term.reset();
      e.term.write(toTerminalText(text));
      e.loaded = SCROLLBACK;
      e.count = text.split('\n').length;
    } catch {
      e.stale = true;
    }
    const queued = e.pending;
    e.pending = null;
    for (const b of queued ?? []) e.term.write(b);
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
      e.pending = [];
      e.term.options.scrollback = -start;
      e.term.reset();
      e.term.write(toTerminalText(text), () => e.term.scrollToTop());
      e.loaded = -start;
      e.count = count;
      const queued = e.pending;
      e.pending = null;
      for (const b of queued ?? []) e.term.write(b);
    } catch {
      // keep what we have
    } finally {
      e.loadingHistory = false;
    }
  }
}
