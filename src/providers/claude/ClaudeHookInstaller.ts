import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookEntry } from '../../types';
import { CLAUDE_SETTINGS_PATH } from '../../constants';

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'];

export class ClaudeHookInstaller {
  private scriptPath: string;

  private claudeSettingsPath: string;

  constructor(
    extensionStoragePath: string,
    claudeSettingsPath?: string,
  ) {
    this.scriptPath = path.join(extensionStoragePath, 'notify.sh');
    this.claudeSettingsPath = claudeSettingsPath ?? path.join(os.homedir(), CLAUDE_SETTINGS_PATH);
  }

  install(hookUrl: string): void {
    this.writeScript(hookUrl);
    this.injectIntoClaudeSettings();
  }

  uninstall(): void {
    this.removeFromClaudeSettings();
  }

  private writeScript(hookUrl: string): void {
    const lines = [
      '#!/bin/bash',
      '# Unmess notify hook — do not edit manually',
      'EVENT_NAME="${1:-$HOOK_EVENT_NAME}"',
      'PAYLOAD=$(cat)',
      `curl -s -X POST "${hookUrl}/hook" \\`,
      '  -H "Content-Type: application/json" \\',
      '  -d "{\\"event\\":\\"$EVENT_NAME\\",\\"terminalId\\":\\"$UNMESS_TERMINAL_ID\\",\\"workspaceId\\":\\"$UNMESS_WORKSPACE_ID\\",\\"windowIndex\\":\\"$UNMESS_WINDOW_INDEX\\"}" \\',
      '  > /dev/null 2>&1 || true',
    ];
    const newContent = lines.join('\n') + '\n';

    // only write if content changed (bug 18)
    if (fs.existsSync(this.scriptPath)) {
      const existing = fs.readFileSync(this.scriptPath, 'utf8');
      if (existing === newContent) return;
    }

    fs.mkdirSync(path.dirname(this.scriptPath), { recursive: true });
    fs.writeFileSync(this.scriptPath, newContent, { mode: 0o755 });
  }

  private getClaudeSettingsPath(): string {
    return this.claudeSettingsPath;
  }

  private get quotedCommand(): string {
    // Wrap in quotes to handle paths with spaces (e.g. "Application Support")
    return `"${this.scriptPath}"`;
  }

  private injectIntoClaudeSettings(): void {
    const settingsPath = this.getClaudeSettingsPath();
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        settings = {};
      }
    }

    const hooks = (settings['hooks'] as Record<string, HookEntry[]>) ?? {};
    for (const event of HOOK_EVENTS) {
      const existing: HookEntry[] = hooks[event] ?? [];

      // Remove old unquoted entries (they break on paths with spaces)
      const withoutOld = existing
        .map((group) => ({
          ...group,
          hooks: group.hooks.filter((c) => c.command !== this.scriptPath),
        }))
        .filter((group) => group.hooks.length > 0);

      const command = `${this.quotedCommand} ${event}`;
      const alreadyAddedWithArg = withoutOld.some((group) =>
        group.hooks?.some((c) => c.command === command),
      );
      hooks[event] = alreadyAddedWithArg
        ? withoutOld
        : [...withoutOld, { matcher: '', hooks: [{ type: 'command', command }] }];
    }
    settings['hooks'] = hooks;

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  private removeFromClaudeSettings(): void {
    const settingsPath = this.getClaudeSettingsPath();
    if (!fs.existsSync(settingsPath)) return;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const hooks = settings['hooks'] as Record<string, HookEntry[]> | undefined;
      if (!hooks) return;
      for (const event of HOOK_EVENTS) {
        if (hooks[event]) {
          hooks[event] = hooks[event]
            .map((group) => ({
              ...group,
              hooks: group.hooks.filter(
                (c) =>
                  c.command !== this.scriptPath &&
                  c.command !== this.quotedCommand &&
                  c.command !== `${this.quotedCommand} ${event}`,
              ),
            }))
            .filter((group) => group.hooks.length > 0);
        }
      }
      settings['hooks'] = hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch {
      // best effort
    }
  }
}
