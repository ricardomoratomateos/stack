import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsApp } from './SettingsApp';
import { GLOBAL_CSS } from '../../webview/tokens';
import { SETTINGS_CSS } from './styles';

const style = document.createElement('style');
style.textContent = GLOBAL_CSS + SETTINGS_CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<SettingsApp />);
