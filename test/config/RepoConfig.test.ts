import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  readRepoConfig,
  renderRepoConfig,
  REPO_CONFIG_RELATIVE,
  REPO_CONFIG_VERSION,
} from '../../src/config/RepoConfig';
import { ForemanConfig } from '../../src/types';

/** In-memory stand-in for the two fs calls readRepoConfig makes. */
const fsWith = (files: Record<string, string>) => ({
  existsSync: (p: string) => p in files,
  readFileSync: ((p: string) => files[p] ?? '') as never,
});

const ROOT = path.join('/repo');
const FILE = path.join(ROOT, '.foreman', 'config.json');

const read = (body: unknown) =>
  readRepoConfig(ROOT, fsWith({ [FILE]: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('readRepoConfig', () => {
  it('looks in .foreman/config.json under the repo root', () => {
    expect(REPO_CONFIG_RELATIVE).toBe(path.join('.foreman', 'config.json'));
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
      setupScript: '.foreman/setup.sh',
      teardownScript: '.foreman/teardown.sh',
      docker: {
        composeFile: 'compose.yaml',
        overrideFile: 'compose.wt.yaml',
        ports: ['HTTP_PORT', 'DB_PORT'],
        basePort: 31000,
        portStride: 20,
      },
      debugBasePort: 9001,
      debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
    });

    expect(result.problems).toEqual([]);
    expect(result.present).toBe(true);
    expect(result.values).toEqual({
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.foreman/setup.sh',
      teardownScript: '.foreman/teardown.sh',
      docker: {
        composeFile: 'compose.yaml',
        overrideFile: 'compose.wt.yaml',
        ports: ['HTTP_PORT', 'DB_PORT'],
        basePort: 31000,
        portStride: 20,
      },
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
  });

  describe('types', () => {
    it('rejects a non-string where a string belongs, naming what it got', () => {
      expect(read({ setupScript: 7 }).problems[0]).toBe('"setupScript" must be a string, got number');
      expect(read({ setupScript: null }).problems[0]).toContain('got null');
      expect(read({ setupScript: [] }).problems[0]).toContain('got an array');
      expect(read({ setupScript: {} }).problems[0]).toContain('got object');
    });

    it('rejects ports outside 1..65535 and non-integers', () => {
      expect(read({ debugBasePort: 0 }).problems[0]).toContain('between 1 and 65535');
      expect(read({ debugBasePort: 70000 }).problems[0]).toContain('between 1 and 65535');
      expect(read({ debugBasePort: 98.6 }).problems[0]).toContain('whole number');
      expect(read({ debugBasePort: '9898' }).problems[0]).toContain('got string');
      expect(read({ debugBasePort: 9898 }).values.debugBasePort).toBe(9898);
    });

    it('requires docker.ports to be strings all the way down', () => {
      expect(read({ docker: { ports: ['HTTP_PORT', 8080] } }).problems[0])
        .toBe('"docker.ports" must be an array of strings, got an array');
      expect(read({ docker: { ports: 'HTTP_PORT' } }).problems[0]).toContain('must be an array of strings');
    });

    it('rejects a non-object docker', () => {
      expect(read({ docker: 'compose.yaml' }).problems[0]).toBe('"docker" must be an object, got string');
    });

    it('accepts a partial docker without resetting the rest', () => {
      // Restating basePort just to set composeFile is how a config file becomes
      // a copy of the defaults that silently rots.
      expect(read({ docker: { composeFile: 'compose.yaml' } }).values.docker).toEqual({
        composeFile: 'compose.yaml',
      });
    });

    it('names unknown docker keys with their full path', () => {
      expect(read({ docker: { composFile: 'x' } }).problems).toEqual(['unknown key "docker.composFile"']);
    });

    it('drops a docker object whose every key was rejected', () => {
      const result = read({ docker: { basePort: 'high' } });
      expect(result.values.docker).toBeUndefined();
      expect(result.problems).toHaveLength(1);
    });

    it('keeps the good docker keys alongside a rejected one', () => {
      const result = read({ docker: { composeFile: 'compose.yaml', portStride: -1 } });
      expect(result.values.docker).toEqual({ composeFile: 'compose.yaml' });
      expect(result.problems[0]).toContain('"docker.portStride"');
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

  describe('version', () => {
    it('accepts the version it writes', () => {
      expect(read({ version: REPO_CONFIG_VERSION }).problems).toEqual([]);
    });

    it('accepts an older version', () => {
      expect(read({ version: 0 }).problems).toEqual([]);
    });

    it('reads a newer file anyway, saying what it did', () => {
      // A teammate on a newer Foreman bumping this must not stop the repo working
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
  const effective: ForemanConfig = {
    worktreesDirectory: '../wt',
    defaultBaseBranch: 'trunk',
    setupScript: '.foreman/setup.sh',
    teardownScript: '.foreman/teardown.sh',
    defaultProvider: 'codex',
    claudeCommand: 'claude',
    codexCommand: 'codex',
    opencodeCommand: 'opencode',
    notifyOnAttention: false,
    scopeSearchToActiveWorktree: false,
    focusMode: true,
    docker: {
      composeFile: 'compose.yaml',
      overrideFile: 'compose.wt.yaml',
      ports: ['HTTP_PORT'],
      basePort: 31000,
      portStride: 20,
    },
    debugBasePort: 9001,
    debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
  };

  it('writes the repo-scoped settings currently in effect', () => {
    const parsed = JSON.parse(renderRepoConfig(effective));
    expect(parsed).toEqual({
      version: REPO_CONFIG_VERSION,
      worktreesDirectory: '../wt',
      defaultBaseBranch: 'trunk',
      setupScript: '.foreman/setup.sh',
      teardownScript: '.foreman/teardown.sh',
      docker: effective.docker,
      debugBasePort: 9001,
      debugTemplate: effective.debugTemplate,
    });
  });

  it('leaves the per-user settings out', () => {
    const parsed = JSON.parse(renderRepoConfig(effective)) as Record<string, unknown>;
    for (const key of ['defaultProvider', 'claudeCommand', 'focusMode', 'notifyOnAttention']) {
      expect(parsed[key]).toBeUndefined();
    }
  });

  it('round-trips through readRepoConfig without a complaint', () => {
    // The file we hand people has to be a file we accept.
    const result = readRepoConfig(ROOT, fsWith({ [FILE]: renderRepoConfig(effective) }));
    expect(result.problems).toEqual([]);
    expect(result.values.defaultBaseBranch).toBe('trunk');
    expect(result.values.docker).toEqual(effective.docker);
  });

  it('ends with a newline, for the diff of whoever commits it', () => {
    expect(renderRepoConfig(effective).endsWith('}\n')).toBe(true);
  });
});
