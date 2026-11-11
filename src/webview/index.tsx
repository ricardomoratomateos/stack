import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WEBVIEW_CSS } from './css';

const style = document.createElement('style');
style.textContent = WEBVIEW_CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
