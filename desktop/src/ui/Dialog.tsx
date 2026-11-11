import { useEffect, useRef, useState } from 'react';

export type DialogSpec =
  | { kind: 'ask'; title: string; label: string; initial: string; confirm: string; onSubmit: (text: string) => void }
  | { kind: 'confirm'; title: string; detail: string; choices: string[]; onChoose: (index: number) => void };

/** A small modal for the questions the extension asks with VS Code's input box and dialogs. */
export function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const [text, setText] = useState(spec.kind === 'ask' ? spec.initial : '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label={spec.title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{spec.title}</h2>
        {spec.kind === 'ask' ? (
          <form onSubmit={(e) => { e.preventDefault(); spec.onSubmit(text); onClose(); }}>
            <label>
              <span>{spec.label}</span>
              <input ref={input} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="dialog-buttons">
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              <button type="submit">{spec.confirm}</button>
            </div>
          </form>
        ) : (
          <>
            <p className="dialog-detail">{spec.detail}</p>
            <div className="dialog-buttons">
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              {spec.choices.map((c, i) => (
                <button key={c} type="button" onClick={() => { spec.onChoose(i); onClose(); }}>{c}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
