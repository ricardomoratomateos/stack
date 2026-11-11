import pkg from '../../../package.json';

/** The settings the desktop app and stackd care about, in display order. */
export const SHOWN = [
  'worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript', 'promptPrefix',
  'defaultProvider', 'claudeCommand', 'codexCommand', 'opencodeCommand', 'sidebarStyle', 'notifyOnAttention',
] as const;

/** The project keys the screen edits (a repo's `.stack/config.json` owns them); the rest of SHOWN is the user's. */
export const PROJECT_KEYS: readonly string[] = ['worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript'];

export type SettingValue = string | boolean;

export interface SettingDef {
  key: string;
  title: string;
  description: string;
  type: 'string' | 'boolean';
  default: SettingValue;
  enum?: string[];
  enumDescriptions?: string[];
  multiline: boolean;
}

interface Prop {
  type?: string; default?: unknown; description?: string; markdownDescription?: string;
  enum?: string[]; enumDescriptions?: string[]; editPresentation?: string;
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
    if (!p || (p.type !== 'string' && p.type !== 'boolean')) continue;
    out.push({
      key,
      title: titleOf(key),
      description: stripMd(p.markdownDescription ?? p.description ?? ''),
      type: p.type,
      default: (p.default as SettingValue | undefined) ?? (p.type === 'boolean' ? false : ''),
      enum: p.enum,
      enumDescriptions: p.enumDescriptions,
      multiline: p.editPresentation === 'multilineText',
    });
  }
  return out;
}

export const DEFS: SettingDef[] = buildDefs((pkg as { contributes: { configuration: { properties: Record<string, Prop> } } }).contributes.configuration.properties);

/** The value in settings.json, accepting the `stack.` spelling too (as stackd does); undefined when unset or of the wrong type. */
export function valueOf(def: SettingDef, file: Record<string, unknown>): SettingValue | undefined {
  const v = file[def.key] ?? file[`stack.${def.key}`];
  return typeof v === def.type ? (v as SettingValue) : undefined;
}

/** Modified = explicitly set to something other than the default. */
export const isModified = (def: SettingDef, value: SettingValue | undefined): boolean => value !== undefined && value !== def.default;

/** `stack.sidebarStyle` from the stack settings file, when set. */
export function sidebarStyleOf(file: Record<string, unknown>): unknown {
  return file.sidebarStyle ?? file['stack.sidebarStyle'];
}

export const PROJECT_DEFS: SettingDef[] = DEFS.filter((d) => PROJECT_KEYS.includes(d.key));
export const USER_DEFS: SettingDef[] = DEFS.filter((d) => !PROJECT_KEYS.includes(d.key));

/** A key in a repo's `.stack/config.json` (unprefixed, unlike settings.json); undefined when unset or of the wrong type. */
export function repoValueOf(def: SettingDef, file: Record<string, unknown>): SettingValue | undefined {
  const v = file[def.key];
  return typeof v === def.type ? (v as SettingValue) : undefined;
}
