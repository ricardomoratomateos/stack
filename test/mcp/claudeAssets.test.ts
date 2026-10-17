import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MARKER, claudeAssets, installClaudeAssets, removeClaudeAssets } from '../../src/mcp/claudeAssets';

describe('claudeAssets', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-claude-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

  it('ships a skill and the /stack, /stack-task, /stack-next commands, all marked as Stack\'s', () => {
    const assets = claudeAssets();
    expect(Object.keys(assets).sort()).toEqual([
      'commands/stack-next.md', 'commands/stack-task.md', 'commands/stack.md', 'skills/stack-manager/SKILL.md',
    ]);
    for (const body of Object.values(assets)) expect(body).toContain(MARKER);
    expect(assets['skills/stack-manager/SKILL.md']).toMatch(/^---\nname: stack-manager\ndescription: /);
    expect(assets['commands/stack-task.md']).toContain('$ARGUMENTS');
  });

  it('installs everything into an empty ~/.claude, and refreshes its own files later', () => {
    expect(installClaudeAssets(dir)).toEqual({ skipped: [] });
    expect(read('commands/stack.md')).toContain('stack_status');
    fs.writeFileSync(path.join(dir, 'commands/stack.md'), `old ${MARKER}`);
    installClaudeAssets(dir);
    expect(read('commands/stack.md')).toBe(claudeAssets()['commands/stack.md']);
  });

  it('never overwrites a file of the user\'s with the same name', () => {
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commands/stack.md'), 'mine');
    expect(installClaudeAssets(dir)).toEqual({ skipped: ['commands/stack.md'] });
    expect(read('commands/stack.md')).toBe('mine');
  });

  it('removes only what it installed, and the skill folder once it is empty', () => {
    installClaudeAssets(dir);
    fs.writeFileSync(path.join(dir, 'commands/stack-next.md'), 'mine now');
    removeClaudeAssets(dir);
    expect(fs.existsSync(path.join(dir, 'commands/stack.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'skills/stack-manager'))).toBe(false);
    expect(read('commands/stack-next.md')).toBe('mine now');
  });

  it('keeps the skill folder when the user put something else in it, and copes with nothing there', () => {
    installClaudeAssets(dir);
    fs.writeFileSync(path.join(dir, 'skills/stack-manager/notes.md'), 'x');
    removeClaudeAssets(dir);
    expect(fs.existsSync(path.join(dir, 'skills/stack-manager/notes.md'))).toBe(true);
    expect(() => removeClaudeAssets(path.join(dir, 'nowhere'))).not.toThrow();
  });
});
