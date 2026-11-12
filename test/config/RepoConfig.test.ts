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
      ports: ['HTTP_PORT', 'DB_PORT'],
      basePort: 31000,
      portStride: 20,
      debugBasePort: 9001,
      debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
    });

    expect(result.problems).toEqual([]);
    expect(result.present).toBe(true);
    expect(result.values).toEqual({
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.stack/setup.sh',
      setupInTerminal: true,
      teardownScript: '.stack/teardown.sh',
      ports: ['HTTP_PORT', 'DB_PORT'],
      basePort: 31000,
      portStride: 20,
      debugBasePort: 9001,
      debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
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

    it('rejects ports outside 1..65535 and non-integers', () => {
      expect(read({ debugBasePort: 0 }).problems[0]).toContain('between 1 and 65535');
      expect(read({ debugBasePort: 70000 }).problems[0]).toContain('between 1 and 65535');
      expect(read({ debugBasePort: 98.6 }).problems[0]).toContain('whole number');
      expect(read({ debugBasePort: '9898' }).problems[0]).toContain('got string');
      expect(read({ debugBasePort: 9898 }).values.debugBasePort).toBe(9898);
    });

    it('requires ports to be strings all the way down', () => {
      expect(read({ ports: ['HTTP_PORT', 8080] }).problems[0])
        .toBe('"ports" must be an array of strings, got an array');
      expect(read({ ports: 'HTTP_PORT' }).problems[0]).toContain('must be an array of strings');
    });

    it('rejects a basePort or portStride outside 1..65535', () => {
      expect(read({ basePort: 'high' }).problems[0]).toContain('"basePort"');
      expect(read({ portStride: -1 }).problems[0]).toContain('"portStride"');
    });

    it('requires a debugTemplate to at least name a debugger', () => {
      expect(read({ debugTemplate: { name: 'x' } }).problems[0])
        .toContain('needs at least a string "type" and "request"');
      expect(read({ debugTemplate: { type: 'php' } }).problems[0]).toContain('"type" and "request"');
      expect(read({ debugTemplate: 'php' }).problems[0]).toBe('"debugTemplate" must be an object, got string');
    });

    it('passes debugger-specific debugTemplate keys through untouched', () => {
      // We are not the authority on what a launch configuration may contain.
      const template = {
        type: 'php',
        request: 'launch',
        name: 'debug',
        port: '{{PORT}}',
        pathMappings: { '/var/www': '${workspaceFolder}' },
        xdebugSettings: { max_children: 128 },
      };
      expect(read({ debugTemplate: template }).values.debugTemplate).toEqual(template);
    });
  });

  describe('the retired docker block', () => {
    it('is skipped without a complaint, compose keys and all', () => {
      const result = read({ docker: { composeFile: 'compose.yaml', overrideFile: 'x.yml', networkName: 'n' } });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({});
    });

    it('still lends its named-port keys to a file written before they moved to the top level', () => {
      const result = read({ docker: { composeFile: 'compose.yaml', ports: ['HTTP_PORT'], basePort: 31000, portStride: 20 } });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({ ports: ['HTTP_PORT'], basePort: 31000, portStride: 20 });
    });

    it('loses to the top-level keys, and drops what does not validate', () => {
      const result = read({ ports: ['A'], docker: { ports: ['B'], basePort: 'high', portStride: 5 } });
      expect(result.problems).toEqual([]);
      expect(result.values).toEqual({ ports: ['A'], portStride: 5 });
    });

    it('is ignored when it is not an object', () => {
      expect(read({ docker: 'compose.yaml' })).toMatchObject({ values: {}, problems: [] });
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
    defaultProvider: 'codex',
    claudeCommand: 'claude',
    codexCommand: 'codex',
    opencodeCommand: 'opencode',
    notifyOnAttention: false,
    scopeSearchToActiveWorktree: false,
    focusMode: true,
    ports: ['HTTP_PORT'],
    basePort: 31000,
    portStride: 20,
    debugBasePort: 9001,
    debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
  };

  it('writes the repo-scoped settings currently in effect', () => {
    const parsed = JSON.parse(renderRepoConfig(effective));
    expect(parsed).toEqual({
      version: REPO_CONFIG_VERSION,
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.stack/setup.sh',
      setupInTerminal: false,
      teardownScript: '.stack/teardown.sh',
      ports: ['HTTP_PORT'],
      basePort: 31000,
      portStride: 20,
      debugBasePort: 9001,
      debugTemplate: effective.debugTemplate,
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
    expect(result.values.ports).toEqual(effective.ports);
  });

  it('ends with a newline, for the diff of whoever commits it', () => {
    expect(renderRepoConfig(effective).endsWith('}\n')).toBe(true);
  });
});

describe('updateRepoConfig', () => {
  const values = {
    worktreesDirectory: '../wt',
    ports: ['HTTP_PORT'],
    basePort: 31000,
    portStride: 20,
  };

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
    expect(result.values.ports).toEqual(values.ports);
    expect(result.problems).toEqual(['unknown key "futureKey"']);
  });
});
