import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestCommandIo {
  exists(p: string): boolean;
  read(p: string): string;
}

const nodeIo: TestCommandIo = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf8'),
};

function scripts(file: string, io: TestCommandIo): Record<string, unknown> {
  try {
    const parsed = JSON.parse(io.read(file)) as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === 'object' ? (parsed.scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * How the tests run in a checkout, when the repository itself says so — a
 * `test` script in package.json (run with the package manager its lockfile
 * names) or composer.json, or a `test:` target in a Makefile. Nothing is
 * guessed beyond that: a worker told a wrong command wastes a turn on it.
 */
export function detectTestCommand(dir: string, io: TestCommandIo = nodeIo): string | undefined {
  const pkg = path.join(dir, 'package.json');
  if (io.exists(pkg)) {
    const test = scripts(pkg, io).test;
    if (typeof test === 'string' && test.trim() && !/no test specified/.test(test)) {
      if (io.exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm test';
      if (io.exists(path.join(dir, 'yarn.lock'))) return 'yarn test';
      if (io.exists(path.join(dir, 'bun.lockb')) || io.exists(path.join(dir, 'bun.lock'))) return 'bun run test';
      return 'npm test';
    }
  }
  const composer = path.join(dir, 'composer.json');
  if (io.exists(composer) && scripts(composer, io).test !== undefined) return 'composer test';
  const makefile = path.join(dir, 'Makefile');
  if (io.exists(makefile)) {
    try {
      if (/^test:/m.test(io.read(makefile))) return 'make test';
    } catch { /* unreadable: no answer */ }
  }
  return undefined;
}
