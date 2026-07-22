import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OPENCODE_PLUGIN_PATH } from '../../constants';

/**
 * Wires opencode to the unmess HookServer by writing a plugin into opencode's
 * global plugin directory (~/.config/opencode/plugin/). opencode loads every
 * JS file there at startup; the plugin translates opencode bus events into the
 * canonical event names the HookServer already understands, so the server
 * needs no opencode-specific handling.
 *
 * Regenerated on every install because the HookServer port changes per
 * VSCode session. The plugin no-ops when UNMESS_WORKSPACE_ID is absent, so
 * opencode runs outside unmess are unaffected.
 */
export class OpenCodeHookInstaller {
  private pluginPath: string;

  constructor(pluginPath?: string) {
    this.pluginPath = pluginPath ?? path.join(os.homedir(), OPENCODE_PLUGIN_PATH);
  }

  install(hookUrl: string): void {
    const content = this.pluginSource(hookUrl);

    // only write if content changed (mirrors ClaudeHookInstaller / bug 18)
    if (fs.existsSync(this.pluginPath)) {
      const existing = fs.readFileSync(this.pluginPath, 'utf8');
      if (existing === content) return;
    }

    fs.mkdirSync(path.dirname(this.pluginPath), { recursive: true });
    fs.writeFileSync(this.pluginPath, content);
  }

  uninstall(): void {
    try {
      fs.rmSync(this.pluginPath, { force: true });
    } catch {
      // best effort
    }
  }

  private pluginSource(hookUrl: string): string {
    const lines = [
      '// Unmess notify plugin — do not edit manually (regenerated on every unmess activation)',
      'const EVENT_MAP = {',
      '  "session.created": "SessionStart",',
      '  "session.idle": "Stop",',
      '  "session.deleted": "SessionEnd",',
      '  "session.error": "SessionEnd",',
      '  "permission.asked": "PermissionRequest",',
      '  "permission.replied": "UserPromptSubmit",',
      '};',
      '',
      'export const UnmessNotify = async () => {',
      '  const workspaceId = process.env.UNMESS_WORKSPACE_ID;',
      '  // Loaded by every opencode run — stay inert outside unmess-launched sessions.',
      '  if (!workspaceId) return {};',
      '  const windowIndex = process.env.UNMESS_WINDOW_INDEX || "";',
      '  const notify = (event) => {',
      `    fetch("${hookUrl}/hook", {`,
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      '      body: JSON.stringify({ event, workspaceId, windowIndex }),',
      '    }).catch(() => {});',
      '  };',
      '  return {',
      '    event: async ({ event }) => {',
      '      const mapped = EVENT_MAP[event.type];',
      '      if (mapped) notify(mapped);',
      '    },',
      '    "tool.execute.before": async () => notify("PreToolUse"),',
      '    "tool.execute.after": async () => notify("PostToolUse"),',
      '  };',
      '};',
    ];
    return lines.join('\n') + '\n';
  }
}
