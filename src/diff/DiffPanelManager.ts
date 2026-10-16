import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { DiffBase, SendDestination, DiffComment, DiffPanelMessage, DiffPanelExtMessage } from './types';
import { DiffError } from '../ports/IGitPort';
import type { SidebarStyle } from '../sidebarStyle';

/** Business logic the panel needs, provided by the application service. */
export interface DiffPanelHost {
  getDiff(worktreeId: string, base: DiffBase): Promise<string>;
  getContext(worktreeId: string): { label: string; hasLiveAgent: boolean } | undefined;
  /** Where the comments actually went (a vanished live agent falls back to `new`), or false when nothing was sent. */
  send(worktreeId: string, destination: SendDestination, comments: DiffComment[]): Promise<SendDestination | false>;
  /** Open a file (path relative to the worktree) in the editor at an optional line. */
  openFile(worktreeId: string, relativePath: string, line?: number): Promise<void>;
}

/**
 * Owns one webview panel per worktree, rendered in the editor area. Fetches the
 * diff on demand, relays review comments back to the agent through the host.
 */
export class DiffPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: DiffPanelHost,
    /** The `stack.sidebarStyle` setting: the panel wears the sidebar's accent. */
    private readonly sidebarStyle: () => SidebarStyle,
  ) {}

  open(worktreeId: string): void {
    const existing = this.panels.get(worktreeId);
    if (existing) {
      existing.reveal();
      return;
    }

    const ctx = this.host.getContext(worktreeId);
    const panel = vscode.window.createWebviewPanel(
      'stack.diffReview',
      ctx ? `Review: ${ctx.label}` : 'Review',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
      },
    );
    panel.webview.html = this.getHtml(panel.webview);
    this.panels.set(worktreeId, panel);

    panel.webview.onDidReceiveMessage((msg: DiffPanelMessage) => this.handle(worktreeId, panel, msg));
    panel.onDidDispose(() => this.panels.delete(worktreeId));
  }

  /** The setting changed: repaint every open panel in the new accent. */
  refreshStyle(): void {
    for (const panel of this.panels.values()) this.post(panel, { type: 'style', style: this.sidebarStyle() });
  }

  private post(panel: vscode.WebviewPanel, msg: DiffPanelExtMessage): void {
    void panel.webview.postMessage(msg);
  }

  private async handle(worktreeId: string, panel: vscode.WebviewPanel, msg: DiffPanelMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post(panel, { type: 'style', style: this.sidebarStyle() });
        await this.pushDiff(worktreeId, panel, 'branch');
        break;
      case 'requestDiff':
        await this.pushDiff(worktreeId, panel, msg.base);
        break;
      case 'send': {
        const went = await this.host.send(worktreeId, msg.destination, msg.comments).catch(() => false as const);
        // Reports where it went, not where it was asked to go, so the toast
        // never claims a running agent took a prompt that launched a new one.
        this.post(panel, {
          type: 'sent',
          destination: went || msg.destination,
          ok: went !== false,
          ...(went && went !== msg.destination ? { fellBack: true as const } : {}),
        });
        break;
      }
      case 'openFile':
        await this.host.openFile(worktreeId, msg.path, msg.line).catch(() => {});
        break;
    }
  }

  private async pushDiff(worktreeId: string, panel: vscode.WebviewPanel, base: DiffBase): Promise<void> {
    const ctx = this.host.getContext(worktreeId);
    if (!ctx) {
      this.post(panel, { type: 'error', message: 'Worktree not found.' });
      return;
    }
    // A failure is carried alongside an empty diff rather than swallowed into
    // one: '' renders "No changes to review", which after a git error is a lie
    // that sends the reviewer away thinking the agent did nothing. Still a
    // 'diff' message, so the base toggle and label stay in step with the request.
    let unified = '';
    let error: string | undefined;
    try {
      unified = await this.host.getDiff(worktreeId, base);
    } catch (e) {
      error = e instanceof DiffError ? e.reason : e instanceof Error ? e.message : String(e);
    }
    this.post(panel, {
      type: 'diff', base, unified, hasLiveAgent: ctx.hasLiveAgent, label: ctx.label,
      ...(error !== undefined ? { error } : {}),
    });
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'diffPanel.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>Review</title>
  <link rel="stylesheet" href="${iconsUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
