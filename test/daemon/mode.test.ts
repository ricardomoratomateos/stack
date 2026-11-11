import { describe, expect, it } from 'vitest';
import { explicitUseDaemon, shouldUseDaemon } from '../../src/daemon/client/mode';

describe('shouldUseDaemon', () => {
  it('defaults to the daemon only when one is alive and the setting was never set', () => {
    expect(shouldUseDaemon(undefined, true)).toBe(true);
    expect(shouldUseDaemon(undefined, false)).toBe(false);
  });
  it('respects an explicit false even with a live daemon', () => {
    expect(shouldUseDaemon(false, true)).toBe(false);
  });
  it('respects an explicit true even without a daemon (the extension then starts one)', () => {
    expect(shouldUseDaemon(true, false)).toBe(true);
  });
});

describe('explicitUseDaemon', () => {
  it('ignores the default value and reads the narrowest explicit scope', () => {
    expect(explicitUseDaemon(undefined)).toBeUndefined();
    expect(explicitUseDaemon({})).toBeUndefined();
    expect(explicitUseDaemon({ globalValue: true })).toBe(true);
    expect(explicitUseDaemon({ globalValue: true, workspaceValue: false })).toBe(false);
    expect(explicitUseDaemon({ globalValue: false, workspaceFolderValue: true })).toBe(true);
  });
});
