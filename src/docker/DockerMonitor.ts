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

export class DockerMonitor {
  private cache = new Map<string, DockerContainer[]>();
  private pollTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly runner: IProcessRunner = defaultRunner) {}

  getContainers(dockerProjectName: string): DockerContainer[] {
    return this.cache.get(dockerProjectName) ?? [];
  }

  startPolling(project: string, onChange: () => void): void {
    if (this.pollTimers.has(project)) return;
    const poll = () => {
      this.fetchContainers(project).then((containers) => {
        this.cache.set(project, containers);
        onChange();
      }).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    this.pollTimers.set(project, timer);
  }

  stopPolling(dockerProjectName: string): void {
    const timer = this.pollTimers.get(dockerProjectName);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(dockerProjectName);
      this.cache.delete(dockerProjectName);
    }
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
    this.pollTimers.clear();
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
      (stdout) => parseDockerPsOutput(stdout),
      () => [],
    );
  }
}
