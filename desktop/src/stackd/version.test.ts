import { describe, expect, it } from 'vitest';
import { APP_VERSION, stackdDrift } from './version';

describe('stackdDrift', () => {
  it('is null for the same version', () => {
    expect(stackdDrift('0.2.1', '0.2.1')).toBeNull();
  });

  it('calls a stackd without a version, or a lower one, older', () => {
    expect(stackdDrift('0.2.1', undefined)).toBe('older');
    expect(stackdDrift('0.2.1', '0.2.0')).toBe('older');
    expect(stackdDrift('0.10.0', '0.9.9')).toBe('older');
  });

  it('calls a higher one newer', () => {
    expect(stackdDrift('0.2.1', '0.3.0')).toBe('newer');
  });

  it('knows its own version, from the root package.json', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
