import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { OsaNotifyAdapter } from '../../src/adapters/OsaNotifyAdapter';

// Intercept the child_process module so the DEFAULT run
// (`(cmd, args) => { execFile(cmd, args, () => {}); }`) executes for real
// without posting an actual OS notification.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('OsaNotifyAdapter default run', () => {
  it('spawns osascript via execFile when no runner is injected', () => {
    new OsaNotifyAdapter('darwin').notify('hello');

    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, callback] = vi.mocked(execFile).mock.calls[0] as unknown as [
      string,
      string[],
      (error: Error | null) => void,
    ];
    expect(cmd).toBe('osascript');
    expect(args).toEqual(['-e', 'display notification "hello" with title "Unmess"']);
    // The completion callback swallows errors (fire-and-forget).
    expect(() => callback(new Error('boom'))).not.toThrow();
  });
});
