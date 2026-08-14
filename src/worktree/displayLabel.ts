/**
 * A worktree's alias is the task title the user typed, which is routinely a whole
 * sentence. Dropped verbatim into UI chrome — a terminal tab, a workspace folder
 * name, a one-line hint — it swallows the whole widget, so every one of those
 * call sites goes through here.
 *
 * Deliberately NOT applied to prose (notifications, tooltips) or to editable
 * values: pre-filling the rename box with a truncated alias would let a save
 * overwrite the real one with the shortened text.
 */

/** Longest label UI chrome carries before it starts dominating its container. */
export const MAX_DISPLAY_LABEL = 32;

interface Labelled {
  alias?: string;
  branch: string;
}

/** Cap a string for display, marking the cut with an ellipsis. */
export function truncateLabel(text: string, max = MAX_DISPLAY_LABEL): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Display label for a worktree: its alias when set, else its branch — capped. */
export function displayLabel(worktree: Labelled, max = MAX_DISPLAY_LABEL): string {
  return truncateLabel(worktree.alias ?? worktree.branch, max);
}
