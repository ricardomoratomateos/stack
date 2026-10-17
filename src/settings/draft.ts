import type { DebugTemplate } from '../types';
import type { ProjectValues, UserValues } from './types';

/**
 * What the settings panel edits, kept apart from the webview so the rules —
 * what is valid, what is dirty, what survives a refresh — are plain functions
 * with tests rather than behaviour you can only check by clicking.
 */

export type SectionId = 'general' | 'appearance' | 'worktrees' | 'scripts' | 'docker' | 'debugging' | 'notifications';

export const SECTION_IDS: SectionId[] = ['general', 'appearance', 'worktrees', 'scripts', 'docker', 'debugging', 'notifications'];

/** Ports are typed as text, so an empty or half-typed box is a state of its own rather than a NaN that is silently dropped. */
export type NumericField = 'basePort' | 'portStride' | 'debugBasePort';

export interface ProjectDraft {
  project: ProjectValues;
  numbers: Record<NumericField, string>;
  /** The Docker switch. Off saves no ports, which is what turns the feature off. */
  dockerOn: boolean;
  /** The launch.json template as text; it only becomes a value when it parses. */
  templateText: string;
}

export function projectDraft(values: ProjectValues): ProjectDraft {
  return {
    project: values,
    numbers: {
      basePort: String(values.docker.basePort),
      portStride: String(values.docker.portStride),
      debugBasePort: String(values.debugBasePort),
    },
    dockerOn: values.docker.ports.length > 0,
    templateText: JSON.stringify(values.debugTemplate, null, 2),
  };
}

/** A whole port number, 1–65535, or nothing. */
export function parsePort(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : undefined;
}

export type TemplateResult = { value: DebugTemplate } | { error: 'json' | 'shape' };

export function parseTemplate(text: string): TemplateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'json' };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['type'] !== 'string' || typeof obj['request'] !== 'string') return { error: 'shape' };
  return { value: obj as DebugTemplate };
}

/**
 * The values this draft would save. A field that does not validate falls back
 * to what it had, but Save is blocked anyway (see `projectErrors`).
 */
export function projectValues(d: ProjectDraft): ProjectValues {
  const template = parseTemplate(d.templateText);
  return {
    ...d.project,
    docker: {
      ...d.project.docker,
      ports: d.dockerOn ? d.project.docker.ports : [],
      basePort: parsePort(d.numbers.basePort) ?? d.project.docker.basePort,
      portStride: parsePort(d.numbers.portStride) ?? d.project.docker.portStride,
    },
    debugBasePort: parsePort(d.numbers.debugBasePort) ?? d.project.debugBasePort,
    debugTemplate: 'value' in template ? template.value : d.project.debugTemplate,
  };
}

export interface ProjectErrors {
  worktreesDirectory?: 'required';
  defaultBaseBranch?: 'required';
  basePort?: 'range';
  portStride?: 'range';
  debugBasePort?: 'range';
  debugTemplate?: 'json' | 'shape';
}

export function projectErrors(d: ProjectDraft): ProjectErrors {
  const errors: ProjectErrors = {};
  if (!d.project.worktreesDirectory.trim()) errors.worktreesDirectory = 'required';
  if (!d.project.defaultBaseBranch.trim()) errors.defaultBaseBranch = 'required';
  // The docker numbers are hidden while the switch is off; an invalid one there must not block saving the rest.
  if (d.dockerOn) {
    if (parsePort(d.numbers.basePort) === undefined) errors.basePort = 'range';
    if (parsePort(d.numbers.portStride) === undefined) errors.portStride = 'range';
  }
  if (parsePort(d.numbers.debugBasePort) === undefined) errors.debugBasePort = 'range';
  const template = parseTemplate(d.templateText);
  if ('error' in template) errors.debugTemplate = template.error;
  return errors;
}

export type CommandKey = 'claudeCommand' | 'codexCommand' | 'opencodeCommand';

export function userErrors(u: UserValues): Partial<Record<CommandKey, 'required'>> {
  const errors: Partial<Record<CommandKey, 'required'>> = {};
  for (const key of ['claudeCommand', 'codexCommand', 'opencodeCommand'] as const) {
    if (!u[key].trim()) errors[key] = 'required';
  }
  return errors;
}

/** Which keys of each scope a section edits — drives the dirty and error dots in the nav. */
export const SECTION_FIELDS: Record<SectionId, { project: (keyof ProjectValues)[]; user: (keyof UserValues)[] }> = {
  general: { project: [], user: ['defaultProvider', 'claudeCommand', 'codexCommand', 'opencodeCommand'] },
  appearance: { project: [], user: ['sidebarStyle', 'sessionTabs'] },
  worktrees: { project: ['worktreesDirectory', 'defaultBaseBranch'], user: ['focusMode', 'scopeSearchToActiveWorktree'] },
  scripts: { project: ['setupScript', 'setupInTerminal', 'teardownScript'], user: [] },
  docker: { project: ['docker'], user: [] },
  debugging: { project: ['debugBasePort', 'debugTemplate'], user: [] },
  notifications: { project: [], user: ['notifyOnAttention'] },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function projectDirty(d: ProjectDraft, saved: ProjectValues): boolean {
  return !same(projectValues(d), saved);
}

export function userDirty(u: UserValues, saved: UserValues): boolean {
  return !same(u, saved);
}

/** Sections holding an edit that is not saved yet. */
export function dirtySections(d: ProjectDraft, u: UserValues, savedProject: ProjectValues, savedUser: UserValues): SectionId[] {
  const values = projectValues(d);
  return SECTION_IDS.filter((id) => {
    const f = SECTION_FIELDS[id];
    return f.project.some((k) => !same(values[k], savedProject[k])) || f.user.some((k) => !same(u[k], savedUser[k]));
  });
}

/** Sections with a field that blocks Save. */
export function errorSections(d: ProjectDraft, u: UserValues): SectionId[] {
  const pe = projectErrors(d);
  const ue = userErrors(u);
  const bad = new Set<string>([
    ...(pe.worktreesDirectory ? ['worktreesDirectory'] : []),
    ...(pe.defaultBaseBranch ? ['defaultBaseBranch'] : []),
    ...(pe.basePort || pe.portStride ? ['docker'] : []),
    ...(pe.debugBasePort || pe.debugTemplate ? ['debugBasePort'] : []),
    ...Object.keys(ue),
  ]);
  return SECTION_IDS.filter((id) => {
    const f = SECTION_FIELDS[id];
    return [...f.project, ...f.user].some((k) => bad.has(k));
  });
}

/**
 * A fresh snapshot arrives after every save, from either scope. A scope the
 * person has not touched adopts it; one they are in the middle of editing keeps
 * its draft — saving "Just me" must never wipe unsaved repository edits, nor
 * the other way round.
 */
export function reconcileProject(prev: ProjectValues, draft: ProjectDraft, next: ProjectValues): ProjectDraft {
  return same(draft, projectDraft(prev)) ? projectDraft(next) : draft;
}

export function reconcileUser(prev: UserValues, draft: UserValues, next: UserValues): UserValues {
  return same(draft, prev) ? next : draft;
}

/**
 * The top-level key a problem from the repo file is about. Problems read like
 * `"docker.basePort" must be a whole number…` or `unknown key "docker.foo"`.
 */
export function problemKey(problem: string): string | undefined {
  const quoted = /"([^"]+)"/.exec(problem);
  return quoted?.[1]?.split('.')[0];
}
