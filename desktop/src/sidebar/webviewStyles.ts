import '@codicons/codicon.css';
import { WEBVIEW_CSS } from '@core/webview/css';

// The same stylesheet index.tsx of the extension's webview injects.
const style = document.createElement('style');
style.id = 'stack-webview-css';
style.textContent = WEBVIEW_CSS;
document.head.appendChild(style);
document.body.classList.add('vscode-dark');
document.body.dataset.vscodeThemeKind = 'vscode-dark';
