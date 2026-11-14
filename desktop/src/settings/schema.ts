// The settings' titles, descriptions, defaults and choices. They used to be read from the VS Code
// extension's `contributes.configuration` in the root package.json; the extension is gone, so
// they live here now.
import schema from './settings.json';

/** The settings the desktop app and stackd care about, in display order. */
export const SHOWN = [
  'worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript', 'promptPrefix',
  'defaultProvider', 'claudeCommand', 'opencodeCommand', 'notifyOnAttention',
  // The Code tab
  'phpNavigation', 'phpIndexDirs', 'phpExcludeDirs', 'phpExtensions', 'phpAutoloader', 'phpBaseBranch', 'phpMaxChangedFiles',
  'scriptExcludeDirs', 'oxlintConfig', 'phpBaseOnStart', 'codeIdleMinutes', 'phpactorPath', 'oxlintPath', 'phpPath',
] as const;

/** The project keys the screen edits (a repo's `.stack/config.json` owns them); the rest of SHOWN is the user's. */
export const PROJECT_KEYS: readonly string[] = [
  'worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript',
  'phpNavigation', 'phpIndexDirs', 'phpExcludeDirs', 'phpExtensions', 'phpAutoloader', 'phpBaseBranch', 'phpMaxChangedFiles',
  'scriptExcludeDirs', 'oxlintConfig',
];

export type SettingValue = string | boolean | number | string[];
export type SettingType = 'string' | 'boolean' | 'number' | 'array';
const TYPES: readonly string[] = ['string', 'boolean', 'number', 'array'];

export interface SettingDef {
  key: string;
  title: string;
  description: string;
  type: SettingType;
  default: SettingValue;
  /** A heading the row goes under ("Code"); none = the general settings at the top. */
  group?: string;
  enum?: string[];
  enumDescriptions?: string[];
  multiline: boolean;
}

interface Prop {
  type?: string; default?: unknown; description?: string; markdownDescription?: string;
  enum?: string[]; enumDescriptions?: string[]; editPresentation?: string; group?: string;
}

/** `workTreesDirectory` -> `Worktrees Directory` (VS Code's title rule). */
export function titleOf(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

const stripMd = (t: string) => t.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

export function buildDefs(props: Record<string, Prop>): SettingDef[] {
  const out: SettingDef[] = [];
  for (const key of SHOWN) {
    const p = props[`stack.${key}`];
    if (!p || !p.type || !TYPES.includes(p.type)) continue;
    const type = p.type as SettingType;
    out.push({
      key,
      title: titleOf(key),
      description: stripMd(p.markdownDescription ?? p.description ?? ''),
      type,
      default: (p.default as SettingValue | undefined) ?? EMPTY[type],
      group: p.group,
      enum: p.enum,
      enumDescriptions: p.enumDescriptions,
      multiline: p.editPresentation === 'multilineText',
    });
  }
  return out;
}

const EMPTY: Record<SettingType, SettingValue> = { string: '', boolean: false, number: 0, array: [] };

/** Whether `v` is a value of `type` (a list is a list of strings). */
export function isOfType(type: SettingType, v: unknown): v is SettingValue {
  if (type === 'array') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === type;
}

/** A list as typed in one line: `lib, www , src` -> ['lib', 'www', 'src']. */
export const parseList = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean);
export const formatValue = (v: SettingValue): string => (Array.isArray(v) ? v.join(', ') : String(v));
export const sameValue = (a: SettingValue | undefined, b: SettingValue | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

export const DEFS: SettingDef[] = buildDefs((schema as { properties: Record<string, Prop> }).properties);

/** The value in settings.json, accepting the `stack.` spelling too (as stackd does); undefined when unset or of the wrong type. */
export function valueOf(def: SettingDef, file: Record<string, unknown>): SettingValue | undefined {
  const v = file[def.key] ?? file[`stack.${def.key}`];
  return isOfType(def.type, v) ? v : undefined;
}

/** Modified = explicitly set to something other than the default. */
export const isModified = (def: SettingDef, value: SettingValue | undefined): boolean => value !== undefined && !sameValue(value, def.default);

export const PROJECT_DEFS: SettingDef[] = DEFS.filter((d) => PROJECT_KEYS.includes(d.key));
export const USER_DEFS: SettingDef[] = DEFS.filter((d) => !PROJECT_KEYS.includes(d.key));

/** A key in a repo's `.stack/config.json` (unprefixed, unlike settings.json); undefined when unset or of the wrong type. */
export function repoValueOf(def: SettingDef, file: Record<string, unknown>): SettingValue | undefined {
  const v = file[def.key];
  return isOfType(def.type, v) ? v : undefined;
}
