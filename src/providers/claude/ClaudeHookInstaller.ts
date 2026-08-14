import * as os from 'node:os';
import * as path from 'node:path';
import { CLAUDE_SETTINGS_PATH } from '../../constants';
import { JsonHookInstaller } from '../shared/JsonHookInstaller';

/** Everything Unmess paints a state from. Claude Code emits all of them. */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
] as const;

export class ClaudeHookInstaller extends JsonHookInstaller {
  constructor(extensionStoragePath: string, claudeSettingsPath?: string) {
    super(
      extensionStoragePath,
      claudeSettingsPath ?? path.join(os.homedir(), CLAUDE_SETTINGS_PATH),
      HOOK_EVENTS,
    );
  }
}
