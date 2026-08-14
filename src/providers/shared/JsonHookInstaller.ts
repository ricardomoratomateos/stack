import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookEntry } from '../../types';

/**
 * The notify script, byte-for-byte identical on every install.
 *
 * The endpoint deliberately lives in a sibling file instead of being baked in
 * here. Codex records hook trust against a hash of the hook definition and
 * skips anything that no longer matches, and the HookServer binds a *random*
 * port on every activation — so a URL baked into this script would change its
 * hash on every window reload, silently untrusting the hook and freezing every
 * agent's state in the sidebar with no error anywhere.
 *
 * The event name is passed as $1 because the three agents disagree on how they
 * announce it (Claude sets HOOK_EVENT_NAME, Codex sends hook_event_name on
 * stdin, Grok sends hookEventName plus GROK_HOOK_EVENT). We register the
 * command ourselves, so an explicit argument sidesteps all three.
 */
const SCRIPT = `#!/bin/bash
# Unmess notify hook — generated, do not edit manually.
URL_FILE="$(dirname "$0")/hook-url"
[ -r "$URL_FILE" ] || exit 0
URL=$(cat "$URL_FILE")
[ -n "$URL" ] || exit 0
EVENT_NAME="\${1:-\${HOOK_EVENT_NAME:-}}"
# Drain stdin: the agent writes the event payload there and would block on a
# reader that never consumes it. We key off the env vars instead.
PAYLOAD=$(cat)
curl -s -X POST "$URL/hook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"event\\":\\"$EVENT_NAME\\",\\"terminalId\\":\\"$UNMESS_TERMINAL_ID\\",\\"workspaceId\\":\\"$UNMESS_WORKSPACE_ID\\",\\"windowIndex\\":\\"$UNMESS_WINDOW_INDEX\\"}" \\
  > /dev/null 2>&1 || true
`;

/**
 * Registers Unmess's notify hook in an agent whose hook config is JSON shaped
 * like `{ "hooks": { "<Event>": [{ "hooks": [{ type, command }] }] } }`.
 *
 * Claude Code, Codex and Grok Build all landed on that same shape, so they
 * share one installer and differ only in which file they read and which events
 * they actually emit.
 */
export class JsonHookInstaller {
  readonly scriptPath: string;

  readonly urlPath: string;

  constructor(
    storagePath: string,
    /** Absolute path to the agent's JSON hook config. */
    private settingsPath: string,
    /** Events this agent emits, out of the ones Unmess understands. */
    private events: readonly string[],
  ) {
    this.scriptPath = path.join(storagePath, 'notify.sh');
    this.urlPath = path.join(storagePath, 'hook-url');
  }

  install(hookUrl: string): void {
    this.writeScript();
    this.writeUrl(hookUrl);
    this.inject();
  }

  uninstall(): void {
    this.remove();
  }

  /** `"<script>" <Event>` — quoted so paths like "Application Support" survive. */
  protected commandFor(event: string): string {
    return `"${this.scriptPath}" ${event}`;
  }

  private writeScript(): void {
    // Rewrite only on a real change: an unchanged file keeps its mtime, and
    // more importantly keeps whatever trust the agent has recorded for it.
    if (fs.existsSync(this.scriptPath) && fs.readFileSync(this.scriptPath, 'utf8') === SCRIPT) return;
    fs.mkdirSync(path.dirname(this.scriptPath), { recursive: true });
    fs.writeFileSync(this.scriptPath, SCRIPT, { mode: 0o755 });
  }

  private writeUrl(hookUrl: string): void {
    fs.mkdirSync(path.dirname(this.urlPath), { recursive: true });
    fs.writeFileSync(this.urlPath, hookUrl);
  }

  protected readSettings(): Record<string, unknown> {
    if (!fs.existsSync(this.settingsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // A hand-edited file with a syntax error must not cost the user their
      // config: bail out rather than overwrite it with our own.
      return {};
    }
  }

  private writeSettings(settings: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

  private inject(): void {
    const settings = this.readSettings();
    const hooks = (settings['hooks'] as Record<string, HookEntry[]>) ?? {};

    for (const event of this.events) {
      const command = this.commandFor(event);
      // Strip our own previous entries (any shape) before re-adding, so a
      // changed script path or command format never leaves a stale duplicate.
      // Other tools' entries are left untouched — Codex users commonly have
      // another harness registered in the very same file.
      const others = (hooks[event] ?? [])
        .map((group) => ({ ...group, hooks: group.hooks.filter((c) => !this.isOurs(c.command)) }))
        .filter((group) => group.hooks.length > 0);
      hooks[event] = [...others, { matcher: '', hooks: [{ type: 'command', command }] }];
    }

    settings['hooks'] = hooks;
    this.writeSettings(settings);
  }

  private remove(): void {
    if (!fs.existsSync(this.settingsPath)) return;
    try {
      const settings = this.readSettings();
      const hooks = settings['hooks'] as Record<string, HookEntry[]> | undefined;
      if (!hooks) return;
      for (const event of this.events) {
        if (!hooks[event]) continue;
        hooks[event] = hooks[event]
          .map((group) => ({ ...group, hooks: group.hooks.filter((c) => !this.isOurs(c.command)) }))
          .filter((group) => group.hooks.length > 0);
      }
      settings['hooks'] = hooks;
      this.writeSettings(settings);
    } catch {
      // best effort
    }
  }

  /** Ours iff it invokes our script, whatever quoting or event suffix it carries. */
  private isOurs(command: string): boolean {
    return command.includes(this.scriptPath);
  }
}
