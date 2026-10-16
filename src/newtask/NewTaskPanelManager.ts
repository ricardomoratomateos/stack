import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { NewTaskMessage, NewTaskExtMessage, NewTaskInit } from './types';
import type { ProviderId } from '../ports/IAgentProvider';
import type { SidebarStyle } from '../sidebarStyle';

/** What creating a worktree came to; `error` is set when it failed. */
export interface CreateOutcome {
  ok: boolean;
  error?: string;
}

/** Business logic the panel needs, provided by the application service. */
export interface NewTaskPanelHost {
  init(): NewTaskInit;
  /** Cheap, and read before the bundle loads so the first paint already wears the right accent. */
  sidebarStyle(): SidebarStyle;
  createWorktree(opts: {
    branch: string; title?: string; description?: string; baseBranch?: string; provider?: ProviderId;
  }): Promise<CreateOutcome>;
  showProviderInstall(provider: ProviderId): Promise<void>;
  /** Modal "discard what you wrote?"; true when the user agreed. */
  confirmDiscard(): Promise<boolean>;
}

/**
 * The "new task" composer, rendered as a single editor-area webview panel so
 * the prompt is not squeezed into the sidebar. Only one is ever open — a second
 * request reveals the existing panel. Creating the worktree closes it, dropping
 * the user back into their editor with the agent launched; if creating fails it
 * stays open, text intact, and says why.
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
      'stack.newTask',
      'New task',
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
        this.refresh();
        return;
      case 'create': {
        const outcome = await this.host
          .createWorktree({
            branch: msg.branch, title: msg.title, description: msg.description,
            baseBranch: msg.baseBranch, provider: msg.provider,
          })
          .catch((e): CreateOutcome => ({ ok: false, error: String(e) }));
        if (outcome.ok) this.panel?.dispose();
        else this.post({ type: 'error', message: outcome.error || 'Could not create the worktree.' });
        return;
      }
      case 'cancel':
        // Losing a half-written prompt to a stray Esc is the one thing this
        // form must not do. The webview cannot ask (its sandbox blocks confirm()).
        if (msg.dirty && !(await this.host.confirmDiscard())) return;
        this.panel?.dispose();
        return;
      case 'showProviderInstall':
        await this.host.showProviderInstall(msg.provider);
        return;
    }
  }

  /** Re-send the panel's inputs — on first load, and when a setting it reflects changes. */
  refresh(): void {
    this.post({ type: 'init', init: this.host.init() });
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
  <title>New task</title>
  <link rel="stylesheet" href="${codiconUri}">
</head>
<body data-style="${this.host.sidebarStyle()}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
