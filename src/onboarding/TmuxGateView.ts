import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { TmuxInstall } from './tmuxGate';

const GUIDE_URL = 'https://github.com/tmux/tmux/wiki/Installing';

/**
 * The Worktrees panel shown while the extension is gated off for lack of tmux.
 *
 * Registered in place of the real sidebar webview when tmux is missing, so the
 * panel states the requirement plainly and offers a one-click install instead of
 * spinning on an empty "loading" shell — the whole point being that a transient
 * toast is easy to miss on a fresh machine. Once tmux is installed a window
 * reload re-enters activation on the normal path and this view is never built.
 */
export class TmuxGateView implements vscode.WebviewViewProvider {
  constructor(private readonly install: TmuxInstall | null) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
      switch (msg.type) {
        case 'install':
          if (this.install) {
            const term = vscode.window.createTerminal('Install tmux');
            term.show();
            term.sendText(this.install.command);
          }
          return;
        case 'copy':
          if (this.install) await vscode.env.clipboard.writeText(this.install.command);
          return;
        case 'reload':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        case 'guide':
          await vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
          return;
      }
    });
  }

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const cmd = this.install?.command ?? '';
    const manager = this.install?.manager ?? '';

    // With a detected package manager we lead with the one-click install; without
    // one we can't invent a command that might fail confusingly, so we point at
    // the official guide instead.
    const actions = this.install
      ? `<div class="cmd"><code>${escapeHtml(cmd)}</code></div>
         <div class="row">
           <button class="primary" data-action="install">Install with ${escapeHtml(manager)}</button>
           <button data-action="copy">Copy</button>
         </div>
         <p class="hint">After it installs, reload the window to enable Unmess.</p>
         <button class="link" data-action="reload">Reload window</button>`
      : `<p class="hint">No supported package manager was found on your system.</p>
         <button class="primary" data-action="guide">Open install guide</button>
         <button class="link" data-action="reload">Reload window</button>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
  <title>Unmess</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 16px 14px;
      line-height: 1.5;
    }
    h2 { font-size: 1.05em; margin-bottom: 8px; }
    p { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
    .cmd {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 8px 10px;
      margin-bottom: 10px;
      overflow-x: auto;
    }
    .cmd code { font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; }
    .row { display: flex; gap: 6px; margin-bottom: 10px; }
    button {
      font-family: inherit;
      font-size: inherit;
      padding: 5px 12px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.link {
      background: none;
      color: var(--vscode-textLink-foreground);
      padding: 4px 0;
      text-decoration: none;
    }
    button.link:hover { text-decoration: underline; background: none; }
    .hint { font-size: 0.9em; }
  </style>
</head>
<body>
  <h2>Unmess needs tmux</h2>
  <p>Agents run inside tmux so they survive window reloads and stay multiplexed per worktree. It's not installed on this machine yet.</p>
  ${actions}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const el of document.querySelectorAll('[data-action]')) {
      el.addEventListener('click', () => vscode.postMessage({ type: el.dataset.action }));
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
