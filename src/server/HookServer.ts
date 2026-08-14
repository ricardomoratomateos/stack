import * as http from 'node:http';
import { exec } from 'node:child_process';
import * as os from 'node:os';
import { AgentSessionState } from '../types';

/** Structural interface satisfied by AgentSessionManager. */
export interface AgentStateUpdater {
  updateState(workspaceId: string, state: AgentSessionState, windowIndex?: number): void;
}

export const EVENT_TO_STATE: Record<string, AgentSessionState> = {
  SessionStart:    'waiting',
  UserPromptSubmit:'active',
  PreToolUse:      'active',
  PostToolUse:     'active',
  Stop:            'waiting',
  SessionEnd:      'terminated',
  PermissionRequest: 'permission',
  // Grok Build has no PermissionRequest; Notification is its "the agent wants
  // you" signal, which is what the attention badge exists to surface.
  Notification:      'permission',
};

export class HookServer {
  private server: http.Server;
  private port = 0;

  constructor(
    private agentManager: AgentStateUpdater,
    private platform: NodeJS.Platform = os.platform(),
    private soundExec: (cmd: string) => void = (cmd) => { exec(cmd); },
  ) {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/hook') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as {
              event?: string;
              terminalId?: string;
              workspaceId?: string;
              windowIndex?: string;
            };
            const state = EVENT_TO_STATE[data.event ?? ''];
            const id = data.workspaceId ?? data.terminalId;
            if (state && id) {
              // Empty string = agent launched before UNMESS_WINDOW_INDEX existed.
              const idx = data.windowIndex ? Number(data.windowIndex) : NaN;
              if (Number.isFinite(idx)) this.agentManager.updateState(id, state, idx);
              else this.agentManager.updateState(id, state);
            }
            if (data.event === 'Stop') {
              if (this.platform === 'darwin') {
                this.soundExec('afplay /System/Library/Sounds/Glass.aiff');
              }
            }
          } catch {
            // malformed payload — ignore
          }
          res.writeHead(200);
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  dispose(): void {
    this.server.close();
  }
}
