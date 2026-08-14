import * as os from 'node:os';
import * as path from 'node:path';
import { GROK_HOOKS_PATH } from '../../constants';
import { JsonHookInstaller } from '../shared/JsonHookInstaller';

/**
 * Grok Build has no `PermissionRequest`. Its user-attention signal is
 * `Notification`, which fires when the agent wants the user — exactly what the
 * sidebar's attention badge is for — so that is what Unmess maps to the
 * "permission" state (see EVENT_TO_STATE). `PermissionDenied` is deliberately
 * not registered: it reports an outcome, not a request for you.
 */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
] as const;

export class GrokHookInstaller extends JsonHookInstaller {
  constructor(extensionStoragePath: string, grokHooksPath?: string) {
    super(
      extensionStoragePath,
      grokHooksPath ?? path.join(os.homedir(), GROK_HOOKS_PATH),
      HOOK_EVENTS,
    );
  }
}
