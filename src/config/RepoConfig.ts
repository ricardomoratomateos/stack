import * as fs from 'node:fs';
import * as path from 'node:path';
import { StackConfig, DockerConfig, DebugTemplate } from '../types';

/** Where a repository declares how Stack should treat it. */
export const REPO_CONFIG_RELATIVE = path.join('.stack', 'config.json');

/**
 * Where it lived when the extension was called Foreman. Still read — only
 * when there is no `.stack/config.json` — so a repository that committed one
 * keeps working for everyone, whether they have upgraded yet or not.
 */
export const LEGACY_REPO_CONFIG_RELATIVE = path.join('.foreman', 'config.json');

/**
 * The repo config this repository uses, relative to its root: `.stack/config.json`
 * when it exists, else a legacy `.foreman/config.json` that does, else
 * `.stack/config.json` — which is where a new one is written.
 */
export function repoConfigRelative(
  repoRoot: string,
  exists: (file: string) => boolean = fs.existsSync,
): string {
  if (exists(path.join(repoRoot, REPO_CONFIG_RELATIVE))) return REPO_CONFIG_RELATIVE;
  if (exists(path.join(repoRoot, LEGACY_REPO_CONFIG_RELATIVE))) return LEGACY_REPO_CONFIG_RELATIVE;
  return REPO_CONFIG_RELATIVE;
}

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
 * compose files exist, which branch work starts from, what the setup script is
 * called — those are facts about the project, identical for everyone who clones
 * it, and until now every one of them lived in one person's settings.json. A
 * new teammate cloned the repo and got an extension that did nothing useful
 * until they were handed a paste of somebody else's config.
 *
 * Deliberately absent: defaultProvider, the per-agent commands, notifyOnAttention,
 * focusMode, scopeSearchToActiveWorktree, sessionTabs. Which agent you reach for and where
 * its binary lives are properties of your machine, and a cloned repository has
 * no business overriding them.
 */
export type RepoScopedKey =
  | 'worktreesDirectory'
  | 'defaultBaseBranch'
  | 'setupScript'
  | 'setupInTerminal'
  | 'teardownScript'
  | 'docker'
  | 'debugBasePort'
  | 'debugTemplate';

export type RepoConfigValues = Partial<Pick<StackConfig, RepoScopedKey>>;

export type RepoConfigResult = {
  /** Recognised, correctly typed values. Empty when there is no file. */
  values: RepoConfigValues;
  /** True when a file exists, even if nothing in it was usable. */
  present: boolean;
  /** Set when what was read is the legacy `.foreman/config.json` (see LEGACY_REPO_CONFIG_RELATIVE). */
  legacy?: true;
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
  setupInTerminal: asBoolean,
  teardownScript: asString,
  docker: asDocker,
  debugBasePort: asPositiveInt,
  debugTemplate: asDebugTemplate,
};

/** Keys that exist in StackConfig but are the user's, not the repository's. */
const USER_SCOPED = new Set([
  'defaultProvider',
  'claudeCommand',
  'codexCommand',
  'opencodeCommand',
  'notifyOnAttention',
  'focusMode',
  'scopeSearchToActiveWorktree',
  'sessionTabs',
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
 * Reads and validates `<repoRoot>/.stack/config.json` — or, when the
 * repository has none, the legacy `.foreman/config.json`. Never throws.
 */
export function readRepoConfig(
  repoRoot: string | undefined,
  io: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): RepoConfigResult {
  if (!repoRoot) return EMPTY;
  const relative = repoConfigRelative(repoRoot, (f) => io.existsSync(f));
  const file = path.join(repoRoot, relative);
  if (!io.existsSync(file)) return EMPTY;
  const found = relative === LEGACY_REPO_CONFIG_RELATIVE ? { present: true as const, legacy: true as const } : { present: true as const };

  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFileSync(file, 'utf8') as string);
  } catch (e) {
    // A syntax error is worth saying out loud. Falling back silently looks
    // exactly like the file being ignored, which is the confusing failure.
    return { values: {}, ...found, problems: [`${relative} is not valid JSON: ${(e as Error).message}`] };
  }

  const problems: string[] = [];
  if (!isPlainObject(parsed)) {
    return { values: {}, ...found, problems: [`${relative} must contain a JSON object`] };
  }

  const version = parsed['version'];
  if (version !== undefined) {
    if (typeof version !== 'number') problems.push(`"version" must be a number, got ${describe(version)}`);
    else if (version > REPO_CONFIG_VERSION) {
      problems.push(
        `${relative} declares version ${version}; this Stack understands ${REPO_CONFIG_VERSION}. ` +
        'Reading the keys it recognises — update Stack if something looks wrong.',
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

  return { values, ...found, problems };
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
    docker: effective.docker,
    debugBasePort: effective.debugBasePort,
    debugTemplate: effective.debugTemplate,
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
 * than it is. So: every existing key survives, in its place; docker is merged
 * key by key for the same reason; the version only ever goes up.
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
    body[key] = key === 'docker' && isPlainObject(current['docker'])
      ? { ...current['docker'], ...(value as object) }
      : value;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}
