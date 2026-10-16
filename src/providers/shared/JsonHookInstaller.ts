import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookEntry } from '../../types';
import { ConfigFileError, displayPath, readJsonObject, writeFileAtomic } from './configFile';

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
 * The event name is passed as $1 because the agents disagree on how they
 * announce it (Claude sets HOOK_EVENT_NAME, Codex sends hook_event_name on
 * stdin). We register the command ourselves, so an explicit argument sidesteps
 * the difference.
 */
const SCRIPT = `#!/bin/bash
# Foreman notify hook — generated, do not edit manually.
URL_FILE="$(dirname "$0")/hook-url"
[ -r "$URL_FILE" ] || exit 0
URL=$(cat "$URL_FILE")
[ -n "$URL" ] || exit 0
EVENT_NAME="\${1:-\${HOOK_EVENT_NAME:-}}"
# Drain stdin: the agent writes the event payload there and would block on a
# reader that never consumes it. We key off the environment instead.
PAYLOAD=$(cat)

WORKSPACE_ID="\${FOREMAN_WORKSPACE_ID:-}"
WINDOW_INDEX="\${FOREMAN_WINDOW_INDEX:-}"

# Ask tmux where we are whenever the launcher did not say. Those variables are
# baked in when Foreman starts an agent, so an agent the user starts BY HAND —
# in a shell window, or after the first one exited — has neither, and every
# event it sent was dropped for having an empty workspace id. tmux always knows,
# because the hook runs inside the pane.
if [ -n "\${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  if [ -z "$WINDOW_INDEX" ]; then
    WINDOW_INDEX=$(tmux display-message -p -t "$TMUX_PANE" '#{window_index}' 2>/dev/null) || WINDOW_INDEX=""
  fi
  if [ -z "$WORKSPACE_ID" ]; then
    # Session names are "foreman-<worktree id>". Worktree ids are UUIDs, so they
    # survive sessionName()'s sanitising and 50-char cap unchanged and the
    # prefix strip round-trips exactly.
    SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || SESSION=""
    case "$SESSION" in
      foreman-*) WORKSPACE_ID="\${SESSION#foreman-}" ;;
    esac
  fi
fi

curl -s -X POST "$URL/hook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"event\\":\\"$EVENT_NAME\\",\\"terminalId\\":\\"$FOREMAN_TERMINAL_ID\\",\\"workspaceId\\":\\"$WORKSPACE_ID\\",\\"windowIndex\\":\\"$WINDOW_INDEX\\"}" \\
  > /dev/null 2>&1 || true
`;

/**
 * Registers Foreman's notify hook in an agent whose hook config is JSON shaped
 * like `{ "hooks": { "<Event>": [{ "hooks": [{ type, command }] }] } }`.
 *
 * Claude Code and Codex both landed on that same shape, so they share one
 * installer and differ only in which file they read and which events they
 * actually emit.
 */
export class JsonHookInstaller {
  readonly scriptPath: string;

  readonly urlPath: string;

  constructor(
    storagePath: string,
    /** Absolute path to the agent's JSON hook config. */
    private settingsPath: string,
    /** Events this agent emits, out of the ones Foreman understands. */
    private events: readonly string[],
  ) {
    this.scriptPath = path.join(storagePath, 'notify.sh');
    this.urlPath = path.join(storagePath, 'hook-url');
  }

  /**
   * Throws ConfigFileError when the agent's config cannot be edited safely
   * (syntax error, unexpected shape). The file is then left byte-identical and
   * the message is meant to be shown to the user as is.
   */
  install(hookUrl: string): void {
    this.writeScript();
    this.writeUrl(hookUrl);
    this.inject();
  }

  /** Same contract as install(): refuses, rather than clobbers, a broken config. */
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

  /**
   * The agent's config, or a ConfigFileError when it cannot be edited safely.
   *
   * This used to come back as `{}` on a syntax error, and inject() then wrote
   * that back with only our hooks in it: one stray comma in a hand-edited
   * settings.json cost the user their permissions, env and model. Refusing is
   * the only answer that cannot lose anything.
   */
  protected readSettings(action: string): Record<string, unknown> {
    return readJsonObject(this.settingsPath, action);
  }

  private writeSettings(settings: Record<string, unknown>): void {
    writeFileAtomic(this.settingsPath, JSON.stringify(settings, null, 2), { backup: true });
  }

  /** `settings.hooks`, refusing any shape we would have to clobber to edit. */
  private hooksOf(settings: Record<string, unknown>, action: string): Record<string, unknown[]> {
    const hooks = settings['hooks'] ?? {};
    const bad = (where: string) =>
      new ConfigFileError(
        `Foreman couldn't ${action}: "${where}" in ${displayPath(this.settingsPath)} is not the documented hooks shape. ` +
        'The file was left untouched.',
      );
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) throw bad('hooks');
    for (const event of this.events) {
      const entries = (hooks as Record<string, unknown>)[event];
      if (entries !== undefined && !Array.isArray(entries)) throw bad(`hooks.${event}`);
    }
    return hooks as Record<string, unknown[]>;
  }

  /**
   * One event's entries with our commands taken out. A group not shaped
   * `{ hooks: [...] }` is not ours to interpret, so it passes through as is.
   */
  private withoutOurs(entries: unknown[] | undefined): unknown[] {
    return (entries ?? [])
      .map((group) => {
        const g = group as HookEntry | null;
        if (!g || !Array.isArray(g.hooks)) return group;
        return { ...g, hooks: g.hooks.filter((c) => !this.isOurs(c?.command)) };
      })
      .filter((group) => {
        const g = group as HookEntry | null;
        return !g || !Array.isArray(g.hooks) || g.hooks.length > 0;
      });
  }

  private inject(): void {
    const action = 'install its hooks';
    const settings = this.readSettings(action);
    const hooks = this.hooksOf(settings, action);

    for (const event of this.events) {
      const command = this.commandFor(event);
      // Strip our own previous entries (any shape) before re-adding, so a
      // changed script path or command format never leaves a stale duplicate.
      // Other tools' entries are left untouched — Codex users commonly have
      // another harness registered in the very same file.
      hooks[event] = [...this.withoutOurs(hooks[event]), { matcher: '', hooks: [{ type: 'command', command }] }];
    }

    settings['hooks'] = hooks;
    this.writeSettings(settings);
  }

  private remove(): void {
    if (!fs.existsSync(this.settingsPath)) return;
    const action = 'remove its hooks';
    const settings = this.readSettings(action);
    if (settings['hooks'] === undefined) return;
    const hooks = this.hooksOf(settings, action);
    for (const event of this.events) {
      if (!hooks[event]) continue;
      hooks[event] = this.withoutOurs(hooks[event]);
    }
    settings['hooks'] = hooks;
    this.writeSettings(settings);
  }

  /** Ours iff it invokes our script, whatever quoting or event suffix it carries. */
  private isOurs(command: unknown): boolean {
    return typeof command === 'string' && command.includes(this.scriptPath);
  }
}
