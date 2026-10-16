import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewTaskPanel } from './NewTaskPanel';
import { GLOBAL_CSS } from '../../webview/tokens';
import { NEWTASK_CSS } from './newtask.css';

const style = document.createElement('style');
style.textContent = `${GLOBAL_CSS}\n${NEWTASK_CSS}`;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<NewTaskPanel />);
