import React from 'react';
import { createRoot } from 'react-dom/client';
import { DiffApp } from './DiffApp';
import { DIFF_CSS } from './styles';

const style = document.createElement('style');
style.textContent = DIFF_CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<DiffApp />);
