import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTestCommand, type TestCommandIo } from '../../src/mcp/testCommand';

const io = (files: Record<string, string>): TestCommandIo => ({
  exists: (p) => p in files,
  read: (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    if (files[p] === '<unreadable>') throw new Error('EACCES');
    return files[p];
  },
});
const pkg = (test?: string) => JSON.stringify({ scripts: test === undefined ? {} : { test } });

describe('detectTestCommand', () => {
  it('runs a package.json test script with the package manager the lockfile names', () => {
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('vitest') }))).toBe('npm test');
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('vitest'), '/r/pnpm-lock.yaml': '' }))).toBe('pnpm test');
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('vitest'), '/r/yarn.lock': '' }))).toBe('yarn test');
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('vitest'), '/r/bun.lockb': '' }))).toBe('bun run test');
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('vitest'), '/r/bun.lock': '' }))).toBe('bun run test');
  });

  it('ignores npm\'s placeholder, an empty script, no scripts and broken JSON', () => {
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('echo "Error: no test specified" && exit 1') }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg('  ') }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/package.json': pkg() }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/package.json': JSON.stringify({ scripts: 'x' }) }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/package.json': '{' }))).toBeUndefined();
  });

  it('then composer.json, then a Makefile test target', () => {
    expect(detectTestCommand('/r', io({ '/r/composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }))).toBe('composer test');
    expect(detectTestCommand('/r', io({ '/r/composer.json': JSON.stringify({}) }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/Makefile': 'build:\n\tgo build\ntest:\n\tgo test ./...\n' }))).toBe('make test');
    expect(detectTestCommand('/r', io({ '/r/Makefile': 'build:\n' }))).toBeUndefined();
    expect(detectTestCommand('/r', io({ '/r/Makefile': '<unreadable>' }))).toBeUndefined();
    expect(detectTestCommand('/r', io({}))).toBeUndefined();
  });

  it('reads the real filesystem by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-tc-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), pkg('jest'));
      expect(detectTestCommand(dir)).toBe('npm test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
