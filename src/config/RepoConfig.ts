import * as fs from 'node:fs';
import * as path from 'node:path';
import { UnmessConfig, DockerConfig, DebugTemplate } from '../types';

/** Where a repository declares how Unmess should treat it. */
export const REPO_CONFIG_RELATIVE = path.join('.unmess', 'config.json');

/**
 * The schema version this build writes and understands.
 *
 * A file from the future is read anyway, on the assumption that new keys are
 * additive and the ones we recognise still mean what they meant. It reports the
 * mismatch rather than refusing: a teammate on a newer Unmess bumping the
 * version must not stop the repo working for everyone still on this one.
 */
export const REPO_CONFIG_VERSION = 1;

/**
 * The settings a repository gets to decide, as opposed to the ones belonging to
 * whoever is sitting in front of it.
 *
 * The split is the whole point of the file. Where the worktrees go, which
 * compose files exist, which branch work starts from, what the setup script is
 * called — those are facts about the project, identical for everyone who clones
 * it, and until now every one of them lived in one person's settings.json. A
 * new teammate cloned the repo and got an extension that did nothing useful
 * until they were handed a paste of somebody else's config.
 *
 * Deliberately absent: defaultProvider, the per-agent commands, notifyOnAttention,
 * focusMode, scopeSearchToActiveWorktree. Which agent you reach for and where
 * its binary lives are properties of your machine, and a cloned repository has
 * no business overriding them.
 */
export type RepoScopedKey =
  | 'worktreesDirectory'
  | 'defaultBaseBranch'
  | 'setupScript'
  | 'teardownScript'
  | 'docker'
  | 'debugBasePort'
  | 'debugTemplate';

export type RepoConfigValues = Partial<Pick<UnmessConfig, RepoScopedKey>>;

export type RepoConfigResult = {
  /** Recognised, correctly typed values. Empty when there is no file. */
  values: RepoConfigValues;
  /** True when a file exists, even if nothing in it was usable. */
  present: boolean;
  /**
   * Human-readable complaints, in file order. Never thrown: a broken repo config
   * must degrade to the user's own settings, not break the extension. They are
   * surfaced once per change so a typo is not silently ignored forever.
   */
  problems: string[];
};

const EMPTY: RepoConfigResult = { values: {}, present: false, problems: [] };

type Validator = (raw: unknown, problems: string[], key: string) => unknown;

const asString: Validator = (raw, problems, key) => {
  if (typeof raw === 'string') return raw;
  problems.push(`"${key}" must be a string, got ${describe(raw)}`);
  return undefined;
};

const asPositiveInt: Validator = (raw, problems, key) => {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 65535) return raw;
  problems.push(`"${key}" must be a whole number between 1 and 65535, got ${describe(raw)}`);
  return undefined;
};

const asStringArray: Validator = (raw, problems, key) => {
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
  problems.push(`"${key}" must be an array of strings, got ${describe(raw)}`);
  return undefined;
};

const asObject: Validator = (raw, problems, key) => {
  if (isPlainObject(raw)) return raw;
  problems.push(`"${key}" must be an object, got ${describe(raw)}`);
  return undefined;
};

/**
 * Only the docker keys we know, each validated on its own.
 *
 * Partial on purpose: a repo that only needs to name its compose file should
 * not have to restate basePort and portStride to avoid resetting them.
 */
const dockerValidators: Record<keyof DockerConfig, Validator> = {
  composeFile: asString,
  overrideFile: asString,
  ports: asStringArray,
  basePort: asPositiveInt,
  portStride: asPositiveInt,
};

