import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GLOBAL_CSS } from './tokens';
import { ROW_PARTS_CSS, SHARED_CSS } from './styles/shared';
import { ASIDE_CSS } from './styles/aside/aside.css';
import { CLAUDE_CSS } from './styles/claude/claude.css';
import { MISSION_CSS } from './styles/mission/mission.css';

// All three stylesheets are always present and scoped by their root class, so
// switching style is a re-render rather than a stylesheet swap. Layout CSS
// comes after the shared CSS: where they set the same property at equal
// specificity, the layout wins.
const style = document.createElement('style');
style.textContent = [GLOBAL_CSS, SHARED_CSS, ROW_PARTS_CSS, CLAUDE_CSS, MISSION_CSS, ASIDE_CSS].join('\n');
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
