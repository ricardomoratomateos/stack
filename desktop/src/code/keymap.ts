/**
 * The Code tab's keys: PhpStorm's (macOS keymap), so hands that know it need not relearn anything. VS Code's
 * ⌘P / ⌘T / ⌃- are kept too. Read-only, so only reading and navigating keys exist.
 */

/** What a key does anywhere in the Code tab (tree, bar or editor). */
export type CodeAction =
  | 'go-to-file' | 'go-to-symbol' | 'find-in-path' | 'find-in-file' | 'recent-files' | 'back' | 'forward';

/** Monaco commands for PhpStorm's keys while the editor has focus (bound in the editor, so its own peeks keep theirs). */
export const EDITOR_KEYS: ReadonlyArray<{ keys: string; label: string; command: string }> = [
  { keys: '⌘B', label: 'Go to declaration', command: 'editor.action.revealDefinition' },
  { keys: '⌘Y', label: 'Quick definition', command: 'editor.action.peekDefinition' },
  { keys: '⌥F7', label: 'Find usages', command: 'editor.action.goToReferences' },
  { keys: '⌥⌘F7', label: 'Show usages', command: 'editor.action.referenceSearch.trigger' },
  { keys: 'F1', label: 'Quick documentation', command: 'editor.action.showHover' },
  { keys: '⌃J', label: 'Quick documentation', command: 'editor.action.showHover' },
  { keys: '⌘L', label: 'Go to line', command: 'editor.action.gotoLine' },
  { keys: '⌘F12', label: 'File structure', command: 'editor.action.quickOutline' },
  { keys: '⌥↑', label: 'Extend selection', command: 'editor.action.smartSelect.expand' },
  { keys: '⌥↓', label: 'Shrink selection', command: 'editor.action.smartSelect.shrink' },
  { keys: 'F2', label: 'Next problem', command: 'editor.action.marker.next' },
  { keys: '⇧F2', label: 'Previous problem', command: 'editor.action.marker.prev' },
];

export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** The Code tab's own action for a key, if it is one (PhpStorm's, then VS Code's). */
export function codeActionOf(e: KeyLike): CodeAction | null {
  const { metaKey: cmd, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  if (cmd && !ctrl) {
    if (e.code === 'KeyO') return shift && !alt ? 'go-to-file' : 'go-to-symbol'; // ⇧⌘O file · ⌘O class · ⌥⌘O symbol
    if (e.code === 'KeyF' && shift && !alt) return 'find-in-path';
    if (e.code === 'KeyF' && !shift && !alt) return 'find-in-file';
    if (e.code === 'KeyE' && !shift && !alt) return 'recent-files';
    if (e.code === 'BracketLeft' && !shift && !alt) return 'back';
    if (e.code === 'BracketRight' && !shift && !alt) return 'forward';
    if (e.code === 'KeyP' && !shift && !alt) return 'go-to-file';
    if (e.code === 'KeyT' && !alt) return 'go-to-symbol';
  }
  if (ctrl && !cmd && !alt && (e.key === '-' || e.key === '_')) return e.shiftKey || e.key === '_' ? 'forward' : 'back';
  return null;
}

/**
 * ⇧⇧ (Search Everywhere): two Shift presses, each alone, the second within `ms` of the first. Feed it every
 * keydown and keyup; it answers true on the keyup that completes the pair.
 */
export function doubleShift(ms = 350) {
  let lastUp = -Infinity;
  let clean = false;
  return (e: { type: string; key: string; repeat?: boolean }, now: number): boolean => {
    if (e.key !== 'Shift') { clean = false; lastUp = -Infinity; return false; }
    if (e.type === 'keydown') { if (!e.repeat) clean = true; return false; }
    if (e.type !== 'keyup' || !clean) return false;
    clean = false;
    if (now - lastUp <= ms) { lastUp = -Infinity; return true; }
    lastUp = now;
    return false;
  };
}
