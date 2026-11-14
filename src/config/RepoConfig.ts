import * as fs from 'node:fs';
import * as path from 'node:path';
import { StackConfig } from '../types';

/** Where a repository declares how Stack should treat it. */
export const REPO_CONFIG_RELATIVE = path.join('.stack', 'config.json');

/**
 * The schema version this build writes and understands.
 *
 * A file from the future is read anyway, on the assumption that new keys are
 * additive and the ones we recognise still mean what they meant. It reports the
 * mismatch rather than refusing: a teammate on a newer Stack bumping the
 * version must not stop the repo working for everyone still on this one.
 */
export const REPO_CONFIG_VERSION = 1;

/**
 * The settings a repository gets to decide, as opposed to the ones belonging to
 * whoever is sitting in front of it.
 *
 * The split is the whole point of the file. Where the worktrees go, which
 * branch work starts from, what the setup script is called — those are facts about the project, identical for everyone who clones
 * it, and until now every one of them lived in one person's settings.json. A
 * new teammate cloned the repo and got an extension that did nothing useful
 * until they were handed a paste of somebody else's config.
 *
 * Deliberately absent: defaultProvider, the per-agent commands, notifyOnAttention,
 * focusMode, sessionTabs. Which agent you reach for and where
 * its binary lives are properties of your machine, and a cloned repository has
 * no business overriding them.
 */
export type RepoScopedKey =
  | 'worktreesDirectory'
  | 'defaultBaseBranch'
  | 'setupScript'
  | 'setupInTerminal'
  | 'teardownScript'
  | 'phpNavigation'
  | 'phpIndexDirs'
  | 'phpExcludeDirs'
  | 'phpExtensions'
  | 'phpAutoloader'
  | 'phpBaseBranch'
  | 'phpMaxChangedFiles'
  | 'phpactorOptions'
  | 'scriptExcludeDirs'
  | 'oxlintConfig';

export type RepoConfigValues = Partial<Pick<StackConfig, RepoScopedKey>>;

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

const asBoolean: Validator = (raw, problems, key) => {
  if (typeof raw === 'boolean') return raw;
  problems.push(`"${key}" must be true or false, got ${describe(raw)}`);
  return undefined;
};

const asStringArray: Validator = (raw, problems, key) => {
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
  problems.push(`"${key}" must be an array of strings, got ${describe(raw)}`);
  return undefined;
};

const asCount: Validator = (raw, problems, key) => {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  problems.push(`"${key}" must be a whole number, got ${describe(raw)}`);
  return undefined;
};

const asObject: Validator = (raw, problems, key) => {
  if (isPlainObject(raw)) return raw;
  problems.push(`"${key}" must be an object, got ${describe(raw)}`);
  return undefined;
};

const validators: Record<RepoScopedKey, Validator> = {
  worktreesDirectory: asString,
  defaultBaseBranch: asString,
  setupScript: asString,
  setupInTerminal: asBoolean,
  teardownScript: asString,
  phpNavigation: asBoolean,
  phpIndexDirs: asStringArray,
  phpExcludeDirs: asStringArray,
  phpExtensions: asStringArray,
  phpAutoloader: asString,
  phpBaseBranch: asString,
  phpMaxChangedFiles: asCount,
  phpactorOptions: asObject,
  scriptExcludeDirs: asStringArray,
  oxlintConfig: asString,
};

/**
 * Keys an older Stack understood and this one does not: skipped without a
 * complaint, since the file is shared with teammates who may still be on it.
 * `docker` is the old compose integration; the per-worktree ports (`ports`,
 * `basePort`, `portStride`), the debug port and its launch.json template, and
 * search scoping went the same way.
 */
const RETIRED = new Set([
  'docker',
  'ports',
  'basePort',
  'portStride',
  'debugBasePort',
  'debugTemplate',
  'scopeSearchToActiveWorktree',
]);

/** Keys that exist in StackConfig but are the user's, not the repository's. */
const USER_SCOPED = new Set([
  'defaultProvider',
  'claudeCommand',
  'opencodeCommand',
  'notifyOnAttention',
  'focusMode',
  'sessionTabs',
  'phpBaseOnStart',
  'codeIdleMinutes',
  'phpactorPath',
  'oxlintPath',
  'phpPath',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * Reads and validates `<repoRoot>/.stack/config.json`. Never throws.
 */
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
        `${REPO_CONFIG_RELATIVE} declares version ${version}; this Stack understands ${REPO_CONFIG_VERSION}. ` +
        'Reading the keys it recognises — update Stack if something looks wrong.',
      );
    }
  }

  const values: RepoConfigValues = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (key === 'version' || key === '$schema' || RETIRED.has(key)) continue;
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
export function renderRepoConfig(effective: StackConfig): string {
  return updateRepoConfig(undefined, {
    worktreesDirectory: effective.worktreesDirectory,
    defaultBaseBranch: effective.defaultBaseBranch,
    setupScript: effective.setupScript,
    setupInTerminal: effective.setupInTerminal,
    teardownScript: effective.teardownScript,
  });
}

/**
 * The file's new text after writing `values` into what is already there.
 *
 * An update, not a re-render. The file is shared and outlives any one build
 * of Stack, and re-rendering it from the keys this build knows did two
 * quiet kinds of damage on every save from the settings panel: a key added by
 * a newer Stack (or one this build reports as unknown) vanished, and
 * `version` went back to 1 — telling every newer Stack the file is older
 * than it is. So: every existing key survives, in its place; the version only
 * ever goes up.
 *
 * A file that is not a JSON object cannot be updated, only replaced — which
 * is what the panel offers for it ("save from here to overwrite it").
 */
export function updateRepoConfig(existing: string | undefined, values: RepoConfigValues): string {
  let current: Record<string, unknown> = {};
  if (existing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isPlainObject(parsed)) current = parsed;
    } catch { /* unreadable: replaced, as the panel says it will be */ }
  }

  const theirs = current['version'];
  const version = typeof theirs === 'number' && theirs > REPO_CONFIG_VERSION ? theirs : REPO_CONFIG_VERSION;

  // version first for a new file; an existing one keeps its own key order.
  const body: Record<string, unknown> = { version, ...current };
  body['version'] = version;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    body[key] = value;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}
