import type { DockerContainer } from '../types';
import { PROJECT_LABEL, parseContainerList } from './containers';
import { createDockerRunner, failureSummary, type DockerRunOptions, type DockerRunResult, type IDockerRunner } from './dockerCli';

const POLL_INTERVAL_MS = 20_000;
/** A just-started stack is watched this closely, instead of at POLL_INTERVAL_MS. */
const NUDGE_INTERVAL_MS = 2_000;
const NUDGE_ATTEMPTS = 8;
/**
 * `docker ps` answers in milliseconds on a healthy daemon. One that has not
 * answered in 10s is wedged, and without a limit every poll tick stacked
 * another hung process on top of the last.
 */
const PS_TIMEOUT_MS = 10_000;
const INFO_TIMEOUT_MS = 10_000;
/** Waits between `docker info` attempts while the daemon may still be booting (~7s in total). */
const DAEMON_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Every compose-managed container on the machine, in one call.
 *
 * One `docker ps` grouped by the project label replaces one `docker compose ps`
 * per worktree: the cost no longer grows with the number of worktrees, and
 * `-a` because a stack whose containers exited is exactly the
 * one the user needs to see — without it a crashed stack looked like "no
 * containers" with nothing to say why.
 */
const PS_ARGS = ['ps', '-a', '--filter', `label=${PROJECT_LABEL}`, '--format', '{{json .}}'];

interface Watch {
  onChange: () => void;
  /** What the card last saw; the callback only fires when this changes. */
  signature?: string;
}

