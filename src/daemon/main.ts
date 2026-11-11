import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeConfig } from './NodeConfig';
import { daemonConfigDir } from './client/launch';
import { MemoryStore, readVsCodeGlobalState } from './vscodeState';
import { collectStatus, formatStatus } from './status';
import { findRepoRoot } from '../worktree/findRepoRoot';
import * as fs from 'node:fs';
import { StackDaemon } from './StackDaemon';
import { ApiServer, callDaemon, socketPathFor } from './api';
import type { Snapshot } from './StackDaemon';
import { canonicalPath } from '../worktree/worktreesInRepo';
import { BRIDGE_FILE } from '../mcp/protocol';

const USAGE = `stackd — Stack without VS Code

Usage:
  stackd serve           Run the daemon: owns the state (~/.config/stack/state.json),
                         receives the agents' hooks, serves the local API on
                         ~/.config/stack/stackd.sock (GET /state, GET /events,
                         POST /commands/<name>). One per user, all repos.
                         The VS Code extension uses it with the stack.useDaemon setting;
                         without that setting, do not run it on a repo the
                         extension has open: both would own its state.
  stackd status [repo]   Print the worktrees, sessions and states of a repo
                         (default: the repo containing the current directory).
                         Asks the daemon when it runs.

Environment: STACKD_CONFIG_DIR (default ~/.config/stack), STACKD_TMUX_SOCKET
(a tmux -L server of its own), STACKD_HOME (where ~/.claude, ~/.codex live),
STACKD_DEFER_IMPORT=1 (wait for a client's importState instead of reading VS Code's store).
`;

const configDir = daemonConfigDir;

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
  // The daemon, when it runs, is the one that knows.
  try {
    const snap = await callDaemon<Snapshot>(socketPathFor(configDir()), 'GET', '/state');
    const mine = snap.repos.find((r) => canonicalPath(r.repoRoot) === canonicalPath(repo));
    if (mine) {
      const items = [...mine.state.worktrees].map((w) => ({
        id: w.id, branch: w.branch, alias: w.alias, path: w.path, isMain: w.isMain,
        missing: w.missing === true, agent: w.agent, sessions: w.sessions,
      }));
      process.stdout.write(formatStatus(repo, items));
      return;
    }
  } catch { /* no daemon: read the state ourselves */ }
  const store = new MemoryStore(await readVsCodeGlobalState());
  const items = await collectStatus(repo, {
    store,
    config: new NodeConfig(() => repo),
    storagePath: configDir(),
  });
  process.stdout.write(formatStatus(repo, items));
}

async function serve(): Promise<void> {
  const dir = configDir();
  const bridge = path.join(__dirname, BRIDGE_FILE);
  const daemon = new StackDaemon({
    configDir: dir,
    home: process.env.STACKD_HOME,
    tmuxSocket: process.env.STACKD_TMUX_SOCKET || undefined,
    // The extension hands its live state over itself (importState) rather than have it read from VS Code's sqlite file.
    deferImport: process.env.STACKD_DEFER_IMPORT === '1',
    bridgeSource: fs.existsSync(bridge) ? bridge : undefined,
    log: (line) => process.stderr.write(line + '\n'),
  });
  const api = new ApiServer(daemon, socketPathFor(dir));
  await api.start();
  await daemon.start();
  process.stderr.write(`stackd: serving on ${api.socketPath}\n`);
  const stop = (): void => {
    void api.stop().then(() => daemon.stop()).finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Stay alive: the sockets and timers hold the loop open.
  await new Promise<never>(() => {});
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'serve') {
    await serve();
    return 0;
  }
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
