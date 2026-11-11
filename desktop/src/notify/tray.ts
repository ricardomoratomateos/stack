/** What the menu-bar item shows, derived from stackd's snapshot. Pure. */
import { attentionOf, describe, nameOf, type Described } from '@core/webview/derive';
import type { Snapshot } from '../stackd/api';
import type { Need } from './policy';

export interface TrayEntry {
  worktreeId: string;
  label: string;
  /** The session asking for permission: the menu offers Allow for it. */
  allow?: number;
}

export interface TrayModel {
  /** Text next to the icon: "2 · 1" with a diamond each. */
  title: string;
  needs: TrayEntry[];
  review: TrayEntry[];
  dnd: boolean;
}

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

interface Row { repo: string; d: Described }

function rows(snapshot: Snapshot | null): Row[] {
  return (snapshot?.repos ?? []).flatMap((r) => r.state.worktrees.map((wt) => ({ repo: baseName(r.repoRoot), d: describe(wt, r.state.dockerUnavailable) })));
}


function bodyOf(d: Described): string {
  const a = attentionOf(d.wt);
  return a?.command ?? a?.text ?? 'Needs you';
}

/** Every worktree needing you, with the repo's name and the pending command/question. */
export function needsOf(snapshot: Snapshot | null): Need[] {
  return rows(snapshot)
    .filter((r) => r.d.group === 'needs')
    .sort((a, b) => (a.d.wt.since ?? Infinity) - (b.d.wt.since ?? Infinity))
    .map((r) => ({
      id: r.d.wt.id,
      title: `${r.repo} · ${nameOf(r.d.wt)}`,
      body: bodyOf(r.d),
    }));
}

export function trayModel(snapshot: Snapshot | null, dnd: boolean): TrayModel {
  const all = rows(snapshot);
  const entry = (r: Row): TrayEntry => {
    const ask = r.d.group === 'needs' ? r.d.wt.sessions.find((s) => s.kind === 'agent' && s.state === 'permission') : undefined;
    return { worktreeId: r.d.wt.id, label: `${r.repo} · ${nameOf(r.d.wt)}`, allow: ask?.index };
  };
  const needs = all.filter((r) => r.d.group === 'needs').map(entry);
  const review = all.filter((r) => r.d.group === 'review').map(entry);
  return { title: `◆ ${needs.length}  ◇ ${review.length}`, needs, review, dnd };
}
