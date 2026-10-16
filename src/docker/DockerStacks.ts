import * as path from 'node:path';
import type { DockerContainer, ForemanConfig, Worktree } from '../types';
import type { INotifyPort } from '../ports/INotifyPort';
import { isPortFree as probePort } from '../worktree/portProbe';
import { displayLabel } from '../worktree/displayLabel';
import { canonicalPath } from '../worktree/worktreesInRepo';
import type { DockerMonitor } from './DockerMonitor';
import { failureSummary } from './dockerCli';
import { conflictMessage, publishedPorts, type PortConflict } from './composeConfig';
import {
  composeArgv,
  composeProject,
  composeScriptEnv,
  dockerEnv,
  dockerPortsFor,
  legacyComposeProjects,
  type ComposeFiles,
} from './dockerCompose';

/** Pulls and builds legitimately take minutes; an `up` still going after this is stuck. */
const UP_TIMEOUT_MS = 15 * 60_000;
/** `config` only reads files. */
const CONFIG_TIMEOUT_MS = 30_000;
/** Long enough for containers to stop gracefully; short enough that deleting never hangs on a dead daemon. */
export const DOWN_TIMEOUT_MS = 60_000;

/** Where compose's output goes: a "Foreman: Docker" output channel in the extension. */
export interface DockerOutput {
  append(text: string): void;
  /** Bring the log into view without taking focus. */
  reveal(): void;
  /** An error toast offering to open the log. */
  showError(message: string): void;
}

export interface DockerStacksDeps {
  monitor: DockerMonitor;
  config: () => ForemanConfig;
  /** Resolve a repo-relative file: the worktree's own copy first, then the main repo's. */
  locate: (wt: Worktree, file: string) => string | undefined;
  exists: (p: string) => boolean;
  notify: Pick<INotifyPort, 'showWarning' | 'withProgress'>;
  output: DockerOutput;
  /** Repaint: busy/error state changed. */
  onChange: () => void;
  isPortFree?: (port: number) => Promise<boolean>;
}

export type DownOutcome = 'ok' | 'failed' | 'timeout';

/**
 * Starts, stops and describes each worktree's compose stack.
 *
 * Everything runs as an awaited child process. `up` used to be typed into a
 * terminal, which meant Foreman never learned whether it worked: a stack that
 * died on "port is already allocated" left a card with no containers, a ▶ and
 * no reason, the error scrolled away in a terminal nobody was looking at.
 */
export class DockerStacks {
  private busy = new Map<string, 'starting' | 'stopping'>();
  private errors = new Map<string, string>();

  constructor(private readonly deps: DockerStacksDeps) {}

  watch(wt: Worktree): void {
    this.deps.monitor.startPolling(composeProject(wt), this.deps.onChange, legacyComposeProjects(wt));
  }

  unwatch(wt: Worktree): void {
    this.deps.monitor.stopPolling(composeProject(wt));
  }

  /** Re-list containers now, e.g. before deciding which ports are the stack's own. */
  refresh(): Promise<boolean> {
    return this.deps.monitor.refresh();
  }

  status(wt: Worktree): { busy?: 'starting' | 'stopping'; error?: string } {
    return { busy: this.busy.get(wt.id), error: this.errors.get(wt.id) };
  }

  /**
   * The projects this worktree's containers currently run under: its own name,
   * plus any legacy name a stack from an older Foreman still uses. A legacy
   * name was shared between repositories, so its containers only count when
   * compose recorded a project directory inside this worktree or its repo.
   */
  projectsWithContainers(wt: Worktree): string[] {
    const current = composeProject(wt);
    const found = this.deps.monitor.getContainers(current).length > 0 ? [current] : [];
    for (const legacy of legacyComposeProjects(wt)) {
      if (this.legacyContainers(wt, legacy).length > 0) found.push(legacy);
    }
    return found;
  }

  /**
   * The project name to address this worktree's stack by: a legacy one while
   * a stack from an older Foreman still runs under it, its own otherwise.
   */
  project(wt: Worktree): string {
    return this.projectsWithContainers(wt)[0] ?? composeProject(wt);
  }

  containers(wt: Worktree): DockerContainer[] {
    const current = composeProject(wt);
    const own = this.deps.monitor.getContainers(current);
    if (own.length > 0) return own;
    for (const legacy of legacyComposeProjects(wt)) {
      const found = this.legacyContainers(wt, legacy);
      if (found.length > 0) return found;
    }
    return [];
  }

