import { describe, expect, it } from 'vitest';
import { gitEnv } from '../../src/git/gitEnv';

describe('gitEnv', () => {
  it('keeps the environment and turns optional locks off', () => {
    const env = gitEnv();
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.PATH).toBe(process.env.PATH);
  });
});
