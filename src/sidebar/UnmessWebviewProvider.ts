import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { AgentSessionManager } from '../session/AgentSessionManager';
import { GitWatcher } from '../git/GitWatcher';
import { WorktreeApplicationService } from '../application/WorktreeApplicationService';
import type { ExtMessage, WebMessage } from '../webview/types';

/**
 * Thin webview adapter: renders the React sidebar, pushes state, and forwards
 * messages to the application service.
 */
export class UnmessWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private badgeCount = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentManager: AgentSessionManager,
    private readonly gitWatcher: GitWatcher,
    private readonly service: WorktreeApplicationService,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebMessage) => {
      this.service.handleMessage(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });

    this.agentManager.onStateChange(() => this.push());
    this.agentManager.onTerminalsChange(() => this.push());
    this.gitWatcher.onChange(() => this.push());

    // Sync sidebar selection when the active terminal changes (fires on reload too).
    vscode.window.onDidChangeActiveTerminal((terminal) => this.service.handleActiveTerminalChange(terminal));

    this.applyBadge();
    this.push();
  }

  /** Number badge on the activity-bar icon: sessions pending the user's attention. */
  setBadge(count: number): void {
    this.badgeCount = count;
    this.applyBadge();
  }

  private applyBadge(): void {
    if (!this.view) return;
    this.view.badge =
      this.badgeCount > 0
        ? {
            value: this.badgeCount,
            tooltip: `${this.badgeCount} agent session${this.badgeCount === 1 ? ' needs' : 's need'} your attention`,
          }
        : undefined;
  }

  push(): void {
    if (!this.view?.visible) return;
    const msg: ExtMessage = { type: 'state', payload: this.service.buildState() };
    this.view.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>Unmess</title>
  <link rel="stylesheet" href="${codiconUri}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; }
    body { background: var(--vscode-sideBar-background); overflow: hidden; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
