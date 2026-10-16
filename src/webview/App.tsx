import React from 'react';
import { normalizeSidebarStyle } from '../sidebarStyle';
import { useSidebar } from './useSidebar';
import { Aside } from './styles/aside/Aside';
import { Claude } from './styles/claude/Claude';
import { Mission } from './styles/mission/Mission';

/**
 * The sidebar: one data layer (useSidebar) under three presentational layouts.
 * Which one renders is the `foreman.sidebarStyle` setting, carried in the state
 * the extension pushes, so changing it takes effect on the next push, no reload.
 * (The native view header above carries the "Worktrees" title, the live counts
 * and the "+" and gear buttons, so none of the layouts draws its own.)
 */
export function App() {
  const sidebar = useSidebar();

  switch (normalizeSidebarStyle(sidebar.state.sidebarStyle)) {
    case 'claude':
      return <Claude {...sidebar} />;
    case 'mission':
      return <Mission {...sidebar} />;
    case 'aside':
      return <Aside {...sidebar} />;
  }
}