  /**
   * Ports this worktree's own stack already publishes, plus its debug port.
   * Probing them finds them busy — by the very containers `up` is about to
   * keep — and treating that as a collision moved a running stack to a new
   * slot and left its .env behind. The debug port is VS Code's own listener
   * for this worktree whenever a debug session is open.
   */
  ownPorts(wt: Worktree): Set<number> {
    const own = new Set<number>([wt.debugPort]);
    for (const project of this.projectsWithContainers(wt)) {
      const list = project === composeProject(wt)
        ? this.deps.monitor.getContainers(project)
        : this.legacyContainers(wt, project);
      for (const c of list) for (const p of c.ports ?? []) own.add(p);
    }
    return own;
  }

  /**
   * Compose files for a worktree. A configured override that exists nowhere is
   * reported rather than silently dropped: that drop is how every worktree
   * ended up publishing the base file's ports and colliding.
   */
  files(wt: Worktree): { files: ComposeFiles; baseFound: boolean; missingOverride?: string } {
    const { composeFile, overrideFile } = this.deps.config().docker;
    const located = this.deps.locate(wt, composeFile);
    // Default to the main-repo path even if missing, so docker errors visibly.
    const files: ComposeFiles = { base: located ?? path.join(wt.repoRoot, composeFile) };
    if (!overrideFile || overrideFile === composeFile) return { files, baseFound: !!located };
    const override = this.deps.locate(wt, overrideFile);
    if (override) files.override = override;
    return { files, baseFound: !!located, missingOverride: override ? undefined : overrideFile };
  }

  /** COMPOSE_PROJECT_NAME, COMPOSE_FILE and the port vars for scripts run in a worktree. */
  scriptEnv(wt: Worktree): Record<string, string> {
    return composeScriptEnv(wt, this.deps.config(), this.files(wt).files, this.project(wt));
  }

  /**
   * Bring the stack up and report — with compose's own words — when it does
   * not come up. `relocate` gets the chance to move the worktree off ports a
   * stranger took, once the stack's own ports are known.
   */
  async up(
    worktree: Worktree,
    relocate: (wt: Worktree, ownPorts: Set<number>) => Promise<Worktree> = async (wt) => wt,
  ): Promise<boolean> {
    if (this.busy.has(worktree.id)) return false;
    this.setBusy(worktree, 'starting');
    const label = displayLabel(worktree);
    try {
      return await this.deps.notify.withProgress(`Starting Docker for "${label}"`, async (report) => {
        report('Checking Docker…');
        const daemon = await this.deps.monitor.checkDaemon();
        if (daemon) return this.fail(worktree, daemon);

        // A fresh listing, so the stack's own ports are not taken for a stranger's.
        await this.deps.monitor.refresh();
        const wt = await relocate(worktree, this.ownPorts(worktree));

        const { files, missingOverride } = this.files(wt);
        if (missingOverride && !wt.isMain) {
          const message = `"${label}": the override file ${missingOverride} was not found in the worktree or the main repo, so only ${this.deps.config().docker.composeFile} is used — its ports are published as written.`;
          this.deps.output.append(`⚠ ${message}\n`);
          this.deps.notify.showWarning(message);
        }
        const env = this.env(wt);

        report('Checking ports…');
        const config = await this.compose(wt, composeArgv(wt, files, ['config', '--format', 'json']), env, CONFIG_TIMEOUT_MS, false);
        if (config.code !== 0 && /unknown (flag|shorthand)/i.test(config.stderr)) {
          // A compose too old for `config --format json`: the check is a
          // courtesy, so go without it rather than refuse to start at all.
          this.deps.output.append('(compose is too old to resolve its configuration as JSON — skipping the port check)\n');
        } else if (config.code !== 0) {
          return this.fail(wt, `the compose configuration is invalid: ${failureSummary(config.stderr) || `exit ${config.code}`}`);
        } else {
          const conflicts = await this.portConflicts(wt, publishedPorts(config.stdout));
          if (conflicts.length > 0) return this.fail(wt, conflictMessage(conflicts, this.deps.config().docker.composeFile));
        }

        report('docker compose up…');
        this.deps.output.reveal();
        const result = await this.compose(wt, composeArgv(wt, files, ['up', '-d']), env, UP_TIMEOUT_MS, true);
        if (result.code !== 0) {
          return this.fail(wt, result.timedOut
            ? `docker compose up was still running after ${UP_TIMEOUT_MS / 60_000} minutes and was stopped.`
            : failureSummary(result.stderr) || `docker compose up exited with ${result.code}`);
        }
        this.errors.delete(wt.id);
        return true;
      });
    } finally {
      await this.settle(worktree);
    }
  }

