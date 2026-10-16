import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookEntry } from '../../types';
import { ConfigFileError, displayPath, readJsonObject, writeFileAtomic } from './configFile';
import { HookRoutes } from './HookRoutes';

/**
 * The notify script, byte-for-byte identical on every install — and meant to
 * stay that way across releases.
 *
 * Codex records hook trust against a hash of the hook definition and silently
 * skips anything that no longer matches, so every change here costs every
 * Codex user a re-trust, with their sidebar frozen until they do it. Hence:
 *
 * - No endpoint baked in. The HookServer binds a random port per window, and
 *   the script finds the right one at send time (see HookRoutes).
 * - No interpretation. The agent's payload is forwarded verbatim as the body —
 *   session_id, transcript_path, tool_name, message, whatever later agent
 *   versions add — and Foreman's own ids ride in X-Foreman-* headers. What the
 *   extension reads out of an event can grow without the script changing.
 * - A reply channel. A response body starting with `foreman-reply:` is printed
 *   to stdout, which is how Claude Code and Codex take a hook's answer (extra
 *   context, a permission decision). Nothing uses it yet; it is here so that
 *   using it later does not mean changing this file.
 * - Bounded. A connect timeout and --max-time cap the wait, because a paused
 *   extension host (a debugger, a hung window) accepts the connection and then
 *   never answers, and the agent waits on its hook.
 *
 * $1 is the event name, because the agents disagree on how they announce it
 * (Claude sets HOOK_EVENT_NAME, Codex sends hook_event_name on stdin); $2 the
 * provider the hook was registered for. We register the command ourselves, so
 * explicit arguments sidestep the differences.
 */
const SCRIPT = `#!/bin/bash
# Foreman notify hook — generated, do not edit manually.
#
# Forwards the agent's hook payload (stdin, untouched) to the VS Code window
# that owns this session. Never fails, and never holds the agent for long:
# whether Foreman is running must not be something the agent notices.
DIR="$(dirname "$0")"
EVENT_NAME="\${1:-\${HOOK_EVENT_NAME:-}}"
AGENT="\${2:-}"
# Drain stdin first: the agent blocks writing the payload until it is all read.
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

command -v curl >/dev/null 2>&1 || exit 0

# Where the window that owns this session is listening, freshest first: the
# route that window keeps current (it moves on every reload), the URL baked in
# at launch, the last window to start. "Nobody there" (refused) and "not my
# worktree" (404) move on to the next; a timeout does not — a window that is up
# but stuck costs one wait, never three.
ROUTE=""
case "$WORKSPACE_ID" in
  ""|*[!A-Za-z0-9_-]*) ;;
  *) ROUTE=$(cat "$DIR/routes/$WORKSPACE_ID" 2>/dev/null) || ROUTE="" ;;
esac
FALLBACK=$(cat "$DIR/hook-url" 2>/dev/null) || FALLBACK=""

TRIED=" "
for URL in "$ROUTE" "\${FOREMAN_HOOK_URL:-}" "$FALLBACK"; do
  [ -n "$URL" ] || continue
  case "$TRIED" in *" $URL "*) continue ;; esac
  TRIED="$TRIED$URL "
  ANSWER=$(printf '%s' "$PAYLOAD" | curl -sf --connect-timeout 1 --max-time 2 \\
    -X POST "$URL/hook" \\
    -H "Content-Type: application/json" \\
    -H "X-Foreman-Hook: 2" \\
    -H "X-Foreman-Event: $EVENT_NAME" \\
    -H "X-Foreman-Agent: $AGENT" \\
    -H "X-Foreman-Workspace: $WORKSPACE_ID" \\
    -H "X-Foreman-Window: $WINDOW_INDEX" \\
    -H "X-Foreman-Pane: \${TMUX_PANE:-}" \\
    --data-binary @- 2>/dev/null)
  case $? in
    7|22) continue ;;
  esac
  # The agent reads a hook's stdout (as context, or as a decision), so only a
  # reply that says it is one is relayed — never whatever else answered.
  case "$ANSWER" in
    foreman-reply:*) printf '%s\\n' "\${ANSWER#foreman-reply:}" ;;
  esac
  break
done
exit 0
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

  private routes: HookRoutes;

  private hookUrl?: string;

  constructor(
    storagePath: string,
    /** Absolute path to the agent's JSON hook config. */
    private settingsPath: string,
    /** Events this agent emits, out of the ones Foreman understands. */
    private events: readonly string[],
    /** Provider id, passed to the script as $2 so the server knows whose payload it is. */
    private agent: string,
  ) {
    this.scriptPath = path.join(storagePath, 'notify.sh');
    this.routes = new HookRoutes(storagePath);
    this.urlPath = this.routes.defaultUrlPath;
  }

  /**
   * Throws ConfigFileError when the agent's config cannot be edited safely
   * (syntax error, unexpected shape). The file is then left byte-identical and
   * the message is meant to be shown to the user as is.
   */
  install(hookUrl: string): void {
    this.hookUrl = hookUrl;
    this.writeScript();
    this.routes.setDefault(hookUrl);
    this.inject();
  }

  /** Same contract as install(): refuses, rather than clobbers, a broken config. */
  uninstall(): void {
    this.remove();
  }

  /** Env prefix for launching an agent in `worktreeId`; see HookRoutes.launchEnv. */
  launchEnv(worktreeId: string): string {
    return this.routes.launchEnv(worktreeId, this.hookUrl);
  }

  /** `"<script>" <Event> <agent>` — quoted so paths like "Application Support" survive. */
  protected commandFor(event: string): string {
    return `"${this.scriptPath}" ${event} ${this.agent}`;
  }

  private writeScript(): void {
    // Rewrite only on a real change: an unchanged file keeps its mtime, and
    // more importantly keeps whatever trust the agent has recorded for it.
    if (fs.existsSync(this.scriptPath) && fs.readFileSync(this.scriptPath, 'utf8') === SCRIPT) return;
    fs.mkdirSync(path.dirname(this.scriptPath), { recursive: true });
    // Atomic: agents run this file at any moment, and one executing it in the
    // middle of a rewrite would run half a script.
    const tmp = `${this.scriptPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, SCRIPT, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, this.scriptPath);
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
