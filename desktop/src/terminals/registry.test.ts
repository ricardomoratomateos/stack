import { describe, expect, it, vi } from 'vitest';

const writes: { id: number; data: Uint8Array }[] = [];
let nextId = 0;
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    id = nextId++;
    options = {};
    loadAddon() {}
    onData() {}
    onBinary() {}
    onResize() {}
    onScroll() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    reset() {}
    rows = 24;
    element?: { host?: unknown };
    opens = 0;
    open(host: unknown) {
      this.opens++;
      this.element = { host };
    }
    refresh() {}
    focus() {}
    write(data: Uint8Array, cb?: () => void) {
      writes.push({ id: this.id, data });
      cb?.();
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('../theme/terminalTheme', () => ({ documentVar: () => '', terminalOptions: () => ({}) }));

import { MAX_QUEUED, TerminalRegistry } from './registry';
import type { TmuxApi } from './api';

const acked = (api: TmuxApi) => (api.ackOutput as ReturnType<typeof vi.fn>).mock.calls.reduce((a, c) => a + (c[0] as number), 0);

function setup() {
  const frames: (() => void)[] = [];
  const api = { capture: vi.fn(async () => ''), paneCursor: vi.fn(async () => [0, 0, true]), paneModes: vi.fn(async () => '0 0 0 0 0 0 0 0'), clipboardPaste: vi.fn(async () => ({ image: false, text: '' })), resize: vi.fn(async () => {}), write: vi.fn(async () => {}), ackOutput: vi.fn(async () => {}) } as unknown as TmuxApi;
  const reg = new TerminalRegistry(api, { request: (cb) => void frames.push(cb) });
  writes.length = 0;
  return { reg, frames, api };
}

describe('TerminalRegistry output', () => {
  it('writes once per frame per pane, joining the chunks', () => {
    const { reg, frames, api } = setup();
    reg.watch('%1');
    reg.watch('%2');
    reg.terminal('%1');
    // `watch` kicks off a capture whose queue gets flushed asynchronously; start clean
    return new Promise((r) => setTimeout(r, 0)).then(() => {
      writes.length = 0;
      reg.feed('%1', new Uint8Array([1, 2]));
      reg.feed('%1', new Uint8Array([3]));
      reg.feed('%2', new Uint8Array([9]));
      expect(writes).toHaveLength(0);
      expect(frames).toHaveLength(1);
      frames[0]();
      expect(writes.map((w) => Array.from(w.data))).toEqual([[1, 2, 3], [9]]);
      expect(acked(api)).toBe(4);
    });
  });

  it('does not write hidden panes, only marks them stale', () => {
    const { reg, frames, api } = setup();
    reg.terminal('%1');
    reg.feed('%1', new Uint8Array([1]));
    expect(frames).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(acked(api)).toBe(1); // dropped data is acknowledged at once
  });

  it('an oversized backlog is dropped and the pane resyncs from capture', async () => {
    const { reg, api } = setup();
    reg.watch('%1');
    await new Promise((r) => setTimeout(r, 0));
    (api.capture as ReturnType<typeof vi.fn>).mockClear();
    reg.feed('%1', new Uint8Array(MAX_QUEUED + 1));
    expect(api.capture).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalRegistry show/hide', () => {
  it('moves the existing terminal element into a new host instead of reopening it', () => {
    (globalThis as Record<string, unknown>).ResizeObserver ??= class { observe() {} disconnect() {} };
    const { reg } = setup();
    const host = () => {
      const children: unknown[] = [];
      return { children, dataset: {}, addEventListener() {}, removeEventListener() {}, replaceChildren: () => void children.splice(0), appendChild: (c: unknown) => void children.push(c) };
    };
    const a = host();
    const b = host();
    reg.show('%1', a as unknown as HTMLElement);
    reg.hide('%1');
    reg.show('%1', b as unknown as HTMLElement);
    const term = (reg as unknown as { entries: Map<string, { term: { opens: number; element: unknown } }> }).entries.get('%1')!.term;
    expect(term.opens).toBe(1);
    expect(b.children).toEqual([term.element]);
  });
});