  /**
   * Bring the stack down — under every name it is running as, so a stack from
   * an older Foreman is not orphaned. Bounded by `timeoutMs` so deleting a
   * worktree can never hang on a wedged daemon. With `report` off, failures are
   * left to the caller.
   */
  async down(wt: Worktree, options: { timeoutMs?: number; report?: boolean } = {}): Promise<DownOutcome> {
    const { timeoutMs = DOWN_TIMEOUT_MS, report = true } = options;
    if (this.busy.has(wt.id)) return 'failed';
    this.setBusy(wt, 'stopping');
    try {
      await this.deps.monitor.refresh();
      const { files, baseFound } = this.files(wt);
      const projects = this.projectsWithContainers(wt);
      let outcome: DownOutcome = 'ok';
      for (const project of projects.length > 0 ? projects : [composeProject(wt)]) {
        // Without its compose file compose can still remove a stack by name.
        const argv = composeArgv(wt, baseFound ? files : undefined, ['down'], project);
        const result = await this.compose(wt, argv, this.env(wt), timeoutMs, true);
        if (result.timedOut) outcome = 'timeout';
        else if (result.code !== 0 && outcome === 'ok') {
          outcome = 'failed';
          this.errors.set(wt.id, failureSummary(result.stderr) || `docker compose down exited with ${result.code}`);
        }
      }
      if (outcome === 'ok') this.errors.delete(wt.id);
      if (outcome === 'timeout') this.errors.set(wt.id, `docker compose down did not finish within ${timeoutMs / 1000}s.`);
      if (outcome !== 'ok' && report) {
        this.deps.output.showError(`Docker stack for "${displayLabel(wt)}" did not stop: ${this.errors.get(wt.id)}`);
      }
      return outcome;
    } finally {
      await this.settle(wt);
    }
  }

  /** Forget a worktree's busy/error state, once it is gone. */
  forget(wt: Worktree): void {
    this.busy.delete(wt.id);
    this.errors.delete(wt.id);
  }

  private env(wt: Worktree): Record<string, string> {
    // PWD by hand: there is no shell in between any more to set it, and compose
    // files use ${PWD} to mean "this worktree".
    return { ...dockerEnv(wt, this.deps.config()), PWD: wt.path };
  }

  private compose(
    wt: Worktree,
    argv: string[],
    env: Record<string, string>,
    timeoutMs: number,
    log: boolean,
    cwd = this.deps.exists(wt.path) ? wt.path : wt.repoRoot,
  ) {
    if (log) this.deps.output.append(`\n$ docker ${argv.map(quoteForLog).join(' ')}\n`);
    return this.deps.monitor.runCompose(argv, {
      cwd,
      env,
      timeoutMs,
      onOutput: log ? (chunk) => this.deps.output.append(chunk) : undefined,
    });
  }

  /**
   * Every published port of the RESOLVED model that something else holds —
   * hard-coded ones included, which the allocator never sees because they are
   * not Foreman's to move.
   */
  private async portConflicts(wt: Worktree, published: Array<{ service: string; port: number }>): Promise<PortConflict[]> {
    const probe = this.deps.isPortFree ?? probePort;
    const own = this.ownPorts(wt);
    const generated = new Map<number, string>();
    if (!wt.isMain) {
      for (const [name, port] of Object.entries(dockerPortsFor(wt.debugPort, this.deps.config()))) generated.set(port, name);
    }
    const conflicts: PortConflict[] = [];
    for (const p of published) {
      if (own.has(p.port) || (await probe(p.port))) continue;
      const conflict: PortConflict = { ...p };
      const foremanVar = generated.get(p.port);
      if (foremanVar) conflict.foremanVar = foremanVar;
      const heldBy = this.deps.monitor.projectPublishing(p.port);
      if (heldBy) conflict.heldBy = heldBy;
      conflicts.push(conflict);
    }
    return conflicts;
  }

  private fail(wt: Worktree, message: string): false {
    this.errors.set(wt.id, message);
    this.deps.output.append(`✗ ${message}\n`);
    this.deps.output.showError(`Docker stack for "${displayLabel(wt)}" did not start: ${message}`);
    return false;
  }

  private setBusy(wt: Worktree, phase: 'starting' | 'stopping'): void {
    this.busy.set(wt.id, phase);
    this.deps.onChange();
  }

  /** After a change: re-list now, watch closely for crash-on-boot, repaint. */
  private async settle(wt: Worktree): Promise<void> {
    this.busy.delete(wt.id);
    await this.deps.monitor.refresh();
    this.deps.monitor.nudge();
    this.deps.onChange();
  }

  private legacyContainers(wt: Worktree, project: string): DockerContainer[] {
    const roots = [canonicalPath(wt.path), canonicalPath(wt.repoRoot)];
    return this.deps.monitor.getContainers(project).filter((c) => {
      if (!c.workingDir) return true;
      const dir = canonicalPath(c.workingDir);
      return roots.some((r) => dir === r || dir.startsWith(r + path.sep));
    });
  }
}

/** Shell-style quoting for the log line only — nothing is executed through a shell. */
function quoteForLog(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
