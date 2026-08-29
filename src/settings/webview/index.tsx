import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsApp } from './SettingsApp';
import { GLOBAL_CSS } from '../../webview/tokens';

const style = document.createElement('style');
style.textContent = GLOBAL_CSS + `
body { background: var(--vscode-editor-background); overflow-y: auto; }
.u-input {
  width: 100%; padding: 6px 9px; border-radius: 6px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
  outline: none; font-family: inherit; font-size: 13px;
}
.u-input:focus { border-color: var(--vscode-focusBorder); }
.u-input.mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
.u-btn {
  padding: 6px 14px; border-radius: 6px; border: 1px solid transparent; font-size: 13px; font-family: inherit;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
}
.u-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.u-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.u-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.u-btn:disabled { opacity: .45; cursor: default; }
.u-btn.small { padding: 3px 9px; font-size: 12px; }
.u-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.u-chip.suggest { background: transparent; border-style: dashed; cursor: pointer; }
.u-chip.suggest:hover { background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.u-chip button { background: none; border: none; color: inherit; padding: 0; line-height: 1; opacity: .6; }
.u-chip button:hover { opacity: 1; }
select.u-input { appearance: none; -webkit-appearance: none; padding-right: 26px; cursor: pointer; }
`;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<SettingsApp />);
