import * as net from 'node:net';
import { PROVIDER_IDS, PROVIDER_INSTALL, type IAgentProvider, type ProviderId } from '../ports/IAgentProvider';
import { isCommandAvailable, resolveOnPath } from '../providers/commandLookup';
import { managerStatus } from '../mcp/registration';
import type { StackConfig } from '../types';
import type { Check } from './doctorReport';

export type { Check } from './doctorReport';

export interface DoctorDeps {
  config: StackConfig;
  providers: IAgentProvider[];
  /** ~/.claude.json, where Claude Code keeps its user-scope MCP servers. */
  claudeConfigPath: string;
  /** The bridge copy stackd registers (`<configDir>/stack-mcp.js`), when there is one. */
  bridgePath?: string;
  socketPath: string;
  tmuxVersion: () => Promise<string | undefined>;
  /** Defaults to this process's. */
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether stackd is the one asking (fixes then say "restart stackd", not "start it"). */
  inDaemon?: boolean;
}

const START = 'Open Stack.app, or run `node dist/stackd.js serve`.';

function reachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const done = (ok: boolean) => { probe.destroy(); resolve(ok); };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(false));
  });
}

const MANAGER_DETAIL = {
  registered: 'Claude Code has the Stack MCP server (stack_* tools).',
  elsewhere: 'Claude Code\'s "stack" MCP server points at another copy',
  missing: 'Claude Code has no "stack" MCP server.',
} as const;

/** Everything stackd needs from this Mac, checked with the same functions stackd itself uses. */
export async function runChecks(d: DoctorDeps): Promise<Check[]> {
  const env = d.env ?? process.env;
  const checks: Check[] = [];
  const restart = d.inDaemon ? 'Restart stackd (it reinstalls hooks when it starts).' : START;

  const tmux = await d.tmuxVersion();
  checks.push(tmux
    ? { id: 'tmux', ok: true, detail: tmux }
    : { id: 'tmux', ok: false, detail: 'tmux not found on PATH.', fix: 'brew install tmux' });

  const node = d.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(node.replace(/^v/, ''), 10);
  checks.push(major >= 20
    ? { id: 'node', ok: true, detail: `v${node.replace(/^v/, '')}` }
    : { id: 'node', ok: false, detail: `v${node.replace(/^v/, '')}; Stack needs 20 or newer.`, fix: 'Install Node 20+ (brew install node, or nvm install 20); STACK_NODE picks a specific one.' });

  checks.push(await reachable(d.socketPath)
    ? { id: 'stackd', ok: true, detail: `answering on ${d.socketPath}` }
    : { id: 'stackd', ok: false, detail: `not running (no answer on ${d.socketPath}).`, fix: START });

  const commands: Record<ProviderId, string> = {
    claude: d.config.claudeCommand, opencode: d.config.opencodeCommand,
  };
  const found = (id: ProviderId) => isCommandAvailable(commands[id], env);

  for (const p of d.providers) {
    if (!found(p.id) || !p.hookStatus) continue;
    const s = p.hookStatus();
    const id = `hooks.${p.id}`;
    if (s.error) checks.push({ id, ok: false, detail: s.error, fix: `Fix ${s.file}, then restart stackd.` });
    else if (s.stale.length) checks.push({ id, ok: false, detail: `old VS Code extension hook left in ${s.file}: ${s.stale[0]}`, fix: restart });
    else if (s.missing.length) checks.push({ id, ok: false, detail: `missing in ${s.file}: ${s.missing.join(', ')}`, fix: restart });
    else checks.push({ id, ok: true, detail: `installed in ${s.file}` });
  }

  const mcp = managerStatus(d.claudeConfigPath, d.bridgePath);
  checks.push(mcp.state === 'registered'
    ? { id: 'mcp', ok: true, detail: MANAGER_DETAIL.registered }
    : {
      id: 'mcp', ok: false,
      detail: mcp.state === 'elsewhere' ? `${MANAGER_DETAIL.elsewhere}: ${mcp.detail ?? ''}`.trim() : MANAGER_DETAIL.missing,
      fix: 'Settings → "Stack tools in Claude Code" → Register.',
    });

  for (const id of PROVIDER_IDS) {
    const binary = commands[id]?.trim().split(/\s+/)[0] ?? id;
    const label = PROVIDER_INSTALL[id].label;
    if (found(id)) {
      checks.push({ id: `cli.${id}`, ok: true, detail: `${label}: ${resolveOnPath(binary, env) ?? binary}` });
    } else if (id === d.config.defaultProvider) {
      checks.push({ id: `cli.${id}`, ok: false, detail: `${label} ("${binary}") not found on PATH; it is the default agent.`, fix: PROVIDER_INSTALL[id].install });
    } else {
      checks.push({ id: `cli.${id}`, ok: true, detail: `${label} not installed (optional: ${PROVIDER_INSTALL[id].install}).` });
    }
  }
  return checks;
}
