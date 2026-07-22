import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GLOBAL_CSS } from './tokens';

const style = document.createElement('style');
style.textContent = GLOBAL_CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
