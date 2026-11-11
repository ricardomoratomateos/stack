/**
 * When to notify about "needs you" (permission / question). Pure: time and inputs are passed in,
 * so grouping, suppression, the re-notify schedule and Do Not Disturb are testable.
 * "Ready for review" never notifies (badge only), so it is not an input here.
 */
export const GROUP_MS = 5_000;
export const RENOTIFY_MS = [2 * 60_000, 10 * 60_000] as const;

export interface Need {
  /** Worktree id. */
  id: string;
  /** `<repo> · <worktree>`. */
  title: string;
  /** The pending command / question. */
  body: string;
}

export interface PolicyInput {
  needs: Need[];
  /** The app is the focused window. */
  focused: boolean;
  /** The worktree whose session is on screen. */
  selectedId?: string;
  dnd: boolean;
}

export interface Notice {
  title: string;
  body: string;
  /** The worktrees it is about; a click selects the first (the oldest ask). */
  ids: string[];
}

interface Entry {
  need: Need;
  /** The clock of the schedule: when the ask appeared, or was last unheld. */
  since: number;
  /** Notifications sent for this ask: 0 first one pending, 1 waiting for the 2 min one, 2 for the 10 min one, 3 done. */
  sent: number;
}

export class NotifyPolicy {
  private entries = new Map<string, Entry>();
  private held = new Set<string>();

  /** Feed the current state; asks that are gone are forgotten, a changed ask restarts the schedule. */
  update(now: number, input: PolicyInput): void {
    const live = new Set(input.needs.map((n) => n.id));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.entries.delete(id);
    for (const need of input.needs) {
      const e = this.entries.get(need.id);
      if (!e || e.need.body !== need.body) this.entries.set(need.id, { need, since: now, sent: 0 });
      else e.need = need;
    }
    // While an ask is on screen (or everything is muted) its clock does not run: it starts again when the user looks away.
    const before = this.held;
    this.held = new Set(
      input.needs.filter((n) => input.dnd || (input.focused && input.selectedId === n.id)).map((n) => n.id),
    );
    for (const id of before) {
      if (this.held.has(id)) continue;
      const e = this.entries.get(id);
      if (e) e.since = now; // released just now
    }
    for (const id of this.held) {
      const e = this.entries.get(id);
      if (e) e.since = now;
    }
  }

  /** The notification due at `now`, if any; marks what it covers as sent. Call on a timer (1 s is plenty). */
  due(now: number): Notice | null {
    const ready: Entry[] = [];
    let groupStart = Infinity;
    for (const [id, e] of this.entries) {
      if (!this.held.has(id) && e.sent === 0) groupStart = Math.min(groupStart, e.since);
    }
    for (const [id, e] of this.entries) {
      if (this.held.has(id) || e.sent >= 3) continue;
      const at = e.sent === 0 ? groupStart + GROUP_MS : e.since + RENOTIFY_MS[e.sent - 1];
      if (now >= at) ready.push(e);
    }
    if (ready.length === 0) return null;
    ready.sort((a, b) => a.since - b.since);
    for (const e of ready) e.sent += 1;
    if (ready.length === 1) {
      const { need } = ready[0];
      return { title: need.title, body: need.body, ids: [need.id] };
    }
    return {
      title: `${ready.length} tasks need you`,
      body: ready.map((e) => e.need.title).join('\n'),
      ids: ready.map((e) => e.need.id),
    };
  }
}
