import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { GROUP_SHORT } from '@core/webview/derive';
import { useStackd } from '../stackd/useStackd';
import { APP_VERSION, stackdDrift } from '../stackd/version';
import { VersionBanner } from '../stackd/VersionBanner';
import { graphOf, layout, loadCached, mergeGraph, saveCached, TRUNK_X, type BootGraph } from './bootModel';
import './boot.css';

/** Below this, a boot that is already done never shows the screen (no flash). */
const SHOW_AFTER_MS = 220;
/** Once every branch is lit, how long they glow before the screen leaves. */
const LINGER_MS = 650;
const LEAVE_MS = 380;
/** Past this the screen steps aside and the app shows what is wrong (StartStackd, an error). */
const GIVE_UP_MS = 15_000;

type Phase = 'boot' | 'lit' | 'leaving' | 'done';

/**
 * Covers the app while it comes up — at open, and while a stackd from another build is
 * replaced (silently: agents live in tmux, so a restart costs them nothing). It draws the
 * repo as a trunk and each task as a branch growing from it, remembered from the last run
 * so they appear at once; a branch lights up in its state's colour when stackd confirms it.
 */
export function BootGate() {
  const { running, snapshot } = useStackd();
  const [phase, setPhase] = useState<Phase>('boot');
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const [autostartError, setAutostartError] = useState(false);
  const attempted = useRef(false);
  const cached = useMemo(() => loadCached(), []);
  const startedAt = useRef(Date.now());

  const drift = running && snapshot ? stackdDrift(APP_VERSION, snapshot.version) : null;
  const ready = running === true && snapshot !== null && drift === null;
  const live = useMemo(() => (snapshot ? graphOf(snapshot) : null), [snapshot]);
  const graph = useMemo(() => mergeGraph(cached, live), [cached, live]);

  useEffect(() => {
    if (live) saveCached(live);
  }, [live]);

  // A stackd from another build: replace it once, quietly. If that does not fix it, the banner offers it by hand.
  useEffect(() => {
    if (!drift || attempted.current) return;
    attempted.current = true;
    setRestarting(true);
    startedAt.current = Date.now();
    setPhase((p) => (p === 'done' ? 'boot' : p));
    void invoke('stackd_restart').catch(() => setRestartFailed(true));
  }, [drift]);
  useEffect(() => {
    if (ready) setRestarting(false);
  }, [ready]);

  // The app's own start at open failed: step aside for the screen that says why.
  useEffect(() => {
    const follow = (a: { error: string | null }) => a.error && setAutostartError(true);
    void invoke<{ error: string | null }>('stackd_autostart').then(follow).catch(() => {});
    const un = listen<{ error: string | null }>('stackd://autostart', (e) => follow(e.payload));
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    if (phase === 'done') return;
    if (ready) {
      if (phase === 'boot') setPhase(Date.now() - startedAt.current < SHOW_AFTER_MS ? 'done' : 'lit');
      return;
    }
    if (autostartError || restartFailed) {
      setPhase('done');
      return;
    }
    const t = setTimeout(() => setPhase('done'), Math.max(0, GIVE_UP_MS - (Date.now() - startedAt.current)));
    return () => clearTimeout(t);
  }, [ready, phase, autostartError, restartFailed]);

  useEffect(() => {
    if (phase === 'lit') {
      const t = setTimeout(() => setPhase('leaving'), LINGER_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'leaving') {
      const t = setTimeout(() => setPhase('done'), LEAVE_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // Done but still another build (the quiet restart did not take): offer it by hand.
  if (phase === 'done') return attempted.current ? <VersionBanner /> : null;

  const step = restarting
    ? `updating stackd to ${APP_VERSION}`
    : running === null
      ? 'looking for stackd'
      : !running
        ? 'waking stackd'
        : !snapshot
          ? 'reading tasks'
          : graph.tasks.length
            ? `${graph.tasks.length + graph.more} task${graph.tasks.length + graph.more === 1 ? '' : 's'}`
            : 'no tasks yet';

  return (
    <div className="boot" data-phase={phase} data-tauri-drag-region role="status" aria-live="polite" aria-label={step}>
      <BranchGraph graph={graph} confirmed={ready || (running === true && snapshot !== null && !restarting)} />
      <p className="boot-step">{step}</p>
    </div>
  );
}

export function BranchGraph({ graph, confirmed }: { graph: BootGraph; confirmed: boolean }) {
  const tips = graph.tasks.length + (graph.more ? 1 : 0);
  const l = layout(tips);
  return (
    <svg className="boot-graph" viewBox={`0 0 520 ${l.height}`} width={624} height={l.height * 1.2} aria-hidden="true">
      <path className="boot-trunk" d={`M ${TRUNK_X} ${l.trunkY} H ${Math.max(l.trunkEnd, TRUNK_X + 60)}`} pathLength={1} />
      <circle className="boot-root" cx={TRUNK_X} cy={l.trunkY} r={5} />
      <text className="boot-trunk-label" x={TRUNK_X} y={l.trunkY + 22}>{graph.trunk}</text>
      {l.branches.map((b, i) => {
        const task = graph.tasks[i];
        const group = confirmed ? task?.group : undefined;
        const style = { '--i': i, '--c': group ? `var(--boot-${group})` : undefined } as React.CSSProperties;
        return (
          <g key={task?.id ?? 'more'} className="boot-branch" data-lit={group ? '' : undefined} style={style}>
            <path className="boot-stem" d={b.path} pathLength={1} />
            <circle className="boot-fork" cx={b.forkX} cy={l.trunkY} r={2.5} />
            {group && <circle className="boot-ripple" cx={l.tipX} cy={b.y} r={5} />}
            <circle className="boot-tip" cx={l.tipX} cy={b.y} r={5} />
            <text className="boot-name" x={l.tipX + 16} y={b.y + 4}>
              {task ? clip(task.name) : `+${graph.more} more`}
              {group && <tspan className="boot-state" dx={10}>{GROUP_SHORT[group].toLowerCase()}</tspan>}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const clip = (s: string) => (s.length > 30 ? `${s.slice(0, 29)}…` : s);

/** `/?dev=boot`: the boot screen on the sample tasks, cycling unconfirmed → lit (see main.tsx). */
export function DevBoot({ graph }: { graph: BootGraph }) {
  const [round, setRound] = useState(0);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    setLit(false);
    const a = setTimeout(() => setLit(true), 2600);
    const b = setTimeout(() => setRound((r) => r + 1), 6000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [round]);
  return (
    <div className="boot" key={round} data-phase={lit ? 'lit' : 'boot'}>
      <BranchGraph graph={lit ? graph : mergeGraph(graph, null)} confirmed={lit} />
      <p className="boot-step">{lit ? `${graph.tasks.length} tasks` : 'waking stackd'}</p>
    </div>
  );
}
