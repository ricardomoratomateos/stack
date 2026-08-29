import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { NewTaskMessage, NewTaskExtMessage, NewTaskInit } from './types';

/** Business logic the panel needs, provided by the application service. */
export interface NewTaskPanelHost {
  branchOptions(): NewTaskInit;
  createWorktree(opts: { branch: string; title?: string; description?: string; baseBranch?: string }): Promise<void>;
}

/**
 * The "new agent" form, rendered as a single editor-area webview panel so the
 * prompt gets the full width and height of the IDE instead of the cramped
 * sidebar. Only one is ever open — a second request reveals the existing panel.
 * Creating the worktree closes it, dropping the user back into their editor with
 * the agent launched.
 */
export class NewTaskPanelManager {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: NewTaskPanelHost,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unmess.newTask',
      'New agent',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
      },
    );
    panel.webview.html = this.getHtml(panel.webview);
    this.panel = panel;
    panel.webview.onDidReceiveMessage((msg: NewTaskMessage) => this.handle(msg));
    panel.onDidDispose(() => { this.panel = undefined; });
  }

  private async handle(msg: NewTaskMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'init', init: this.host.branchOptions() });
        return;
      case 'create':
        await this.host
          .createWorktree({ branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch })
          .catch(() => {});
        this.panel?.dispose();
        return;
      case 'cancel':
        this.panel?.dispose();
        return;
    }
  }

  private post(msg: NewTaskExtMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'newTaskPanel.js'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>New agent</title>
  <link rel="stylesheet" href="${codiconUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
