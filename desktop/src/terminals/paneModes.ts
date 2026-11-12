/**
 * The terminal modes a pane's program set (from tmux's `PANE_MODES` formats, in
 * that order). A resync resets xterm and refills it from `capture-pane`, which
 * carries text only; these put the modes back so the program keeps working as
 * it expects — above all an agent on the alternate screen with mouse reporting,
 * which scrolls its own conversation on wheel events.
 */
export interface PaneModes {
  alt: boolean;
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
  keypadCursor: boolean;
  keypad: boolean;
}

/** tmux's reply ("1 0 0 1 1 0 0 0"), or null when it is not one. */
export function parsePaneModes(text: string): PaneModes | null {
  const f = text.trim().split(/\s+/);
  if (f.length !== 8 || f.some((v) => v !== '0' && v !== '1')) return null;
  const [alt, mouseStandard, mouseButton, mouseAll, mouseSgr, mouseUtf8, keypadCursor, keypad] = f.map((v) => v === '1');
  return { alt, mouseStandard, mouseButton, mouseAll, mouseSgr, mouseUtf8, keypadCursor, keypad };
}

/** Written before the captured text: the screen it belongs on. */
export function screenSequence(m: PaneModes): string {
  return m.alt ? '\x1b[?1049h' : '';
}

/** Written after the captured text: mouse reporting and keypad modes, as the program left them. */
export function modesSequence(m: PaneModes): string {
  let s = '';
  // One tracking mode is in force; the widest wins, as in tmux.
  if (m.mouseAll) s += '\x1b[?1003h';
  else if (m.mouseButton) s += '\x1b[?1002h';
  else if (m.mouseStandard) s += '\x1b[?1000h';
  if (m.mouseSgr) s += '\x1b[?1006h';
  if (m.mouseUtf8) s += '\x1b[?1005h';
  if (m.keypadCursor) s += '\x1b[?1h';
  if (m.keypad) s += '\x1b=';
  return s;
}
