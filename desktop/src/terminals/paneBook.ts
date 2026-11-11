export interface PaneInfo {
  id: string;
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

/** Bookkeeping of known panes and which of them are visible. */
export class PaneBook {
  private panes = new Map<string, PaneInfo>();
  private visibleIds = new Set<string>();

  /** Replace the pane list; reports what appeared and disappeared. */
  update(list: PaneInfo[]): PaneDiff {
    const next = new Map(list.map((p) => [p.id, p]));
    const added = list.filter((p) => !this.panes.has(p.id)).map((p) => p.id);
    const removed = [...this.panes.keys()].filter((id) => !next.has(id));
    this.panes = next;
    for (const id of removed) this.visibleIds.delete(id);
    return { added, removed };
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
