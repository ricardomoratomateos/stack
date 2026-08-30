import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { FileField, ProjectValues, SettingsExtMessage, SettingsMessage, SettingsSnapshot, UserValues } from './types';

/** Everything the panel needs from the extension, behind a port so it tests on doubles. */
export interface SettingsPanelHost {
  snapshot(): SettingsSnapshot;
  /** Native open dialog; resolves to a repo-relative path, or nothing if cancelled. */
  pickFile(field: FileField): Promise<string | undefined>;
  /** Write a starter script and return its repo-relative path. */
  createScript(kind: 'setup' | 'teardown'): Promise<string>;
  /** Write `.foreman/config.json`; resolves to the problems the file reads back with. */
  saveProject(values: ProjectValues): Promise<string[]>;
  saveUser(values: UserValues): Promise<void>;
  clearPersonalOverrides(): Promise<void>;
  openProjectFile(): Promise<void>;
}

/**
 * The settings panel: one editor-area webview that walks through the project's
 * setup (worktrees, scripts, Docker, debug — saved to `.foreman/config.json`)
 * and the user's own preferences (agents, behaviour — saved to VS Code
 * settings), prefilled from what the repository already contains. One panel at
 * a time; a second request reveals it.
 */
export class SettingsPanelManager {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: SettingsPanelHost,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'foreman.settings',
      'Foreman settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
      },
    );
    panel.webview.html = this.getHtml(panel.webview);
    this.panel = panel;
    panel.webview.onDidReceiveMessage((msg: SettingsMessage) => this.handle(msg));
    panel.onDidDispose(() => { this.panel = undefined; });
  }

  /** Re-read everything and push it — after a save, or when the file changed under us. */
  refresh(): void {
    if (this.panel) this.post({ type: 'snapshot', snapshot: this.host.snapshot() });
  }

  private async handle(msg: SettingsMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.refresh();
        return;
      case 'pickFile': {
        const path = await this.host.pickFile(msg.field);
        if (path !== undefined) this.post({ type: 'picked', field: msg.field, path });
        return;
      }
      case 'createScript': {
        const path = await this.host.createScript(msg.kind);
        this.post({ type: 'picked', field: msg.kind === 'setup' ? 'setupScript' : 'teardownScript', path });
        return;
      }
      case 'saveProject': {
        const problems = await this.host.saveProject(msg.values).catch((e) => [String(e)]);
        this.post({ type: 'saved', scope: 'project', problems });
        this.refresh();
        return;
      }
      case 'saveUser': {
        const problems = await this.host.saveUser(msg.values).then(() => [], (e) => [String(e)]);
        this.post({ type: 'saved', scope: 'user', problems });
        this.refresh();
        return;
      }
      case 'clearPersonalOverrides':
        await this.host.clearPersonalOverrides().catch(() => {});
        this.refresh();
        return;
      case 'openProjectFile':
        await this.host.openProjectFile().catch(() => {});
        return;
    }
  }

  private post(msg: SettingsExtMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'settingsPanel.js'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>Foreman settings</title>
  <link rel="stylesheet" href="${codiconUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
