import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewTaskPanel } from './NewTaskPanel';
import { GLOBAL_CSS } from '../../webview/tokens';

const style = document.createElement('style');
style.textContent = GLOBAL_CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<NewTaskPanel />);
