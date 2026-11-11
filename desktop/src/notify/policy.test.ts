import { describe, expect, it } from 'vitest';
import { GROUP_MS, NotifyPolicy, RENOTIFY_MS, type Need, type PolicyInput } from './policy';

const need = (id: string, body = 'Bash: npm test'): Need => ({ id, title: `repo · ${id}`, body });
const input = (needs: Need[], over: Partial<PolicyInput> = {}): PolicyInput => ({ needs, focused: false, dnd: false, ...over });
const MIN = 60_000;

describe('NotifyPolicy', () => {
  it('notifies one ask after the grouping window, with the repo · worktree title and the command', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    expect(p.due(GROUP_MS - 1)).toBeNull();
    expect(p.due(GROUP_MS)).toEqual({ title: 'repo · a', body: 'Bash: npm test', ids: ['a'] });
    expect(p.due(GROUP_MS + 1000)).toBeNull();
  });

  it('groups asks that arrive within the window', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    p.update(2000, input([need('a'), need('b')]));
    p.update(4000, input([need('a'), need('b'), need('c')]));
    const n = p.due(GROUP_MS);
    expect(n?.title).toBe('3 tasks need you');
    expect(n?.ids).toEqual(['a', 'b', 'c']);
    expect(p.due(GROUP_MS + 1)).toBeNull();
  });

  it('an ask that comes after the group went out starts its own', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    p.due(GROUP_MS);
    p.update(8000, input([need('a'), need('b')]));
    expect(p.due(8000 + GROUP_MS - 1)).toBeNull();
    expect(p.due(8000 + GROUP_MS)?.ids).toEqual(['b']);
  });

  it('forgets asks that are answered', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    p.update(1000, input([]));
    expect(p.due(10 * MIN)).toBeNull();
  });

  it('never notifies for the session on screen while the app is focused', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a'), need('b')], { focused: true, selectedId: 'a' }));
    expect(p.due(GROUP_MS)?.ids).toEqual(['b']);
    p.update(GROUP_MS + 1, input([need('a')], { focused: true, selectedId: 'a' }));
    expect(p.due(30 * MIN)).toBeNull();
  });

  it('notifies for the selected session when the app is not focused', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')], { focused: false, selectedId: 'a' }));
    expect(p.due(GROUP_MS)?.ids).toEqual(['a']);
  });

  it('a held ask restarts its schedule when the user looks away', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')], { focused: true, selectedId: 'a' }));
    p.update(20_000, input([need('a')], { focused: true, selectedId: 'a' }));
    p.update(21_000, input([need('a')], { focused: true, selectedId: 'b' }));
    expect(p.due(21_000 + GROUP_MS - 1)).toBeNull();
    expect(p.due(21_000 + GROUP_MS)?.ids).toEqual(['a']);
  });

  it('re-notifies at 2 and 10 minutes, then stops', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    expect(p.due(GROUP_MS)).not.toBeNull();
    const keep = (t: number) => p.update(t, input([need('a')]));
    keep(MIN);
    expect(p.due(RENOTIFY_MS[0] - 1)).toBeNull();
    keep(RENOTIFY_MS[0]);
    expect(p.due(RENOTIFY_MS[0])?.ids).toEqual(['a']);
    expect(p.due(RENOTIFY_MS[1] - 1)).toBeNull();
    expect(p.due(RENOTIFY_MS[1])?.ids).toEqual(['a']);
    expect(p.due(60 * MIN)).toBeNull();
  });

  it('a different ask in the same worktree is new', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')]));
    p.due(GROUP_MS);
    p.update(30_000, input([need('a', 'Bash: rm -rf x')]));
    expect(p.due(30_000 + GROUP_MS)?.body).toBe('Bash: rm -rf x');
  });

  it('Do Not Disturb mutes everything, and the schedule starts when it ends', () => {
    const p = new NotifyPolicy();
    p.update(0, input([need('a')], { dnd: true }));
    expect(p.due(10 * MIN)).toBeNull();
    p.update(10 * MIN, input([need('a')], { dnd: true }));
    p.update(10 * MIN + 1000, input([need('a')]));
    expect(p.due(10 * MIN + 1000 + GROUP_MS)?.ids).toEqual(['a']);
  });
});
