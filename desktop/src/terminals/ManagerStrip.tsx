import { useEffect, useState } from 'react';
import { useTerminals, useVisiblePanes } from './useTerminals';

/** The last `lines` lines of a pane, read from its xterm buffer (nothing is rendered by xterm). */
export function ManagerStrip({ pane, lines = 6 }: { pane: string | null; lines?: number }) {
  const { registry } = useTerminals();
  const [text, setText] = useState<string[]>([]);
  useVisiblePanes([pane]);

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

  return (
    <pre className="manager-strip" style={{ margin: 0, padding: 8, minHeight: `${lines * 1.3}em`, overflow: 'hidden', background: '#111', color: '#ddd', fontSize: 12 }}>
      {text.join('\n')}
    </pre>
  );
}