/** The CLI answered, but the daemon is not there (yet) — what Docker Desktop says while it boots. */
function daemonStarting(r: DockerRunResult): boolean {
  return r.code !== 0 && !r.notFound && !r.timedOut &&
    /cannot connect|is the docker daemon running|connection refused|error during connect|no such file or directory/i.test(r.stderr);
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DockerMonitor {
  private snapshot = new Map<string, DockerContainer[]>();
  private watches = new Map<string, Watch>();
  private pollTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private inFlight?: Promise<boolean>;
  /**
   * Bumped when monitoring stops altogether, so a `docker ps` that was already
   * running cannot repopulate the cache (and fire callbacks) after the fact.
   */
  private generation = 0;
  /** Why the last poll failed, so a broken daemon is reported once, not every poll. */
  private failure?: string;

  constructor(
    private readonly runner: IDockerRunner = createDockerRunner(),
    private readonly sleep: (ms: number) => Promise<void> = sleepFor,
  ) {}

  getContainers(project: string): DockerContainer[] {
    return this.snapshot.get(project) ?? [];
  }

  /** The compose project whose container publishes a host port, if any — to name who holds it. */
  projectPublishing(port: number): string | undefined {
    for (const [project, containers] of this.snapshot) {
      if (containers.some((c) => c.ports?.includes(port))) return project;
    }
    return undefined;
  }

  /** Why docker could not be listed on the last poll; undefined while it answers. */
  unavailable(): string | undefined {
    return this.failure;
  }

  startPolling(project: string, onChange: () => void): void {
    // The callback is recorded even when the project is already watched. It
    // used to be captured in a closure and dropped on an early return, so
    // whoever called first owned the project forever — and a worktree created
    // in this session registered a no-op, leaving its docker badge stale.
    const existing = this.watches.get(project);
    this.watches.set(project, { onChange, signature: existing?.signature });
    if (existing) return;
    if (!this.pollTimer) this.pollTimer = setInterval(() => void this.fetch(), POLL_INTERVAL_MS);
    void this.fetch();
  }

  /**
   * Watch closely for a few seconds, after something changed a stack.
   *
   * `up` returns as soon as containers are created, but a container that
   * crashes on boot only shows as exited a moment later; without this the card
   * kept its stale state for up to a full poll interval.
   */
  nudge(): void {
    if (this.watches.size === 0) return;
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    let remaining = NUDGE_ATTEMPTS;
    const timer = setInterval(() => {
      if (--remaining <= 0) {
        clearInterval(timer);
        this.nudgeTimer = undefined;
      }
      void this.fetch();
    }, NUDGE_INTERVAL_MS);
    this.nudgeTimer = timer;
    void this.fetch();
  }

  stopPolling(project: string): void {
    this.watches.delete(project);
    if (this.watches.size > 0) return;
    // Nothing left to watch: stop the clock and forget everything, including
    // the logged failure — a later start must report a broken daemon afresh.
    this.generation++;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    this.pollTimer = undefined;
    this.nudgeTimer = undefined;
    this.snapshot.clear();
    this.failure = undefined;
  }

  /**
   * A listing taken AFTER this call — not one already in flight, which may
   * predate whatever the caller just did to the stack. Resolves false when
   * docker could not be listed.
   */
  async refresh(): Promise<boolean> {
    if (this.inFlight) await this.inFlight;
    return this.fetch();
  }

  /** Run a `docker compose …` argv; resolves with the outcome, never throws. */
  runCompose(argv: string[], options: DockerRunOptions): Promise<DockerRunResult> {
    return this.runner.run(argv, options);
  }

  /**
   * Undefined when the daemon answers; otherwise what to tell the user.
   *
   * Retried with a short backoff because the common failure right after login
   * is Docker Desktop still booting, which resolves itself in seconds — and
   * failing `up` for that is how "sometimes the stack doesn't come up" starts.
   */
  async checkDaemon(): Promise<string | undefined> {
    let result = await this.info();
    for (const delay of DAEMON_RETRY_DELAYS_MS) {
      if (!daemonStarting(result)) break;
      await this.sleep(delay);
      result = await this.info();
    }
    if (result.code === 0) return undefined;
    if (result.notFound) {
      return 'The docker CLI was not found. Install Docker Desktop, OrbStack or Colima, or make sure `docker` is on your PATH.';
    }
    if (result.timedOut) return 'Docker did not answer within 10s — the daemon looks hung. Restart Docker and try again.';
    return daemonStarting(result)
      ? 'Docker is not running. Start Docker Desktop, OrbStack or Colima and try again.'
      : `Docker is not usable: ${failureSummary(result.stderr, 1)}`;
  }

  private info(): Promise<DockerRunResult> {
    return this.runner.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: INFO_TIMEOUT_MS });
  }

  dispose(): void {
    this.generation++;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    this.pollTimer = undefined;
    this.nudgeTimer = undefined;
    this.watches.clear();
    this.snapshot.clear();
    this.failure = undefined;
  }

  /**
   * One `docker ps` for everything, shared by every caller while it runs: a
   * daemon slow enough to outlast a poll interval must not get a second
   * listing piled on top of the first.
   */
  private fetch(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const run = this.runner
      .run(PS_ARGS, { timeoutMs: PS_TIMEOUT_MS })
      // The default runner never rejects; an injected one might, and a rejected
      // listing must not leave `inFlight` set and silence polling for good.
      .catch((e: unknown): DockerRunResult => ({ code: null, stdout: '', stderr: String(e), timedOut: false }))
      .then((result) => {
        this.inFlight = undefined;
        if (generation !== this.generation) return false;
        return this.apply(result);
      });
    this.inFlight = run;
    return run;
  }

  private apply(result: DockerRunResult): boolean {
    const failedBefore = this.failure;
    if (result.code !== 0) {
      const message = result.timedOut
        ? `docker ps did not answer within ${PS_TIMEOUT_MS / 1000}s`
        : failureSummary(result.stderr, 1) || `docker ps exited with ${result.code}`;
      // "No containers" and "docker could not be reached" used to be the same
      // silent empty list. Logged once per distinct message, so a permanent
      // failure does not spam every poll.
      if (message !== this.failure) console.error(`[stack] docker ps failed: ${message}`);
      this.failure = message;
      // A timeout is a slow daemon, and what was running probably still is; a
      // daemon that refused outright has no containers to show.
      if (!result.timedOut) this.snapshot.clear();
      this.notify(failedBefore !== this.failure);
      return false;
    }
    this.failure = undefined;
    const next = new Map<string, DockerContainer[]>();
    for (const { project, ...container } of parseContainerList(result.stdout)) {
      const list = next.get(project) ?? [];
      list.push(container);
      next.set(project, list);
    }
    for (const list of next.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    this.snapshot = next;
    this.notify(failedBefore !== undefined);
    return true;
  }

  /**
   * Fires each project's callback only when what its card shows changed. It
   * used to fire on every tick, re-rendering every card every 20s for nothing.
   */
  private notify(force: boolean): void {
    for (const [project, watch] of this.watches) {
      const signature = JSON.stringify(
        this.getContainers(project).map((c) => [c.name, c.state, c.exitCode, c.ports]),
      );
      if (!force && signature === watch.signature) continue;
      if (signature !== watch.signature) {
        const count = this.getContainers(project).length;
        // Without this, "the badge is empty" gives no way to tell a stack that
        // really is down from one Stack looks up under the wrong name.
        console.log(`[stack] docker "${project}": ${count} container(s)`);
      }
      watch.signature = signature;
      watch.onChange();
    }
  }
}
