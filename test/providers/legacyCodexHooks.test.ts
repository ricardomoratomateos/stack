import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { removeLegacyCodexHooks } from '../../src/providers/legacyCodexHooks';

/** Stack's hooks in `<home>/.codex/hooks.json`, as versions with Codex support wrote them. */
describe('removeLegacyCodexHooks', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;
  let hooksPath: string;
  let ours: (event: string) => string;

  const other = { type: 'command', command: '/other/harness/notify.sh' };
  const write = (v: unknown) => {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  };
  const read = () => JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-legacy-hooks-'));
    storageDir = path.join(tmpDir, 'config');
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    hooksPath = path.join(homeDir, '.codex', 'hooks.json');
    ours = (event) => `"${path.join(storageDir, 'notify.sh')}" ${event} codex`;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('does nothing, and creates nothing, when the file does not exist', () => {
    expect(removeLegacyCodexHooks(storageDir, homeDir)).toBeUndefined();
    expect(fs.existsSync(path.join(homeDir, '.codex'))).toBe(false);
  });

  it("takes out only Stack's entries, keeping other tools' hooks and the rest of the file", () => {
    write({
      model: 'o4',
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: ours('Stop') }] }, { hooks: [other] }],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: ours('SessionStart') }, other] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: ours('UserPromptSubmit') }] }],
        Custom: [{ hooks: [other] }],
      },
    });

    expect(removeLegacyCodexHooks(storageDir, homeDir)).toBeUndefined();

    expect(read()).toEqual({
      model: 'o4',
      hooks: {
        Stop: [{ hooks: [other] }],
        SessionStart: [{ matcher: '', hooks: [other] }],
        UserPromptSubmit: [],
        Custom: [{ hooks: [other] }],
      },
    });
  });

  it("also takes out the retired VS Code extension's notify.sh entries", () => {
    const old = path.join(tmpDir, 'Library/Application Support/Code/User/globalStorage/ricardomoratomateos.stack-agents/notify.sh');
    write({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${old}" Stop codex` }, other] }] } });

    removeLegacyCodexHooks(storageDir, homeDir);

    expect(read()).toEqual({ hooks: { Stop: [{ hooks: [other] }] } });
  });

  it("leaves a file with nothing of Stack's in it byte-identical, with no backup", () => {
    const text = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/other/harness/notify.sh"}]}]}}';
    write(text);

    removeLegacyCodexHooks(storageDir, homeDir);

    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(text);
    expect(fs.readdirSync(path.dirname(hooksPath))).toEqual(['hooks.json']);
  });

  it('never throws: a corrupted file is left as it is, and the reason returned', () => {
    write('{ not json');
    const why = removeLegacyCodexHooks(storageDir, homeDir);
    expect(why).toMatch(/hooks\.json/);
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe('{ not json');
  });

  it('honours a read-only file, saying why', () => {
    write({ hooks: { Stop: [{ hooks: [{ type: 'command', command: ours('Stop') }] }] } });
    const before = fs.readFileSync(hooksPath, 'utf8');
    fs.chmodSync(hooksPath, 0o444);
    try {
      expect(removeLegacyCodexHooks(storageDir, homeDir)).toBeDefined();
      expect(fs.readFileSync(hooksPath, 'utf8')).toBe(before);
    } finally {
      fs.chmodSync(hooksPath, 0o644);
    }
  });
});
