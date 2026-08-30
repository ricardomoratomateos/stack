import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROVIDER_IDS, type ProviderId } from '../ports/IAgentProvider';
import type { ForemanConfig } from '../types';

/**
 * Which agents are actually runnable on this machine, so the card can dim the
 * ones that are not instead of letting tmux answer with `command not found`.
 *
 * Recomputed on every state push rather than cached: the whole check is a
 * handful of `access` calls, and caching would leave a freshly installed agent
 * dimmed until the window was reloaded.
 */
export function installedProviders(
  config: ForemanConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId[] {
  // Typed as a full Record, so adding a provider is a compile error here until
  // its command is wired in.
  const commands: Record<ProviderId, string> = {
    claude: config.claudeCommand,
    codex: config.codexCommand,
    grok: config.grokCommand,
    opencode: config.opencodeCommand,
  };
  return PROVIDER_IDS.filter((id) => isCommandAvailable(commands[id], env));
}

/**
 * Whether a configured launch command resolves to something executable.
 *
 * Resolved by walking PATH rather than shelling out to `which`: the sidebar
 * asks this for every provider on every activation, and four spawns to answer
 * "should this icon be dimmed" is a poor trade. It also keeps the check
 * synchronous, so buildState never has to await.
 *
 * Only the first token is looked up — commands carry flags
 * (`claude --dangerously-skip-permissions`), and a flag is not part of the
 * binary name.
 */
export function isCommandAvailable(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // A provider whose command setting is empty or missing is simply not runnable;
  // this must never throw, because it runs inside buildState.
  const binary = command?.trim().split(/\s+/)[0];
  if (!binary) return false;

  // An explicit path (absolute or relative) is never searched for on PATH.
  if (binary.includes(path.sep) || binary.startsWith('.')) return isExecutable(binary);

  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutable(path.join(dir, binary)));
}

function isExecutable(candidate: string): boolean {
  try {
    // X_OK rather than existsSync: a non-executable file with the right name
    // (a README, a directory) is not a runnable agent.
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
