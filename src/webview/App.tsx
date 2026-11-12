import React from 'react';
import { useSidebar } from './useSidebar';
import { Aside } from './styles/aside/Aside';

/**
 * The sidebar: one data layer (useSidebar) under the Aside layout.
 * (The native view header above carries the "Worktrees" title, the live counts
 * and the "+" and gear buttons, so the layout does not draw its own.)
 */
export function App() {
  return <Aside {...useSidebar()} />;
}
