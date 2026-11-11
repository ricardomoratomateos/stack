export interface PaneInfo {
  id: string;
  /** The tmux session the pane belongs to. */
  session: string;
  window: string;
  window_index: number;
  window_name: string;
  cols: number;
  rows: number;
  active: boolean;
  command: string;
}

export interface PaneDiff {
  added: string[];
  removed: string[];
}

/** Bookkeeping of known panes (of every connected session) and which of them are visible. */
export class PaneBook {
  private panes = new Map<string, PaneInfo>();
  private visibleIds = new Set<string>();

  /** Replace the panes of one session; reports what appeared and disappeared in it. */
  update(session: string, list: PaneInfo[]): PaneDiff {
    const mine = [...this.panes.values()].filter((p) => p.session === session);
    const nextIds = new Set(list.map((p) => p.id));
    const added = list.filter((p) => !this.panes.has(p.id)).map((p) => p.id);
    const removed = mine.filter((p) => !nextIds.has(p.id)).map((p) => p.id);
    for (const id of removed) {
      this.panes.delete(id);
      this.visibleIds.delete(id);
    }
    for (const p of list) this.panes.set(p.id, { ...p, session });
    return { added, removed };
  }

  /** Forget every pane of a session (its connection ended). */
  removeSession(session: string): string[] {
    return this.update(session, []).removed;
  }

  sessionPanes(session: string): PaneInfo[] {
    return this.list().filter((p) => p.session === session);
  }

  list(): PaneInfo[] {
    return [...this.panes.values()];
  }

  get(id: string): PaneInfo | undefined {
    return this.panes.get(id);
  }

  /** Mark exactly these panes visible (unknown ids are ignored). Returns the new set. */
  setVisible(ids: Iterable<string>): string[] {
    this.visibleIds = new Set([...ids].filter((id) => this.panes.has(id)));
    return this.visible();
  }

  visible(): string[] {
    return [...this.visibleIds].sort();
  }

  isVisible(id: string): boolean {
    return this.visibleIds.has(id);
  }
}
