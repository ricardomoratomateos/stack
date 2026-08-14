import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeHookInstaller } from '../../../src/providers/claude/ClaudeHookInstaller';
import { HookEntry } from '../../../src/types';

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-notifyhook-'));
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

    it('curls the endpoint read from the sibling url file, with UNMESS_* env vars', () => {
      makeHook().install(hookUrl);
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content.startsWith('#!/bin/bash\n')).toBe(true);
      expect(content).toContain('curl -s -X POST "$URL/hook"');
      expect(content).toContain('$UNMESS_TERMINAL_ID');
      expect(content).toContain('$UNMESS_WORKSPACE_ID');
      expect(content).toContain('EVENT_NAME="${1:-${HOOK_EVENT_NAME:-}}"');
      expect(content).toContain('"{\\"event\\":\\"$EVENT_NAME\\",\\"terminalId\\":\\"$UNMESS_TERMINAL_ID\\",\\"workspaceId\\":\\"$UNMESS_WORKSPACE_ID\\",\\"windowIndex\\":\\"$UNMESS_WINDOW_INDEX\\"}"');
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
          { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" ${event}` }] },
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
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop` }] },
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
        { matcher: '', hooks: [{ type: 'command', command: `"${scriptPath}" Stop` }] },
      ]);
    });

    it('handles missing settings file (creates it, including parent dirs)', () => {
      expect(fs.existsSync(settingsPath)).toBe(false);
      makeHook().install(hookUrl);
      expect(fs.existsSync(settingsPath)).toBe(true);
      const hooks = readSettings()['hooks'] as Record<string, HookEntry[]>;
      expect(Object.keys(hooks)).toHaveLength(7);
    });

    it('handles corrupt JSON settings (starts fresh)', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ not valid json !!!');

      expect(() => makeHook().install(hookUrl)).not.toThrow();

      const settings = readSettings();
      const hooks = settings['hooks'] as Record<string, HookEntry[]>;
      expect(Object.keys(hooks)).toHaveLength(7);
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

    it('preserves hooks for events unmess does not manage', () => {
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

    it('never throws (best effort) on corrupt JSON', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ broken');

      expect(() => makeHook().uninstall()).not.toThrow();

      // File left as-is (best effort bail-out)
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
