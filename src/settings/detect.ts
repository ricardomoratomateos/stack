import * as path from 'node:path';
import type { Detection, Stack } from './types';

/** The few filesystem calls detection needs, so it can run on a fake in tests. */
export interface DetectIo {
  readdir(dir: string): string[];
  exists(p: string): boolean;
  read(p: string): string;
}

const COMPOSE_FILE = /^(docker-)?compose(\..+)?\.ya?ml$/i;
// `${HTTP_PORT}`, `${HTTP_PORT:-8080}`, `${HTTP_PORT-8080}` and bare `$HTTP_PORT`.
const ENV_VAR = /\$\{?([A-Z][A-Z0-9_]*)(?:[:-][^}\s]*)?\}?/g;

const SETUP_CANDIDATES = ['.foreman/setup.sh', 'scripts/setup.sh', 'setup.sh'];
const TEARDOWN_CANDIDATES = ['.foreman/teardown.sh', 'scripts/teardown.sh', 'teardown.sh'];

/**
 * What the repository already tells us, so the settings panel can lead with
 * "we found docker-compose.yml with HTTP_PORT and DB_PORT — use these?" instead
 * of a blank form and a README. Pure: every lookup goes through `io`.
 */
export function detect(repoRoot: string, io: DetectIo): Detection {
  let entries: string[] = [];
  try { entries = io.readdir(repoRoot); } catch { entries = []; }

  // Base files first: `docker-compose.yml` is the compose file, and
  // `docker-compose.worktree.yml` the override the settings expect on top.
  const composeFiles = entries
    .filter((f) => COMPOSE_FILE.test(f))
    .sort((a, b) => Number(hasQualifier(a)) - Number(hasQualifier(b)) || a.localeCompare(b));

  const portVars = new Set<string>();
  for (const file of composeFiles) {
    let text: string;
    try { text = io.read(path.join(repoRoot, file)); } catch { continue; }
    for (const match of text.matchAll(ENV_VAR)) {
      if (match[1].includes('PORT')) portVars.add(match[1]);
    }
  }

  const has = (rel: string) => io.exists(path.join(repoRoot, rel));
  // PHP before Node: a Laravel repo carries a package.json for its assets, and
  // the debugger people want in it is Xdebug.
  const stack: Stack | undefined = has('composer.json')
    ? 'php'
    : has('package.json')
    ? 'node'
    : has('pyproject.toml') || has('requirements.txt')
    ? 'python'
    : has('go.mod')
    ? 'go'
    : undefined;

  return {
    composeFiles,
    portVars: [...portVars],
    stack,
    setupScript: SETUP_CANDIDATES.find(has),
    teardownScript: TEARDOWN_CANDIDATES.find(has),
  };
}

/** `docker-compose.worktree.yml` has one; `docker-compose.yml` does not. */
function hasQualifier(file: string): boolean {
  return /^(docker-)?compose\..+\.ya?ml$/i.test(file);
}
