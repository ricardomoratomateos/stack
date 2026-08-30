import * as vscode from 'vscode';
import { AgentSessionState } from '../types';

export type StateChange = { worktreeId: string; state: AgentSessionState; windowIndex?: number };

export interface AttentionNotifierDeps {
  /** Aggregate per-worktree state stream (AgentSessionManager.onStateChange). */
  onStateChange: vscode.Event<StateChange>;
  /** Display label for a worktree (alias ?? branch). */
  labelFor(worktreeId: string): string | undefined;
  /** Live task title of one session window (e.g. "Wants to run Bash: …"). */
  sessionTitle(worktreeId: string, windowIndex: number): string | undefined;
  /** True when the user is already looking at this worktree's session. */
  isWatching(worktreeId: string): boolean;
  /** Config gate for notifications (foreman.notifyOnAttention). The badge is always kept. */
  enabled(): boolean;
  /**
   * Notification sink. Inside VSCode the sidebar badge and state dots already
   * carry the signal, so this should reach the user OUTSIDE the window (native
   * OS notification when unfocused) — never an in-window toast.
   */
  notify(message: string): void;
}

/**
 * Watches agent state transitions and surfaces "the agent needs you" moments:
 * a pending-attention count the sidebar shows as a view badge, plus an
 * out-of-window notification. Only genuine transitions notify — the first
 * state seen for a worktree (launch or post-reload reconnect) is a baseline.
 */
export class AttentionNotifier {
  private prev = new Map<string, AgentSessionState>();
  private attention = new Set<string>();
  private countEmitter = new vscode.EventEmitter<number>();
  private subscription: vscode.Disposable;

  /** Fires with the new pending-attention count whenever it changes. */
  readonly onAttentionChange = this.countEmitter.event;

  constructor(private deps: AttentionNotifierDeps) {
    this.subscription = deps.onStateChange((e) => this.handle(e));
  }

  attentionCount(): number {
    return this.attention.size;
  }

  /** The user looked at this worktree's session — clear its pending flag. */
  acknowledge(worktreeId: string): void {
    if (this.attention.delete(worktreeId)) this.countEmitter.fire(this.attention.size);
  }

  private handle({ worktreeId, state, windowIndex }: StateChange): void {
    const prev = this.prev.get(worktreeId);
    this.prev.set(worktreeId, state);

    // The agent is working again (or gone) — nothing pends on the user.
    if (state === 'active' || state === 'idle' || state === 'terminated') {
      this.acknowledge(worktreeId);
      return;
    }
    // First observation is a baseline, not a transition; repeats carry no news.
    if (prev === undefined || prev === state) return;
    // "waiting" only needs attention when the agent just finished working —
    // launch also starts at waiting, and that's the user's own action.
    if (state === 'waiting' && prev !== 'active' && prev !== 'permission') return;
    // The user is already looking at this session — clear any stale flag rather
    // than leaving a badge for something they can plainly see.
    if (this.deps.isWatching(worktreeId)) {
      this.acknowledge(worktreeId);
      return;
    }

    if (!this.attention.has(worktreeId)) {
      this.attention.add(worktreeId);
      this.countEmitter.fire(this.attention.size);
    }

    // The badge is always kept; only the notification is gated by config.
    if (!this.deps.enabled()) return;
    const label = this.deps.labelFor(worktreeId) ?? worktreeId;
    const title = windowIndex === undefined ? undefined : this.deps.sessionTitle(worktreeId, windowIndex);
    const base =
      state === 'permission'
        ? `${label}: agent is asking for permission`
        : `${label}: agent finished and is waiting for you`;
    this.deps.notify(title ? `${base} — ${title}` : base);
  }

  dispose(): void {
    this.subscription.dispose();
    this.countEmitter.dispose();
  }
}
