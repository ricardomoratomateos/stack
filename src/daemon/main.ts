import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeConfig } from './NodeConfig';
import { MemoryStore, readVsCodeGlobalState } from './vscodeState';
import { collectStatus, formatStatus } from './status';
import { findRepoRoot } from '../worktree/findRepoRoot';
import * as fs from 'node:fs';

const USAGE = `stackd — Stack without VS Code

Usage:
  stackd status [repo]   Print the worktrees, sessions and states of a repo
                         (default: the repo containing the current directory).
`;

function resolveRepo(arg: string | undefined): string {
  const start = path.resolve(arg ?? process.cwd());
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const found = findRepoRoot([start], isDir);
  if (found) return found;
  try {
    // Inside a worktree or subfolder: ask git for the main checkout's root.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: start, encoding: 'utf8' }).trim();
    return path.dirname(common);
  } catch {
    return start;
  }
}

async function status(repoArg: string | undefined): Promise<void> {
  const repo = resolveRepo(repoArg);
  const store = new MemoryStore(await readVsCodeGlobalState());
  const items = await collectStatus(repo, {
    store,
    config: new NodeConfig(() => repo),
    storagePath: path.join(os.homedir(), '.config', 'stack'),
  });
  process.stdout.write(formatStatus(repo, items));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'status') {
    await status(rest[0]);
    return 0;
  }
  process.stderr.write(USAGE);
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => { process.stderr.write(`stackd: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); },
);
