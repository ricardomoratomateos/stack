import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTerminals, useVisiblePanes } from './useTerminals';

/** Renders one pane's terminal; unmounting (or changing `pane`) stops rendering it. */
export function PaneTerminal({ pane, className }: { pane: string; className?: string }) {
  const { registry } = useTerminals();
  const host = useRef<HTMLDivElement>(null);
  useVisiblePanes([pane]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    registry.show(pane, el);
    return () => registry.hide(pane);
  }, [registry, pane]);

  return <div ref={host} className={className} style={{ width: '100%', height: '100%' }} />;
}
