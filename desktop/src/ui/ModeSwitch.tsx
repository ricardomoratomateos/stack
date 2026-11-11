import { MODES, type Mode } from '../modes/layout';

const NAME: Record<Mode, string> = { full: 'Full', half: 'Half', float: 'Float' };

/** Full / Half / Float, in the title area. */
export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Window mode" title="⌘⇧F cycles the mode">
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={m === mode} data-active={m === mode || undefined} onClick={() => onChange(m)}>{NAME[m]}</button>
      ))}
    </div>
  );
}