const asDocker: Validator = (raw, problems, key) => {
  if (!isPlainObject(raw)) {
    problems.push(`"${key}" must be an object, got ${describe(raw)}`);
    return undefined;
  }
  const out: Partial<DockerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const validate = dockerValidators[name as keyof DockerConfig];
    if (!validate) {
      problems.push(`unknown key "${key}.${name}"`);
      continue;
    }
    const clean = validate(value, problems, `${key}.${name}`);
    if (clean !== undefined) (out as Record<string, unknown>)[name] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const asDebugTemplate: Validator = (raw, problems, key) => {
  const obj = asObject(raw, problems, key);
  if (!obj) return undefined;
  // Passed through beyond the required shape: a launch configuration carries
  // arbitrary debugger-specific keys and we are not the authority on them.
  const t = obj as Record<string, unknown>;
  if (typeof t['type'] !== 'string' || typeof t['request'] !== 'string') {
    problems.push(`"${key}" needs at least a string "type" and "request"`);
    return undefined;
  }
  return t as unknown as DebugTemplate;
};

const validators: Record<RepoScopedKey, Validator> = {
  worktreesDirectory: asString,
  defaultBaseBranch: asString,
  setupScript: asString,
  teardownScript: asString,
  docker: asDocker,
  debugBasePort: asPositiveInt,
  debugTemplate: asDebugTemplate,
};

/** Keys that exist in UnmessConfig but are the user's, not the repository's. */
const USER_SCOPED = new Set([
  'defaultProvider',
  'claudeCommand',
  'codexCommand',
  'grokCommand',
  'opencodeCommand',
  'notifyOnAttention',
  'focusMode',
  'scopeSearchToActiveWorktree',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/** Reads and validates `<repoRoot>/.unmess/config.json`. Never throws. */
export function readRepoConfig(
  repoRoot: string | undefined,
  io: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): RepoConfigResult {
  if (!repoRoot) return EMPTY;
  const file = path.join(repoRoot, REPO_CONFIG_RELATIVE);
  if (!io.existsSync(file)) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFileSync(file, 'utf8') as string);
  } catch (e) {
    // A syntax error is worth saying out loud. Falling back silently looks
    // exactly like the file being ignored, which is the confusing failure.
    return { values: {}, present: true, problems: [`${REPO_CONFIG_RELATIVE} is not valid JSON: ${(e as Error).message}`] };
  }

  const problems: string[] = [];
  if (!isPlainObject(parsed)) {
    return { values: {}, present: true, problems: [`${REPO_CONFIG_RELATIVE} must contain a JSON object`] };
  }

  const version = parsed['version'];
  if (version !== undefined) {
    if (typeof version !== 'number') problems.push(`"version" must be a number, got ${describe(version)}`);
    else if (version > REPO_CONFIG_VERSION) {
      problems.push(
        `${REPO_CONFIG_RELATIVE} declares version ${version}; this Unmess understands ${REPO_CONFIG_VERSION}. ` +
        'Reading the keys it recognises — update Unmess if something looks wrong.',
      );
    }
  }

  const values: RepoConfigValues = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (key === 'version' || key === '$schema') continue;
    if (USER_SCOPED.has(key)) {
      problems.push(`"${key}" is a per-user setting and is ignored here — it belongs in your own VS Code settings`);
      continue;
    }
    const validate = validators[key as RepoScopedKey];
    if (!validate) {
      problems.push(`unknown key "${key}"`);
      continue;
    }
    const clean = validate(raw, problems, key);
    if (clean !== undefined) (values as Record<string, unknown>)[key] = clean;
  }

  return { values, present: true, problems };
}

/**
 * The starter file, built from what is currently in effect.
 *
 * This is the migration path, and the reason it renders current values rather
 * than blank defaults: the person creating the file is the person who already
 * has a working setup in their own settings.json, and the useful thing is to
 * lift it into the repository verbatim so everyone else inherits it.
 */
export function renderRepoConfig(effective: UnmessConfig): string {
  const body: Record<string, unknown> = {
    version: REPO_CONFIG_VERSION,
    worktreesDirectory: effective.worktreesDirectory,
    defaultBaseBranch: effective.defaultBaseBranch,
    setupScript: effective.setupScript,
    teardownScript: effective.teardownScript,
    docker: effective.docker,
    debugBasePort: effective.debugBasePort,
    debugTemplate: effective.debugTemplate,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
