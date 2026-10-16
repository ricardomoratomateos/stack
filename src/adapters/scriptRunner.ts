import { spawn } from 'node:child_process';
import type { HostScriptRun } from '../application/WorktreeApplicationService';

/** Where a script's output goes — structurally a vscode.OutputChannel. */
export interface ScriptOutput {
  append(text: string): void;
  appendLine(text: string): void;
}

/**
 * Runs a script with bash to completion, streaming its output, and resolves its
 * exit code — `null` when it could not start, was killed, or ran out of time.
 * Never rejects: the caller is a delete that must go on either way.
 *
 * The script path and env go to spawn as an argument and an object, never
 * through a shell string, so neither a path with spaces nor an env value with
 * a quote in it can change what runs.
 */
export function runScript(run: HostScriptRun, out: ScriptOutput, spawnFn: typeof spawn = spawn): Promise<number | null> {
  return new Promise((resolve) => {
    out.appendLine(`▶ ${run.label} — ${run.script}`);
    const child = spawnFn('bash', [run.script], {
      cwd: run.cwd,
      env: { ...process.env, ...run.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const settle = (code: number | null, note: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.appendLine(note);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(null, `✗ ${run.label}: no answer after ${Math.round(run.timeoutMs / 1000)}s — stopped`);
    }, run.timeoutMs);
    child.stdout?.on('data', (chunk) => out.append(String(chunk)));
    child.stderr?.on('data', (chunk) => out.append(String(chunk)));
    // ENOENT for bash itself or the cwd arrives here, not as a throw.
    child.on('error', (e) => settle(null, `✗ ${run.label}: ${e.message}`));
    child.on('close', (code) => settle(code, code === 0 ? `✓ ${run.label}` : `✗ ${run.label}: exit code ${code}`));
  });
}
