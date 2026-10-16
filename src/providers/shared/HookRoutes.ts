import * as fs from 'node:fs';
import * as path from 'node:path';
import { legacyStoragePath } from '../../migration/legacyStorage';

/** `<globalStorage>/routes/<worktree id>` → URL of the window that owns that worktree. */
export const ROUTES_DIR = 'routes';

/**
 * `<globalStorage>/hook-url` → URL of the most recently activated window.
 *
 * The last resort, for events no route claims (an agent run outside any
 * Stack session). It used to be the ONLY endpoint, shared by every window,
 * so the last window to open received every window's events.
 */
export const DEFAULT_URL_FILE = 'hook-url';

/**
 * Worktree ids are UUIDs; the hook script applies this same check before
 * using one as a file name, so a hand-named "stack-../x" tmux session cannot
 * point it anywhere else.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Tells each agent's hook which VS Code window to report to.
 *
 * Every window runs its own HookServer on a random port, but the hooks are
 * global — one notify.sh, registered once in ~/.claude/settings.json — so the
 * script needs a per-agent answer to "where is my window now?". Three sources,
 * freshest first, all read by notify.sh and the opencode plugin at send time:
 *
 * 1. `routes/<worktree id>`, claimed by the window that shows that worktree —
 *    on activation, whenever its sessions change, and at every launch. A
 *    reloaded window claims again with its new port, which is what lets agents
 *    that were already running reach it: their environment still holds the old
 *    port, but they read this file on every event.
 * 2. `$STACK_HOOK_URL`, set in the agent's environment at launch. Covers the
 *    moment before any route exists, and agents run where no worktree id can
 *    be worked out.
 * 3. `hook-url`, the last activated window.
 *
 * A route is a plain file holding a URL, so a window that crashed leaves only
 * a dead port behind, which costs the hook one refused connection.
 *
 * Everything written here is also written to Foreman's storage directory
 * while it exists (see legacyStoragePath): an agent Foreman started keeps
 * running Foreman's notify.sh (or opencode plugin) until it restarts, and
 * that script looks its window up THERE — in `routes/`, or in `hook-url` for
 * the 0.1.0 one. Kept current, those agents go on reporting to Stack.
 */
export class HookRoutes {
  readonly dir: string;

  readonly defaultUrlPath: string;

  /** Foreman's storage directory to keep in step, when this is Stack's own. */
  private readonly legacyRoot?: string;

  constructor(storagePath: string, opts: { mirrorLegacy?: boolean } = {}) {
    this.dir = path.join(storagePath, ROUTES_DIR);
    this.defaultUrlPath = path.join(storagePath, DEFAULT_URL_FILE);
    if (opts.mirrorLegacy !== false) this.legacyRoot = legacyStoragePath(storagePath);
  }

  /**
   * The same routes in Foreman's directory — only while that directory
   * exists: it is never created, so a machine that never ran Foreman gets
   * nothing.
   */
  private legacy(): HookRoutes | undefined {
    return this.legacyRoot && fs.existsSync(this.legacyRoot)
      ? new HookRoutes(this.legacyRoot, { mirrorLegacy: false })
      : undefined;
  }

  /** Points each worktree's hooks at `url`. Unchanged routes are not rewritten. */
  claim(worktreeIds: Iterable<string>, url: string): void {
    const ids = [...worktreeIds];
    for (const id of ids) {
      if (!SAFE_ID.test(id) || this.lookup(id) === url) continue;
      fs.mkdirSync(this.dir, { recursive: true });
      // Atomic: the hook reads this file while an agent is running, possibly in
      // the very instant it is rewritten.
      const tmp = path.join(this.dir, `.${id}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, url);
      fs.renameSync(tmp, path.join(this.dir, id));
    }
    this.legacy()?.claim(ids, url);
  }

  setDefault(url: string): void {
    fs.mkdirSync(path.dirname(this.defaultUrlPath), { recursive: true });
    fs.writeFileSync(this.defaultUrlPath, url);
    this.legacy()?.setDefault(url);
  }

  lookup(worktreeId: string): string | undefined {
    if (!SAFE_ID.test(worktreeId)) return undefined;
    try {
      return fs.readFileSync(path.join(this.dir, worktreeId), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Withdraws everything still pointing at `url`, when its window goes away.
   *
   * Only routes holding exactly our URL: a worktree another window has claimed
   * since — the same repository open twice, or the new window of a reload
   * racing the old one's shutdown — is that window's now.
   */
  release(url: string): void {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { /* no routes yet */ }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (this.lookup(name) === url) {
        try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* best effort */ }
      }
    }
    try {
      if (fs.readFileSync(this.defaultUrlPath, 'utf8').trim() === url) fs.rmSync(this.defaultUrlPath, { force: true });
    } catch { /* already gone */ }
    this.legacy()?.release(url);
  }

  /**
   * The env prefix an agent is launched with, claiming the worktree's route on
   * the way: launching from this window makes it the one the agent should talk
   * to, even if another window showing the same repository claimed it first.
   * The launch itself waits on the agent's first hook, so the claim has to be
   * in place before the agent starts, not after.
   */
  launchEnv(worktreeId: string, url: string | undefined): string {
    // DEPRECATED aliases: FOREMAN_* are the names from before the rename,
    // still exported for scripts and tools an agent's session may run that
    // read them. Stack's own hooks read STACK_* first.
    const env = [`STACK_WORKSPACE_ID="${worktreeId}"`, `FOREMAN_WORKSPACE_ID="${worktreeId}"`];
    if (url) {
      env.unshift(`STACK_HOOK_URL="${url}"`, `FOREMAN_HOOK_URL="${url}"`);
      // Never fail a launch over a routing file; $STACK_HOOK_URL still works.
      try { this.claim([worktreeId], url); } catch { /* best effort */ }
    }
    return env.join(' ');
  }
}
