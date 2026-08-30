import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCRIPT_TEMPLATES } from '../../src/settings/scriptTemplates';

/**
 * The variables the application service actually exports when it runs a
 * lifecycle script. Read from the source so the templates cannot go on
 * documenting a variable that was renamed, which is the whole failure mode
 * these starter scripts exist to prevent.
 */
const EXPORTED = new Set(
  [...fs
    .readFileSync(path.join(__dirname, '../../src/application/WorktreeApplicationService.ts'), 'utf8')
    .matchAll(/^\s+(FOREMAN_[A-Z_]+):/gm)].map((m) => m[1]),
);

describe('SCRIPT_TEMPLATES', () => {
  it('ships a setup and a teardown', () => {
    expect(Object.keys(SCRIPT_TEMPLATES).sort()).toEqual(['setup', 'teardown']);
  });

  for (const [kind, body] of Object.entries(SCRIPT_TEMPLATES)) {
    describe(kind, () => {
      it('is a bash script that stops on the first error', () => {
        expect(body.startsWith('#!/usr/bin/env bash\n')).toBe(true);
        expect(body).toContain('set -euo pipefail');
      });

      it('starts from the worktree it was run for', () => {
        expect(body).toContain('cd "$FOREMAN_WORKTREE_PATH"');
      });

      it('leaves every command commented out', () => {
        const live = body
          .split('\n')
          .slice(1) // the shebang
          .filter((l) => l.trim() && !l.trimStart().startsWith('#'));
        expect(live).toEqual(['set -euo pipefail', 'cd "$FOREMAN_WORKTREE_PATH"']);
      });

      it('names only variables the service really exports', () => {
        for (const name of new Set([...body.matchAll(/FOREMAN_[A-Z_]+/g)].map((m) => m[0]))) {
          expect(EXPORTED).toContain(name);
        }
      });
    });
  }

  it('documents the full set of variables in the setup script', () => {
    // Teardown says "same variables as setup", so setup is the reference.
    for (const name of EXPORTED) expect(SCRIPT_TEMPLATES.setup).toContain(name);
  });
});
