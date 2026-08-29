/** Branch context the panel needs to render its "from" selector. */
export interface NewTaskInit {
  branches: string[];
  baseBranch: string;
}

/** Panel → extension. */
export type NewTaskMessage =
  | { type: 'ready' }
  | { type: 'create'; branch: string; title?: string; description?: string; baseBranch?: string }
  | { type: 'cancel' };

/** Extension → panel. */
export type NewTaskExtMessage = { type: 'init'; init: NewTaskInit };
