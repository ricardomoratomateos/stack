import type { DiffBase } from '../ports/IGitPort';

export type { DiffBase };

/** Where a review comment lands when the user hits "Send". */
export type SendDestination = 'live' | 'new' | 'clipboard';

/** A single line comment captured on the diff. */
export interface DiffComment {
  /** File path as it appears in the diff (new path, or old path for deletions). */
  file: string;
  /** Which side of a side-by-side row the comment is anchored to. */
  side: 'old' | 'new';
  /** 1-based line number on that side, when known. */
  line?: number;
  /** The code text of the commented line (context for the agent). */
  code?: string;
  /** The reviewer's note. */
  body: string;
}

// ── Panel webview → extension ────────────────────────────────────────────────
export type DiffPanelMessage =
  | { type: 'ready' }
  | { type: 'requestDiff'; base: DiffBase }
  | { type: 'send'; destination: SendDestination; comments: DiffComment[] }
  | { type: 'openFile'; path: string; line?: number };

// ── Extension → panel webview ────────────────────────────────────────────────
export type DiffPanelExtMessage =
  | { type: 'diff'; base: DiffBase; unified: string; hasLiveAgent: boolean; label: string }
  | { type: 'sent'; destination: SendDestination; ok: boolean }
  | { type: 'error'; message: string };
