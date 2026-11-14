import { describe, it, expect } from 'vitest';
import { permissionPromptOnScreen } from '../../src/session/permissionPrompt';

describe('permissionPromptOnScreen', () => {
  it("sees each agent's prompt at the bottom of the screen", () => {
    const claude = [
      '⏺ Bash(npm test)', '', ' Bash command', '   npm test', '   Run the tests', '',
      ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', '', '',
    ].join('\n');
    expect(permissionPromptOnScreen(claude)).toBe(true);
    expect(permissionPromptOnScreen('△ Permission required\n  $ ls\n  Allow once   Allow always   Reject')).toBe(true);
  });

  it('refuses a screen where the agent moved on', () => {
    expect(permissionPromptOnScreen('⏺ Bash(npm test)\n  ⎿  12 passed\n\n> \n  ? for shortcuts\n')).toBe(false);
    expect(permissionPromptOnScreen('')).toBe(false);
  });

  it('ignores a prompt that scrolled far up', () => {
    const old = ['Do you want to proceed?', ...Array.from({ length: 60 }, (_, i) => `output ${i}`)].join('\n');
    expect(permissionPromptOnScreen(old)).toBe(false);
  });
});
