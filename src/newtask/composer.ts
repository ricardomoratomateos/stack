import type { ProviderId } from '../ports/IAgentProvider';

/**
 * The composer's pure rules — branch naming, key handling, filtering — kept out
 * of the React file so they are tested without a DOM.
 */

/** A pasted paragraph must not become a path-length branch name. */
const MAX_SLUG = 50;

/** Branch name derived from a description: lowercase words joined by dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, MAX_SLUG)
    // The cut can land right after a dash, and git is fine with that but a
    // branch ending in "-" reads like a typo.
    .replace(/-+$/, '');
}

/**
 * Why a typed branch name would be refused, or undefined when git would take
 * it. A subset of `git check-ref-format`, enough to catch what people type
 * (spaces, `..`, a leading dash) before `git worktree add` fails with a message
 * about refs. Slugs from the description are always valid; this is for names
 * the user edited in.
 */
export function validateBranchName(name: string): string | undefined {
  if (!name) return undefined;
  if (/\s/.test(name)) return "Branch names can't contain spaces.";
  if (name.startsWith('-')) return "Branch names can't start with a dash.";
  if (name.includes('..')) return "Branch names can't contain '..'.";
  const bad = /[~^:?*[\\\u0000-\u001f\u007f]|@\{/.exec(name);
  if (bad) return `Branch names can't contain '${bad[0]}'.`;
  if (name === '@') return "'@' is not a valid branch name.";
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'Slashes must separate names.';
  if (name.endsWith('.')) return "Branch names can't end with a dot.";
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return "A part of the name can't start with '.' or end with '.lock'.";
  }
  return undefined;
}

export interface ResolvedBranch {
  /** The name that would be created; empty when nothing yields one yet. */
  name: string;
  /** True when the name comes from the description rather than from the user. */
  auto: boolean;
  error?: string;
}

/** A name the user typed wins; otherwise it follows the description live. */
export function resolveBranch(manual: string | null, description: string): ResolvedBranch {
  const typed = manual?.trim();
  if (typed) return { name: typed, auto: false, error: validateBranchName(typed) };
  return { name: slugify(description), auto: true };
}

/** Display names; the lowercase `label` in the sidebar's provider table is a command, not a name. */
const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'opencode',
};

export function providerName(id: ProviderId): string {
  return PROVIDER_NAMES[id];
}

/** Branches matching a search, names that start with the query before those that merely contain it. */
export function filterBranches(branches: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...branches];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const b of branches) {
    const at = b.toLowerCase().indexOf(q);
    if (at === 0) starts.push(b);
    else if (at > 0) contains.push(b);
  }
  return [...starts, ...contains];
}

/** The submit shortcut as the tooltip and hint should name it. */
export function submitShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘↵' : 'Ctrl+Enter';
}

/** The slice of KeyboardEvent the key rules read, so they can be tested without one. */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * An IME confirms a candidate with Enter and dismisses it with Esc, and those
 * keys belong to the IME. Browsers flag it with isComposing; Safari-family
 * engines fire the closing keydown after composition ended and only report
 * keyCode 229.
 */
export function isComposing(e: KeyLike): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

export function isSubmitKey(e: KeyLike): boolean {
  return e.key === 'Enter' && !!(e.metaKey || e.ctrlKey) && !isComposing(e);
}

export function isCancelKey(e: KeyLike): boolean {
  return e.key === 'Escape' && !isComposing(e);
}
