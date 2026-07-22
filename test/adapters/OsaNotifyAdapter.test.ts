import { describe, it, expect, vi } from 'vitest';
import { OsaNotifyAdapter } from '../../src/adapters/OsaNotifyAdapter';

describe('OsaNotifyAdapter', () => {
  it('runs osascript with an escaped display notification on darwin', () => {
    const run = vi.fn();
    new OsaNotifyAdapter('darwin', run).notify('feature-x: agent finished');
    expect(run).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "feature-x: agent finished" with title "Unmess"',
    ]);
  });

  it('escapes double quotes and backslashes in message and title', () => {
    const run = vi.fn();
    new OsaNotifyAdapter('darwin', run).notify('run "rm -rf \\tmp"?', 'Un"mess"');
    expect(run).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "run \\"rm -rf \\\\tmp\\"?" with title "Un\\"mess\\""',
    ]);
  });

  it('is a no-op on non-darwin platforms', () => {
    const run = vi.fn();
    new OsaNotifyAdapter('linux', run).notify('hello');
    expect(run).not.toHaveBeenCalled();
  });

});
