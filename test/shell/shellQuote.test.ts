import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellQuote, isEnvName, envPrefix } from '../../src/shell/shellQuote';

/** What a real sh makes of `printf %s <quoted>` — the only proof that counts. */
function shEcho(quoted: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
}

describe('shellQuote', () => {
  it('leaves plain paths and refs bare, so the terminal stays readable', () => {
    expect(shellQuote('/repo/.worktrees/feat-x')).toBe('/repo/.worktrees/feat-x');
    expect(shellQuote('feat/x')).toBe('feat/x');
    expect(shellQuote('8081')).toBe('8081');
  });

  it('quotes the empty string rather than letting it vanish', () => {
    expect(shellQuote('')).toBe("''");
    expect(shEcho(shellQuote(''))).toBe('');
  });

  it('single-quotes anything with a character a shell would act on', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('x$(id)')).toBe("'x$(id)'");
  });

  // The point of the module: none of these may run anything, and each must
  // reach the command as exactly the bytes it started as.
  it.each([
    'feat/$(touch /tmp/foreman-pwned)',
    'a`id`b',
    '${HOME}',
    'it\'s',
    "''",
    '"double" and \'single\'',
    'semi;colon | pipe & amp > redirect',
    'new\nline',
    '!history',
    '*glob?[x]',
  ])('round-trips %j through a real shell, unexpanded', (value) => {
    expect(shEcho(shellQuote(value))).toBe(value);
  });
});

describe('isEnvName / envPrefix', () => {
  it('accepts identifiers and refuses anything that would not be an assignment', () => {
    expect(isEnvName('HTTP_PORT')).toBe(true);
    expect(isEnvName('_x1')).toBe(true);
    expect(isEnvName('1X')).toBe(false);
    expect(isEnvName('A;B')).toBe(false);
    expect(isEnvName('A B')).toBe(false);
    expect(isEnvName('')).toBe(false);
  });

  it('quotes every value and drops names that are not identifiers', () => {
    expect(envPrefix({ FOREMAN_BRANCH: 'x$(id)', PORT: '8081', 'BAD;rm -rf /': '1' }))
      .toBe("FOREMAN_BRANCH='x$(id)' PORT=8081");
  });

  it('the prefix sets the variables without running what is in them', () => {
    const prefix = envPrefix({ V: 'a$(echo pwned)b`id`' });
    expect(execFileSync('/bin/sh', ['-c', `${prefix} sh -c 'printf %s "$V"'`], { encoding: 'utf8' }))
      .toBe('a$(echo pwned)b`id`');
  });
});
