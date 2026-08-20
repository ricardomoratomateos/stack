import { exec } from 'node:child_process';
import { DockerContainer } from '../types';
import type { ExecOptions, IProcessRunner } from '../ports/IProcessRunner';

const DOCKER_PATH = `${process.env['PATH'] ?? ''}:/usr/local/bin:/opt/homebrew/bin`;
const POLL_INTERVAL_MS = 20_000;

export const defaultRunner: IProcessRunner = {
  exec(cmd: string, options?: ExecOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          timeout: options?.timeout,
        },
        (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout.trim());
        },
      );
    });
  },
};

export function parseDockerPsOutput(output: string): DockerContainer[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    // bug 20: handle both JSON array (Docker Compose v2.21+) and JSONL
    if (trimmed.startsWith('[')) {
      const rows = JSON.parse(trimmed) as { Name?: string; State?: string }[];
      return rows.map((r) => ({
        name: r.Name ?? 'unknown',
        state: r.State === 'running' ? 'running' : 'stopped',
      }));
    }

    return trimmed
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { Name?: string; State?: string };
          return [{
            name: parsed.Name ?? 'unknown',
            state: (parsed.State === 'running' ? 'running' : 'stopped') as 'running' | 'stopped',
          }];
        } catch { return []; }
      });
  } catch {
    return [];
  }
}

/** A just-started stack is watched this closely, instead of at POLL_INTERVAL_MS. */
const NUDGE_INTERVAL_MS = 2_000;
const NUDGE_ATTEMPTS = 8;

export class DockerMonitor {
  private cache = new Map<string, DockerContainer[]>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private nudgeTimers = new Map<string, NodeJS.Timeout>();
  /** Held separately from the timer so a later, better callback can replace an earlier one. */
  private callbacks = new Map<string, () => void>();
  /** Last logged failure per project, so a broken daemon is reported once, not every poll. */
  private lastFailure = new Map<string, string>();

  constructor(private readonly runner: IProcessRunner = defaultRunner) {}

  getContainers(dockerProjectName: string): DockerContainer[] {
    return this.cache.get(dockerProjectName) ?? [];
  }

  startPolling(project: string, onChange: () => void): void {
    // The callback is recorded even when a timer already exists. It used to be
    // captured in the closure and dropped on the early return, so whoever
    // called first owned the project forever — and a worktree created in this
    // session registered a no-op, leaving its docker badge stale until the
    // window was reloaded.
    this.callbacks.set(project, onChange);
    if (this.pollTimers.has(project)) return;
    const timer = setInterval(() => this.pollOnce(project), POLL_INTERVAL_MS);
    this.pollTimers.set(project, timer);
    this.pollOnce(project);
  }

  /**
   * Watch a project closely for a few seconds.
   *
   * The commands that change a stack run in a *visible* terminal so the user can
   * see pull/build progress, which means Unmess never learns when they
   * finished. Without this, bringing a stack up left the badge wrong for up to a
   * full poll interval even though the containers were already serving.
   */
  nudge(project: string): void {
    const existing = this.nudgeTimers.get(project);
    if (existing) clearInterval(existing);

    let remaining = NUDGE_ATTEMPTS;
    const timer = setInterval(() => {
      if (--remaining <= 0) {
        clearInterval(timer);
        this.nudgeTimers.delete(project);
      }
      this.pollOnce(project);
    }, NUDGE_INTERVAL_MS);
    this.nudgeTimers.set(project, timer);
    this.pollOnce(project);
  }

  stopPolling(dockerProjectName: string): void {
    const timer = this.pollTimers.get(dockerProjectName);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(dockerProjectName);
      this.cache.delete(dockerProjectName);
    }
    const nudge = this.nudgeTimers.get(dockerProjectName);
    if (nudge) {
      clearInterval(nudge);
      this.nudgeTimers.delete(dockerProjectName);
    }
    this.callbacks.delete(dockerProjectName);
  }

  private pollOnce(project: string): void {
    this.fetchContainers(project).then((containers) => {
      // Logged only on a change, so a steady state does not spam every poll.
      // Without it, "the badge is empty" gives no way to tell a project whose
      // stack really is down from one Unmess is looking up under a name docker
      // has never heard of.
      const before = this.cache.get(project);
      if (!before || before.length !== containers.length) {
        console.log(`[unmess] docker "${project}": ${containers.length} container(s)`);
      }
      this.cache.set(project, containers);
      this.callbacks.get(project)?.();
    }).catch(() => {});
  }

  async refresh(project: string): Promise<DockerContainer[]> {
    const containers = await this.fetchContainers(project);
    this.cache.set(project, containers);
    return containers;
  }

  /** Run a `docker compose <args>` command headless in cwd, then refresh the project's cache. */
  async runCompose(project: string, cwd: string, args: string, env: Record<string, string>): Promise<void> {
    await this.runner.exec(`docker compose ${args}`, {
      cwd,
      env: { ...process.env, PATH: DOCKER_PATH, ...env },
    });
    await this.refresh(project);
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    for (const timer of this.nudgeTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    this.nudgeTimers.clear();
    this.callbacks.clear();
    this.cache.clear();
  }

  // List by explicit project (-p) so it matches exactly what Unmess started and
  // needs no compose file or cwd — `docker compose -p <name> ps` queries the
  // engine by the project label.
  private fetchContainers(project: string): Promise<DockerContainer[]> {
    return this.runner.exec(`docker compose -p "${project}" ps --format json`, {
      env: {
        ...process.env,
        PATH: DOCKER_PATH,   // bug 12
      },
    }).then(
      (stdout) => {
        this.lastFailure.delete(project);
        return parseDockerPsOutput(stdout);
      },
      (err: unknown) => {
        // "No containers" and "docker could not be reached" used to be the same
        // silent empty array, which made an unreachable daemon indistinguishable
        // from a stack that simply is not up. Logged once per distinct message
        // per project, so a permanent failure does not spam every poll.
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        if (this.lastFailure.get(project) !== message) {
          this.lastFailure.set(project, message);
          console.error(`[unmess] docker ps failed for "${project}": ${message}`);
        }
        return [];
      },
    );
  }
}
