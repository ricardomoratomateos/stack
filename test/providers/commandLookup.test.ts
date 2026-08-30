import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCommandAvailable, installedProviders } from '../../src/providers/commandLookup';
import type { ForemanConfig } from '../../src/types';

let binDir: string;
let env: NodeJS.ProcessEnv;

/** Drop a real executable (or a plain file) into the fake PATH directory. */
function put(name: string, { executable = true } = {}) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: executable ? 0o755 : 0o644 });
  return p;
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bin-'));
  // A PATH of exactly one directory, so nothing the developer has installed
  // can leak into the result.
  env = { PATH: binDir };
});

afterEach(() => fs.rmSync(binDir, { recursive: true, force: true }));

describe('isCommandAvailable', () => {
  it('finds an executable on PATH', () => {
    put('codex');
    expect(isCommandAvailable('codex', env)).toBe(true);
  });

  it('does not find a command that is not there', () => {
    expect(isCommandAvailable('codex', env)).toBe(false);
  });

  it('ignores flags — only the binary is looked up', () => {
    put('claude');
    expect(isCommandAvailable('claude --dangerously-skip-permissions', env)).toBe(true);
  });

  it('rejects a non-executable file with the right name', () => {
    put('grok', { executable: false });
    expect(isCommandAvailable('grok', env)).toBe(false);
  });

  it('rejects a directory with the right name', () => {
    fs.mkdirSync(path.join(binDir, 'grok'));
    expect(isCommandAvailable('grok', env)).toBe(false);
  });

  it('resolves an absolute path without consulting PATH', () => {
    const abs = put('anywhere');
    expect(isCommandAvailable(abs, { PATH: '' })).toBe(true);
  });

  it('returns false for an absolute path that does not exist', () => {
    expect(isCommandAvailable('/nope/does-not-exist', env)).toBe(false);
  });

  it.each([undefined, '', '   '])('returns false for %o rather than throwing', (command) => {
    // This runs inside buildState, which must never throw on a blank setting.
    expect(isCommandAvailable(command, env)).toBe(false);
  });

  it('tolerates a missing PATH entirely', () => {
    expect(isCommandAvailable('codex', {})).toBe(false);
  });

  it('searches every PATH entry, not just the first', () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bin2-'));
    fs.writeFileSync(path.join(second, 'grok'), '#!/bin/sh\n', { mode: 0o755 });
    try {
      expect(isCommandAvailable('grok', { PATH: `${binDir}${path.delimiter}${second}` })).toBe(true);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('installedProviders', () => {
  const config = (over: Partial<ForemanConfig> = {}) =>
    ({
      claudeCommand: 'claude', codexCommand: 'codex',
      grokCommand: 'grok', opencodeCommand: 'opencode', ...over,
    }) as ForemanConfig;

  it('reports only the agents actually on PATH', () => {
    put('claude');
    put('grok');
    expect(installedProviders(config(), env)).toEqual(['claude', 'grok']);
  });

  it('reports none when nothing is installed', () => {
    expect(installedProviders(config(), env)).toEqual([]);
  });

  it('honours a custom command for a provider', () => {
    put('my-codex');
    expect(installedProviders(config({ codexCommand: 'my-codex' }), env)).toEqual(['codex']);
  });

  it('returns ids in the registered order, so the menu never reshuffles', () => {
    put('opencode');
    put('codex');
    put('claude');
    put('grok');
    expect(installedProviders(config(), env)).toEqual(['claude', 'codex', 'grok', 'opencode']);
  });
});
