import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_HOOKS_PATH } from '../../constants';
import { JsonHookInstaller } from '../shared/JsonHookInstaller';

/**
 * Codex emits the same events as Claude Code minus `SessionEnd` — it has no
 * end-of-session hook at all. A Codex window therefore never paints
 * "terminated"; it settles on "waiting" after its last `Stop` and is cleaned up
 * when the tmux window goes away.
 */
const HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
] as const;

export class CodexHookInstaller extends JsonHookInstaller {
  constructor(extensionStoragePath: string, codexHooksPath?: string) {
    super(
      extensionStoragePath,
      codexHooksPath ?? path.join(os.homedir(), CODEX_HOOKS_PATH),
      HOOK_EVENTS,
    );
  }
}
