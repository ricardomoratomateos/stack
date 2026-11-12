import { describe, expect, it } from 'vitest';
import { diagnostics } from './diagnostics';

describe('diagnostics', () => {
  const doctor = [{ id: 'tmux', ok: true, detail: 'tmux 3.4' }];

  it("puts the app's version check ahead of stackd's", () => {
    expect(diagnostics('0.2.1', true, '0.2.1', doctor)).toEqual([
      { id: 'version', ok: true, detail: 'stackd and app 0.2.1' },
      ...doctor,
    ]);
  });

  it('fails an older stackd and points at Restart', () => {
    const [version] = diagnostics('0.2.1', true, '0.2.0', doctor);
    expect(version).toMatchObject({ ok: false, detail: 'stackd 0.2.0 is older than the app (0.2.1).' });
    expect(version.fix).toMatch(/Restart/);
  });

  it('shows a stackd without the doctor command as a failure, not an empty list', () => {
    const checks = diagnostics('0.2.1', true, undefined, { error: 'Unknown command "doctor".' });
    expect(checks.map((c) => [c.id, c.ok])).toEqual([['version', false], ['doctor', false]]);
  });

  it('without stackd, says so and how to run the checks from a terminal', () => {
    const [only, ...rest] = diagnostics('0.2.1', false, undefined, []);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: 'stackd', ok: false });
    expect(only.fix).toContain('stackd.js doctor');
  });
});
