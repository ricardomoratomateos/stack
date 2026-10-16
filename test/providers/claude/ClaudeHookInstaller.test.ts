import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ClaudeHookInstaller } from '../../../src/providers/claude/ClaudeHookInstaller';
import { HookEntry } from '../../../src/types';
import { ConfigFileError } from '../../../src/providers/shared/configFile';

/** First 16 hex chars of sha256(notify.sh). See the "is pinned" test. */
const NOTIFY_SH_HASH = '66fc598fbbca4ff7';

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
];

describe('ClaudeHookInstaller', () => {
  let tmpDir: string;
  let storageDir: string;
  let settingsPath: string;
  let scriptPath: string;

  const hookUrl = 'http://127.0.0.1:43110';

  const makeHook = () => new ClaudeHookInstaller(storageDir, settingsPath);

  const readSettings = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const writeSettings = (obj: unknown) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-notifyhook-'));
    storageDir = path.join(tmpDir, 'storage');
    settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    scriptPath = path.join(storageDir, 'notify.sh');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeScript', () => {
    it('writes notify.sh with mode 0o755', () => {
      makeHook().install(hookUrl);
      expect(fs.existsSync(scriptPath)).toBe(true);
      expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
    });

    it('forwards the payload untouched, with our ids in headers, bounded in time', () => {
      makeHook().install(hookUrl);
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content.startsWith('#!/bin/bash\n')).toBe(true);
      expect(content).toContain('EVENT_NAME="${1:-${HOOK_EVENT_NAME:-}}"');
      expect(content).toContain('AGENT="${2:-}"');
      expect(content).toContain('ANSWER=$(printf \'%s\' "$PAYLOAD" | curl -sf --connect-timeout 1 --max-time 2');
      expect(content).toContain('--data-binary @-');
      for (const h of ['Hook: 2', 'Event: $EVENT_NAME', 'Agent: $AGENT', 'Workspace: $WORKSPACE_ID', 'Window: $WINDOW_INDEX']) {
        expect(content).toContain(`-H "X-Foreman-${h}"`);
      }
    });

    it('looks the endpoint up per worktree, then the launch env, then the shared file', () => {
      makeHook().install(hookUrl);
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content).toContain('ROUTE=$(cat "$DIR/routes/$WORKSPACE_ID" 2>/dev/null)');
      expect(content).toContain('for URL in "$ROUTE" "${FOREMAN_HOOK_URL:-}" "$FALLBACK"; do');
      // A worktree id that is not a plain token never becomes a path.
      expect(content).toContain('""|*[!A-Za-z0-9_-]*) ;;');
    });

    it('is pinned: changing it costs every Codex user a re-trust', () => {
      // Codex hashes the hook definition and silently skips a hook whose hash
      // no longer matches. If this fails, the change is a decision, not a
      // refactor: make it future-proof, mention it in the changelog, update
      // the hash.
      makeHook().install(hookUrl);
      const hash = createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex').slice(0, 16);
      expect(hash).toBe(NOTIFY_SH_HASH);
    });

    it('registers the provider id as $2', () => {
      makeHook().install(hookUrl);
      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      expect(hooks['Stop']?.[0]?.hooks[0]?.command).toBe(`"${scriptPath}" Stop claude`);
    });

    it('falls back to asking tmux when the launcher set no FOREMAN variables', () => {
      // An agent the user starts by hand has neither variable, and every event
      // it sent used to be discarded for carrying an empty workspace id.
      makeHook().install(hookUrl);
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content).toContain('WORKSPACE_ID="${FOREMAN_WORKSPACE_ID:-}"');
      expect(content).toContain('WINDOW_INDEX="${FOREMAN_WINDOW_INDEX:-}"');
      expect(content).toContain("tmux display-message -p -t \"$TMUX_PANE\" '#{window_index}'");
      expect(content).toContain("tmux display-message -p -t \"$TMUX_PANE\" '#{session_name}'");
      // Session names are "foreman-<worktree id>"; the prefix strip recovers it.
      expect(content).toContain('foreman-*) WORKSPACE_ID="${SESSION#foreman-}"');
    });

    it('does nothing outside tmux, where there is no pane to ask about', () => {
      makeHook().install(hookUrl);
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content).toContain('if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then');
    });

    it('does not rewrite when content is unchanged (bug 18)', () => {
      makeHook().install(hookUrl);
      // Backdate the file so any rewrite would be observable via mtime
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(scriptPath, past, past);
      const before = fs.statSync(scriptPath).mtimeMs;

      makeHook().install(hookUrl);

      expect(fs.statSync(scriptPath).mtimeMs).toBe(before);
    });

    it('leaves the script byte-identical when only the port changes', () => {
      // Codex records hook trust against a hash of the definition. A URL baked
      // into the script would change that hash on every activation (the
      // HookServer port is random), silently untrusting the hook.
      makeHook().install(hookUrl);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(scriptPath, past, past);
      const before = fs.statSync(scriptPath).mtimeMs;
      const script = fs.readFileSync(scriptPath, 'utf8');

      makeHook().install('http://127.0.0.1:55555');

      expect(fs.statSync(scriptPath).mtimeMs).toBe(before);
      expect(fs.readFileSync(scriptPath, 'utf8')).toBe(script);
    });

    it('writes the new endpoint to the url file the script reads', () => {
      makeHook().install(hookUrl);
      makeHook().install('http://127.0.0.1:55555');
      expect(fs.readFileSync(path.join(storageDir, 'hook-url'), 'utf8')).toBe('http://127.0.0.1:55555');
    });
  });

  describe('injectIntoClaudeSettings', () => {
    it('adds quoted command for all 7 hook events', () => {
      makeHook().install(hookUrl);
      const settings = readSettings();
      const hooks = settings['hooks'] as Record<string, HookEntry[]>;
      expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
      for (const event of HOOK_EVENTS) {
        expect(hooks[event]).toEqual([
          { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" ${event} claude` }] },
        ]);
      }
    });

    it('preserves unrelated existing hooks', () => {
      writeSettings({
        model: 'opus',
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }],
          Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'ping' }] }],
        },
      });

      makeHook().install(hookUrl);

      const settings = readSettings();
      expect(settings['model']).toBe('opus');
      const hooks = settings['hooks'] as Record<string, HookEntry[]>;
      // Unrelated event untouched
      expect(hooks['Notification']).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'ping' }] },
      ]);
      // Unrelated hook on a managed event preserved, ours appended after
      expect(hooks['Stop']).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'say done' }] },
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop claude` }] },
      ]);
    });

    it('is idempotent (double install adds nothing)', () => {
      makeHook().install(hookUrl);
      const first = readSettings();

      makeHook().install(hookUrl);
      const second = readSettings();

      expect(second).toEqual(first);
      for (const event of HOOK_EVENTS) {
        const hooks = (second['hooks'] as Record<string, HookEntry[]>)[event];
        expect(hooks).toHaveLength(1);
        expect(hooks[0].hooks).toHaveLength(1);
      }
    });

    it('removes old unquoted entries (paths with spaces migration)', () => {
      writeSettings({
        hooks: {
          Stop: [
            // Old-style unquoted entry, alone in its group → group dropped
            { matcher: '', hooks: [{ type: 'command', command: scriptPath }] },
            // Mixed group: unquoted entry removed, unrelated kept
            {
              matcher: '',
              hooks: [
                { type: 'command', command: scriptPath },
                { type: 'command', command: 'keep-me' },
              ],
            },
          ],
        },
      });

      makeHook().install(hookUrl);

      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      expect(hooks['Stop']).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] },
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop claude` }] },
      ]);
    });

    it('handles missing settings file (creates it, including parent dirs)', () => {
      expect(fs.existsSync(settingsPath)).toBe(false);
      makeHook().install(hookUrl);
      expect(fs.existsSync(settingsPath)).toBe(true);
      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      expect(Object.keys(hooks)).toHaveLength(7);
    });

    it('refuses to touch settings with a syntax error, and says where it is', () => {
      // This used to "start fresh": the user's permissions, env and model were
      // overwritten by a file holding only Foreman's hooks.
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const broken = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash"], }\n}';
      fs.writeFileSync(settingsPath, broken);

      expect(() => makeHook().install(hookUrl)).toThrow(ConfigFileError);
      expect(() => makeHook().install(hookUrl)).toThrow(/couldn't install its hooks: .*settings\.json has a syntax error at line 3, column \d+/);

      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
      expect(fs.existsSync(`${settingsPath}.foreman-backup`)).toBe(false);
    });

    it('refuses JSON that is not an object rather than replacing it', () => {
      writeSettings(['not', 'settings']);
      const before = fs.readFileSync(settingsPath, 'utf8');
      expect(() => makeHook().install(hookUrl)).toThrow(/is not a JSON object/);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('refuses a hooks block of an unexpected shape rather than clobbering it', () => {
      writeSettings({ model: 'opus', hooks: { Stop: 'say done' } });
      const before = fs.readFileSync(settingsPath, 'utf8');
      expect(() => makeHook().install(hookUrl)).toThrow(/"hooks\.Stop"/);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('passes through groups of a shape it does not know', () => {
      writeSettings({ hooks: { Stop: [{ matcher: 'x', run: 'other-tool' }] } });
      makeHook().install(hookUrl);
      const hooks = readSettings()['hooks'] as Record<string, unknown[]>;
      expect(hooks['Stop']).toEqual([
        { matcher: 'x', run: 'other-tool' },
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop claude` }] },
      ]);
    });

    it('treats an empty settings file as empty settings', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '\n');
      makeHook().install(hookUrl);
      expect(Object.keys(readSettings()['hooks'] as object)).toHaveLength(7);
    });

    it('keeps a one-time backup of the settings as they were before Foreman', () => {
      writeSettings({ model: 'opus' });
      const original = fs.readFileSync(settingsPath, 'utf8');

      makeHook().install(hookUrl);
      expect(fs.readFileSync(`${settingsPath}.foreman-backup`, 'utf8')).toBe(original);

      // A later change must not replace the user's own version with ours.
      writeSettings({ model: 'sonnet', hooks: {} });
      makeHook().install(hookUrl);
      expect(fs.readFileSync(`${settingsPath}.foreman-backup`, 'utf8')).toBe(original);
    });

    it('does not rewrite settings that already hold exactly our hooks', () => {
      makeHook().install(hookUrl);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(settingsPath, past, past);
      const before = fs.statSync(settingsPath).mtimeMs;

      makeHook().install(hookUrl);

      expect(fs.statSync(settingsPath).mtimeMs).toBe(before);
    });

    it('writes through a symlinked settings file instead of replacing the link', () => {
      // Dotfiles repos link ~/.claude/settings.json; an atomic rename over the
      // link would silently detach it from the repo.
      const real = path.join(tmpDir, 'dotfiles', 'claude-settings.json');
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.writeFileSync(real, JSON.stringify({ model: 'opus' }));
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.symlinkSync(real, settingsPath);

      makeHook().install(hookUrl);

      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      const written = JSON.parse(fs.readFileSync(real, 'utf8'));
      expect(written.model).toBe('opus');
      expect(Object.keys(written.hooks)).toHaveLength(7);
    });

    it("keeps the settings file's permissions", () => {
      writeSettings({ env: { TOKEN: 'secret' } });
      fs.chmodSync(settingsPath, 0o600);
      makeHook().install(hookUrl);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    });

    it('leaves no temp files behind', () => {
      writeSettings({ model: 'opus' });
      makeHook().install(hookUrl);
      const leftovers = fs.readdirSync(path.dirname(settingsPath)).filter((f) => f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('uninstall', () => {
    it('removes quoted, unquoted, and with-arg command variants', () => {
      writeSettings({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: scriptPath }] }, // unquoted
            { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}"` }] }, // quoted
            { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop` }] }, // with-arg
            { matcher: '', hooks: [{ type: 'command', command: 'unrelated' }] },
          ],
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" SessionStart` }] },
          ],
        },
      });

      makeHook().uninstall();

      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      expect(hooks['Stop']).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'unrelated' }] },
      ]);
      expect(hooks['SessionStart']).toEqual([]);
    });

    it('preserves hooks for events foreman does not manage', () => {
      writeSettings({
        hooks: {
          Notification: [{ matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Notification` }] }],
        },
      });

      makeHook().uninstall();

      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      // Only the 7 known events are cleaned; other events are left alone
      expect(hooks['Notification']).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Notification` }] },
      ]);
    });

    it('is a no-op when settings file missing', () => {
      expect(fs.existsSync(settingsPath)).toBe(false);
      expect(() => makeHook().uninstall()).not.toThrow();
      expect(fs.existsSync(settingsPath)).toBe(false);
    });

    it('is a no-op when settings has no hooks key', () => {
      writeSettings({ model: 'opus' });
      const before = fs.readFileSync(settingsPath, 'utf8');

      makeHook().uninstall();

      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('refuses to touch corrupt JSON, with a message saying so', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ broken');

      expect(() => makeHook().uninstall()).toThrow(/couldn't remove its hooks: .*syntax error/);

      expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ broken');
    });
  });

  describe('default settings path', () => {
    it('defaults to ~/.claude/settings.json when not injected', () => {
      const hook = new ClaudeHookInstaller(storageDir);
      // Read the resolved target without installing — writing to the real home
      // directory is exactly what this test must not do.
      const resolved = (hook as unknown as { settingsPath: string }).settingsPath;
      expect(resolved).toBe(path.join(os.homedir(), '.claude/settings.json'));
    });
  });
});
