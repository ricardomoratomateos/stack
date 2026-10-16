import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { AgentSessionManager } from '../session/AgentSessionManager';
import { GitWatcher } from '../git/GitWatcher';
import { WorktreeApplicationService } from '../application/WorktreeApplicationService';
import type { ExtMessage, WebMessage, ForemanState } from '../webview/types';

/**
 * Thin webview adapter: renders the React sidebar, pushes state, and forwards
 * messages to the application service.
 */
/**
 * How long pushes are gathered before one state goes out. Events come in
 * bursts — a load starts a watcher, a docker poll and a PR poll per worktree,
 * each answering with its own push — and every push is a full buildState plus a
 * whole-sidebar re-render. Short enough that nobody sees it.
 */
export const PUSH_COALESCE_MS = 50;

export class ForemanWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private badgeCount = 0;
  /**
   * Everything subscribed on behalf of the current view. VS Code resolves the
   * view again whenever it is re-created (moved, collapsed and reopened with
   * its context released), and each resolve used to add four listeners that
   * nothing removed — so every agent or git event rebuilt and re-sent the
   * state once per resolve the window had ever seen.
   */
  private subscriptions: vscode.Disposable[] = [];
  private pushTimer?: ReturnType<typeof setTimeout>;
  /** The last state the webview was sent, serialized, to skip re-sending it. */
  private lastSent?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentManager: AgentSessionManager,
    private readonly gitWatcher: GitWatcher,
    private readonly service: WorktreeApplicationService,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.release();
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((msg: WebMessage) => {
        // A fresh page holds no state, so the next push must go out even if
        // it is the same state the previous page was sent.
        if (msg.type === 'ready') this.lastSent = undefined;
        // Handlers await dialogs, git and tmux; a failure in any of them was an
        // unhandled rejection with nothing on screen.
        Promise.resolve()
          .then(() => this.service.handleMessage(msg))
          .catch((e) => console.error(`[foreman] webview message "${msg.type}" failed:`, e));
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this.push();
      }),
      webviewView.onDidDispose(() => {
        if (this.view !== webviewView) return;
        this.release();
        this.view = undefined;
      }),
      this.agentManager.onStateChange(() => this.push()),
      this.agentManager.onTerminalsChange(() => this.push()),
      this.gitWatcher.onChange(() => this.push()),
      // Sync sidebar selection when the active terminal changes (fires on reload too).
      vscode.window.onDidChangeActiveTerminal((terminal) => this.service.handleActiveTerminalChange(terminal)),
    );

    this.applyBadge();
    this.push();
  }

  /** Drops the current view's subscriptions and any pending push. */
  private release(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    this.lastSent = undefined;
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

  /**
   * Schedule a state push. Pushes within PUSH_COALESCE_MS of each other go out
   * as one, built when the window closes so it carries the latest of them.
   */
  push(): void {
    if (!this.view?.visible || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.flush();
    }, PUSH_COALESCE_MS);
  }

  private flush(): void {
    const view = this.view;
    if (!view?.visible) return;
    const state = this.service.buildState();
    // Most events change nothing the sidebar shows — a poll that found what it
    // found last time, a terminal that is not one of ours — and re-sending an
    // identical state still re-renders every card.
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSent) return;
    this.lastSent = serialized;
    view.description = ForemanWebviewProvider.describe(state);
    const msg: ExtMessage = { type: 'state', payload: state };
    void Promise.resolve(view.webview.postMessage(msg)).then(
      (delivered) => {
        // Not delivered (the page is mid-reload): it has not seen this state.
        if (!delivered && this.lastSent === serialized) this.lastSent = undefined;
      },
      () => {
        if (this.lastSent === serialized) this.lastSent = undefined;
      },
    );
  }

  /**
   * Live counts for the native view header, replacing the in-webview title bar:
   * the section header already says "Worktrees", so repeating it inside the
   * webview just wasted a row.
   */
  static describe(state: ForemanState): string | undefined {
    const parts: string[] = [];
    const active = state.worktrees.filter((w) => w.agent === 'active').length;
    const perm = state.worktrees.filter((w) => w.agent === 'permission').length;
    if (active > 0) parts.push(`${active} thinking`);
    if (perm > 0) parts.push(`${perm} needs you`);
    return parts.length > 0 ? parts.join(' · ') : undefined;
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
  <title>Foreman</title>
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
