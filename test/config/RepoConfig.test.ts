import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  readRepoConfig,
  renderRepoConfig,
  updateRepoConfig,
  REPO_CONFIG_RELATIVE,
  REPO_CONFIG_VERSION,
} from '../../src/config/RepoConfig';
import { StackConfig } from '../../src/types';

/** In-memory stand-in for the two fs calls readRepoConfig makes. */
const fsWith = (files: Record<string, string>) => ({
  existsSync: (p: string) => p in files,
  readFileSync: ((p: string) => files[p] ?? '') as never,
});

const ROOT = path.join('/repo');
const FILE = path.join(ROOT, '.stack', 'config.json');

const read = (body: unknown) =>
  readRepoConfig(ROOT, fsWith({ [FILE]: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('readRepoConfig', () => {
  it('looks in .stack/config.json under the repo root', () => {
    expect(REPO_CONFIG_RELATIVE).toBe(path.join('.stack', 'config.json'));
  });

  it('returns nothing when there is no root', () => {
    expect(readRepoConfig(undefined, fsWith({ [FILE]: '{}' }))).toEqual({
      values: {},
      present: false,
      problems: [],
    });
  });

  it('returns nothing when the file is absent', () => {
    expect(readRepoConfig(ROOT, fsWith({}))).toEqual({ values: {}, present: false, problems: [] });
  });

  it('reads every repo-scoped key', () => {
    const result = read({
      version: 1,
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.stack/setup.sh',
      setupInTerminal: true,
      teardownScript: '.stack/teardown.sh',
    });

    expect(result.problems).toEqual([]);
    expect(result.present).toBe(true);
    expect(result.values).toEqual({
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.stack/setup.sh',
      setupInTerminal: true,
      teardownScript: '.stack/teardown.sh',
    });
  });

  it('ignores $schema, so an editor can be pointed at one', () => {
    const result = read({ $schema: './schema.json', defaultBaseBranch: 'trunk' });
    expect(result.problems).toEqual([]);
    expect(result.values.defaultBaseBranch).toBe('trunk');
  });

  it('is present but empty when the object is empty', () => {
    expect(read({})).toEqual({ values: {}, present: true, problems: [] });
  });

  describe('malformed input', () => {
    it('reports invalid JSON without throwing', () => {
      const result = read('{ "defaultBaseBranch": ');
      expect(result.present).toBe(true);
      expect(result.values).toEqual({});
      expect(result.problems[0]).toContain('not valid JSON');
    });

    it('rejects a top-level array', () => {
      expect(read([1, 2]).problems[0]).toContain('must contain a JSON object');
    });

    it('rejects a top-level string', () => {
      expect(read('"hello"').problems[0]).toContain('must contain a JSON object');
    });

    it('names unknown keys instead of ignoring them', () => {
      // A typo that silently does nothing is worse than one that complains: the
      // user's next move is to wonder why their setting had no effect.
      expect(read({ worktreeDirectory: '../wt' }).problems).toEqual(['unknown key "worktreeDirectory"']);
    });

    it('rejects a per-user key with an explanation of where it belongs', () => {
      const result = read({ focusMode: true, notifyOnAttention: false });
      expect(result.values).toEqual({});
      expect(result.problems).toHaveLength(2);
      expect(result.problems[0]).toContain('"focusMode" is a per-user setting');
      expect(result.problems[0]).toContain('your own VS Code settings');
    });

    it('keeps the session tab layout per-user too — it is how you like your editor, not the repo', () => {
      expect(read({ sessionTabs: 'single' }).problems[0]).toContain('"sessionTabs" is a per-user setting');
    });
  });

  describe('types', () => {
    it('rejects a non-string where a string belongs, naming what it got', () => {
      expect(read({ setupScript: 7 }).problems[0]).toBe('"setupScript" must be a string, got number');
      expect(read({ setupScript: null }).problems[0]).toContain('got null');
      expect(read({ setupScript: [] }).problems[0]).toContain('got an array');
      expect(read({ setupScript: {} }).problems[0]).toContain('got object');
    });

    it('rejects anything but a boolean for a switch', () => {
      expect(read({ setupInTerminal: 'yes' }).problems[0]).toBe('"setupInTerminal" must be true or false, got string');
      expect(read({ setupInTerminal: false }).values).toEqual({ setupInTerminal: false });
    });

  });

  describe('the retired docker block', () => {
    it('is skipped without a complaint, compose keys and all', () => {
      const result = read({ docker: { composeFile: 'compose.yaml', overrideFile: 'x.yml', networkName: 'n' } });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({});
    });

    it('no longer lends its named-port keys to anything', () => {
      const result = read({ docker: { composeFile: 'compose.yaml', ports: ['HTTP_PORT'], basePort: 31000, portStride: 20 } });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({});
    });

    it('is ignored when it is not an object', () => {
      expect(read({ docker: 'compose.yaml' })).toMatchObject({ values: {}, problems: [] });
    });
  });

  describe('keys of removed features', () => {
    // A file written for an older Stack — or kept for a teammate still on one —
    // must load: the keys are skipped, the rest of the file still applies.
    it('skips ports, basePort, portStride, debugBasePort, debugTemplate and scopeSearchToActiveWorktree quietly', () => {
      const result = read({
        defaultBaseBranch: 'trunk',
        ports: ['HTTP_PORT'],
        basePort: 31000,
        portStride: 20,
        debugBasePort: 9001,
        debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
        scopeSearchToActiveWorktree: false,
      });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({ defaultBaseBranch: 'trunk' });
    });

    it('skips them whatever shape they have', () => {
      const result = read({ ports: 'nope', basePort: 'high', debugTemplate: 7, setupScript: 'make setup' });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({ setupScript: 'make setup' });
    });
  });

  describe('version', () => {
    it('accepts the version it writes', () => {
      expect(read({ version: REPO_CONFIG_VERSION }).problems).toEqual([]);
    });

    it('accepts an older version', () => {
      expect(read({ version: 0 }).problems).toEqual([]);
    });

    it('reads a newer file anyway, saying what it did', () => {
      // A teammate on a newer Stack bumping this must not stop the repo working
      // for everyone still on this build.
      const result = read({ version: REPO_CONFIG_VERSION + 1, defaultBaseBranch: 'trunk' });
      expect(result.values.defaultBaseBranch).toBe('trunk');
      expect(result.problems[0]).toContain(`declares version ${REPO_CONFIG_VERSION + 1}`);
      expect(result.problems[0]).toContain('Reading the keys it recognises');
    });

    it('rejects a non-numeric version but still reads the file', () => {
      const result = read({ version: 'one', defaultBaseBranch: 'trunk' });
      expect(result.values.defaultBaseBranch).toBe('trunk');
      expect(result.problems[0]).toBe('"version" must be a number, got string');
    });
  });
});

describe('renderRepoConfig', () => {
  const effective: StackConfig = {
    worktreesDirectory: '../wt',
    defaultBaseBranch: 'trunk',
    setupScript: '.stack/setup.sh',
    setupInTerminal: false,
    teardownScript: '.stack/teardown.sh',
    defaultProvider: 'opencode',
    claudeCommand: 'claude',
    opencodeCommand: 'opencode',
    notifyOnAttention: false,
    focusMode: true,
  } as StackConfig;

  it('writes the repo-scoped settings currently in effect', () => {
    const parsed = JSON.parse(renderRepoConfig(effective));
    expect(parsed).toEqual({
      version: REPO_CONFIG_VERSION,
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.stack/setup.sh',
      setupInTerminal: false,
      teardownScript: '.stack/teardown.sh',
    });
  });

  it('leaves the per-user settings out', () => {
    const parsed = JSON.parse(renderRepoConfig(effective)) as Record<string, unknown>;
    for (const key of ['defaultProvider', 'claudeCommand', 'focusMode', 'notifyOnAttention', 'sessionTabs']) {
      expect(parsed[key]).toBeUndefined();
    }
  });

  it('round-trips through readRepoConfig without a complaint', () => {
    // The file we hand people has to be a file we accept.
    const result = readRepoConfig(ROOT, fsWith({ [FILE]: renderRepoConfig(effective) }));
    expect(result.problems).toEqual([]);
    expect(result.values.defaultBaseBranch).toBe('trunk');
    expect(result.values.teardownScript).toBe('.stack/teardown.sh');
  });

  it('ends with a newline, for the diff of whoever commits it', () => {
    expect(renderRepoConfig(effective).endsWith('}\n')).toBe(true);
  });
});

describe('updateRepoConfig', () => {
  const values = {
    worktreesDirectory: '../wt',
    defaultBaseBranch: 'trunk',
    setupInTerminal: true,
  };

  it('keeps the keys of removed features a file still carries', () => {
    const existing = JSON.stringify({ version: 1, ports: ['HTTP_PORT'], debugBasePort: 9001 });
    const parsed = JSON.parse(updateRepoConfig(existing, values)) as Record<string, unknown>;
    expect(parsed['ports']).toEqual(['HTTP_PORT']);
    expect(parsed['debugBasePort']).toBe(9001);
  });

  it('keeps keys this build does not know, where they were', () => {
    // A teammate on a newer Stack added `agentsDirectory`; saving from this
    // one used to re-render the file from the keys it knows and drop it.
    const existing = JSON.stringify({
      version: 1,
      $schema: './schema.json',
      agentsDirectory: '.agents',
      worktreesDirectory: '.worktrees',
    });
    const parsed = JSON.parse(updateRepoConfig(existing, values)) as Record<string, unknown>;

    expect(parsed['agentsDirectory']).toBe('.agents');
    expect(parsed['$schema']).toBe('./schema.json');
    expect(parsed['worktreesDirectory']).toBe('../wt');
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['version', '$schema', 'agentsDirectory', 'worktreesDirectory']);
  });

  it('leaves a key it was given no value for as the file has it', () => {
    const existing = JSON.stringify({ version: 1, setupScript: 'make setup', worktreesDirectory: '.worktrees' });
    const parsed = JSON.parse(updateRepoConfig(existing, { ...values, setupScript: undefined }));
    expect(parsed.setupScript).toBe('make setup');
    expect(parsed.worktreesDirectory).toBe('../wt');
  });

  it('never takes the version down', () => {
    const existing = JSON.stringify({ version: REPO_CONFIG_VERSION + 2, worktreesDirectory: '.worktrees' });
    expect(JSON.parse(updateRepoConfig(existing, values)).version).toBe(REPO_CONFIG_VERSION + 2);
  });

  it('brings an older or missing version up to this one', () => {
    expect(JSON.parse(updateRepoConfig('{"version":0}', values)).version).toBe(REPO_CONFIG_VERSION);
    expect(JSON.parse(updateRepoConfig('{}', values)).version).toBe(REPO_CONFIG_VERSION);
  });

  it('replaces a file that is not a JSON object, as the panel says it will', () => {
    for (const broken of ['{ "worktreesDirectory": ', '[1,2]', 'null']) {
      const parsed = JSON.parse(updateRepoConfig(broken, values));
      expect(parsed).toEqual({ version: REPO_CONFIG_VERSION, ...values });
    }
  });

  it('writes a new file with version first and a trailing newline', () => {
    const out = updateRepoConfig(undefined, values);
    expect(Object.keys(JSON.parse(out))[0]).toBe('version');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('round-trips through readRepoConfig: the known keys read, the new one reported', () => {
    const existing = JSON.stringify({ version: 1, futureKey: true });
    const result = readRepoConfig(ROOT, fsWith({ [FILE]: updateRepoConfig(existing, values) }));
    expect(result.values.worktreesDirectory).toBe('../wt');
    expect(result.values.setupInTerminal).toBe(true);
    expect(result.problems).toEqual(['unknown key "futureKey"']);
  });
});
