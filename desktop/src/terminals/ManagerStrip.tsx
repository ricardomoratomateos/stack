import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { LINE_H, stripInput, stripRows } from '../modes/layout';
import { useTerminals, useVisiblePanes } from './useTerminals';

export interface StripHandle {
  focus(): void;
}

/**
 * The Manager as a strip: its last `lines` lines (read from the xterm buffer, nothing is rendered by
 * xterm) and an input line that types into the Manager pane.
 */
export const ManagerStrip = forwardRef<StripHandle, { pane: string | null; lines: number }>(function ManagerStrip({ pane, lines }, ref) {
  const { registry, api } = useTerminals();
  const [text, setText] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useVisiblePanes([pane]);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  useEffect(() => {
    if (!pane) {
      setText([]);
      return;
    }
    registry.watch(pane);
    let raf = 0;
    const refresh = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setText(registry.lines(pane, lines)));
    };
    const off = registry.onChange(pane, refresh);
    refresh();
    return () => {
      off();
      cancelAnimationFrame(raf);
      registry.unwatch(pane);
    };
  }, [registry, pane, lines]);

  const send = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter' || !pane || e.nativeEvent.isComposing) return;
    void api.write(pane, stripInput(e.currentTarget.value)).catch(() => {});
    e.currentTarget.value = '';
  };

  return (
    <>
      <pre className="manager-strip" aria-label="Manager, last lines" style={{ height: lines * LINE_H }}>{stripRows(text, lines).join('\n')}</pre>
      <input ref={input} className="manager-input" placeholder={pane ? 'Tell the Manager…  (⌘0)' : 'The Manager is not running'} disabled={!pane} spellCheck={false} onKeyDown={send} />
    </>
  );
});
