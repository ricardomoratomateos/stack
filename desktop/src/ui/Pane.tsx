import type { ReactNode } from 'react';
import { PaneTerminal } from '../terminals';
import type { Resolved } from './useSessionPane';

/** A session's terminal, or why there is none yet. */
export function SessionView({ resolved, empty }: { resolved: Resolved; empty: ReactNode }) {
  if (resolved.error) return <div className="placeholder error">{resolved.error}</div>;
  if (!resolved.pane) return <div className="placeholder">{empty}</div>;
  return <PaneTerminal key={resolved.pane} pane={resolved.pane} className="term" />;
}
