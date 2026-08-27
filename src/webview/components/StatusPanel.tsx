import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SECTION_TITLE_STYLE, T } from '../tokens';
import { getState, send, setState } from '../vscode';
import type { PortMapping, WorktreeItem } from '../types';

/** Smallest useful panel height, and the share of the sidebar it may never exceed. */
const MIN_HEIGHT = 60;
const MAX_FRACTION = 0.8;

function storedHeight(): number | undefined {
  const s = getState() as { statusPanelHeight?: unknown } | null | undefined;
  const h = s?.statusPanelHeight;
  return typeof h === 'number' && h >= MIN_HEIGHT ? h : undefined;
}

/** Merge into the existing webview state — never clobber whatever else is in it. */
function persistHeight(height: number): void {
  const s = (getState() as Record<string, unknown> | null) ?? {};
  setState({ ...s, statusPanelHeight: height });
}

/**
 * Collapsed sections, keyed "<worktree id>:<label>".
 *
 * Per worktree on purpose. The flag used to live in Section's own useState, and
 * React keeps that instance across a change of the `wt` prop — so collapsing
 * Docker in one worktree silently reopened it in the next, and switching back
 * and forth shuffled every section's state.
 */
function storedCollapsed(): Record<string, boolean> {
  const s = getState() as { collapsedSections?: unknown } | null | undefined;
  const c = s?.collapsedSections;
  return c && typeof c === 'object' ? { ...(c as Record<string, boolean>) } : {};
}

function persistCollapsed(map: Record<string, boolean>): void {
  const s = (getState() as Record<string, unknown> | null) ?? {};
  // Only collapsed entries are written; expanded is the default, so this cannot
  // grow a stale entry for every worktree ever opened.
  const collapsedOnly = Object.fromEntries(Object.entries(map).filter(([, v]) => v));
  setState({ ...s, collapsedSections: collapsedOnly });
}

const STATE_LABEL: Record<string, string> = {
  active:     'thinking',
  waiting:    'waiting',
  permission: 'needs attention',
  idle:       'idle',
  terminated: 'terminated',
};

const STATE_COLOR: Record<string, string> = {
  active:     T.purple,
  waiting:    T.green,
  permission: T.amber,
  idle:       T.textMuted,
  terminated: T.red,
};

interface Props {
  wt: WorktreeItem;
}

export function StatusPanel({ wt }: Props) {
  const [height, setHeight] = useState<number | undefined>(storedHeight);
  const [sashActive, setSashActive] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const latestHeight = useRef<number | undefined>(height);
  const endDrag = useRef<(() => void) | undefined>(undefined);

  // A drag in flight when this unmounts (selection cleared) would leak its
  // window listeners.
  useEffect(() => () => endDrag.current?.(), []);

  const onSashDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    setSashActive(true);

    const move = (ev: PointerEvent) => {
      // Dragging the sash UP grows the panel, which is why the delta is inverted.
      const next = Math.min(
        Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT),
        window.innerHeight * MAX_FRACTION,
      );
      latestHeight.current = next;
      setHeight(next);
    };
    const up = () => {
      endDrag.current?.();
      setSashActive(false);
      if (latestHeight.current !== undefined) persistHeight(latestHeight.current);
    };
    endDrag.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      endDrag.current = undefined;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Whether anything is scrolled out of sight below. Without a marker, a panel
  // whose bottom edge happens to land right on a section header is
  // indistinguishable from one showing everything there is — and the section
  // then reads as empty rather than as cut off.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(storedCollapsed);
  const sectionProps = (label: string) => {
    const key = `${wt.id}:${label}`;
    return {
      label,
      collapsed: collapsed[key] === true,
      onToggle: () => setCollapsed((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        persistCollapsed(next);
        return next;
      }),
    };
  };

  const syncOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 1px of slack: fractional scroll heights never settle on an exact equality.
    setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  // Re-checked after every render, because both the content (containers coming
  // up, sessions appearing) and the panel height change independently.
  useEffect(syncOverflow);

  // Clamp on every render: the stored height may not fit a sidebar that has
  // since been made shorter.
  const clamped = height !== undefined
    ? Math.min(height, window.innerHeight * MAX_FRACTION)
    : undefined;

  return (
    <div
      ref={panelRef}
      style={{
        position: 'relative',
        borderTop: `1px solid ${T.border}`,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        // Untouched, the panel keeps its old content-driven cap; once dragged it
        // holds the height the user chose.
        ...(clamped !== undefined ? { height: clamped } : { maxHeight: '55%' }),
      }}
    >
      {/* Sash — the same affordance as the boundary between two native views:
          drag to resize, ns-resize cursor, focus-border line while active. */}
      <div
        onPointerDown={onSashDown}
        onMouseEnter={() => setSashActive(true)}
        onMouseLeave={() => { if (!endDrag.current) setSashActive(false); }}
        style={{ position: 'absolute', top: -3, left: 0, right: 0, height: 7, cursor: 'ns-resize', zIndex: 5 }}
      >
        <div style={{
          position: 'absolute', top: 2, left: 0, right: 0, height: 2,
          background: sashActive ? T.borderStrong : 'transparent',
          transition: 'background .1s',
        }} />
      </div>

      <div
        ref={scrollRef}
        onScroll={syncOverflow}
        style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}
      >

      {/* Section header: worktree name */}
      <div style={{
        padding: '7px 12px 5px',
        borderBottom: `1px solid ${T.borderLight}`,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: T.titleFg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {wt.alias ?? wt.branch}
        </span>
      </div>

      {/* Claude */}
      {wt.agent !== 'idle' && (
        <Section {...sectionProps('Agents')}>
          <Row k="State">
            <Badge color={STATE_COLOR[wt.agent]}>{STATE_LABEL[wt.agent]}</Badge>
          </Row>
          {(wt.agentCount > 0 || wt.terminalCount > 0) && (
            <Row k="Sessions">
              <Val>{[
                wt.agentCount > 0 ? `${wt.agentCount} agent` : '',
                wt.terminalCount > 0 ? `${wt.terminalCount} terminal` : '',
              ].filter(Boolean).join(', ')}</Val>
            </Row>
          )}
        </Section>
      )}

      {/* Git */}
      <Section {...sectionProps('Git')}>
        <Row k="Branch">
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wt.branch}
          </span>
        </Row>
        {wt.git.ahead > 0 && (
          <Row k="Ahead"><Val>↑ {wt.git.ahead}</Val></Row>
        )}
        {wt.git.behind > 0 && (
          <Row k="Behind"><Val>↓ {wt.git.behind}</Val></Row>
        )}
        {wt.git.base && (
          <Row k="Base">
            <button
              type="button"
              title={`${wt.git.base.behind} commit${wt.git.base.behind === 1 ? '' : 's'} behind ${wt.git.base.ref}, ${wt.git.base.ahead} ahead — click to fetch and check again`}
              onClick={() => send({ type: 'refreshDrift', worktreeId: wt.id })}
              style={{ background: 'none', border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}
            >
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {wt.git.base.ref}
              </span>
              {/* Behind is the number that matters — it is the one that grows
                  while you work and the one that decides whether to rebase — so
                  it gets the colour and shows even at zero. */}
              <span style={{ fontFamily: T.mono, fontSize: 11, flexShrink: 0, color: wt.git.base.behind > 0 ? T.amber : T.textMuted }}>
                ↓{wt.git.base.behind}
              </span>
            </button>
          </Row>
        )}
        {wt.git.hasChanges && (
          <Row k="Changes">
            <Val>
              {[
                wt.git.staged > 0 ? `${wt.git.staged} staged` : '',
                wt.git.unstaged > 0 ? `${wt.git.unstaged} unstaged` : '',
                wt.git.untracked > 0 ? `${wt.git.untracked} untracked` : '',
              ].filter(Boolean).join(', ')}
            </Val>
          </Row>
        )}
        {!wt.git.hasChanges && wt.git.ahead === 0 && wt.git.behind === 0 && (
          <Row k="Status"><Val style={{ color: T.green }}>clean</Val></Row>
        )}
      </Section>

      {/* PR */}
      {wt.pr && (
        <Section {...sectionProps('Pull Request')}>
          <Row k="Number">
            <Badge color={T.blue}>#{wt.pr.number}</Badge>
          </Row>
          <Row k="State">
            {/* `gh pr list` reports OPEN/CLOSED/MERGED; comparing against the
                lowercase forms matched nothing, so the badge was always grey
                whatever the PR was doing. */}
            <Badge color={prColor(wt.pr.state)}>
              {wt.pr.state.toLowerCase()}
            </Badge>
          </Row>
        </Section>
      )}

      {/* Docker. Shown for the ports alone when the stack is down, which is
          exactly when you want to know which port this worktree answers on. */}
      {(wt.docker.length > 0 || wt.ports.length > 0) && (
        <Section
          {...sectionProps('Docker')}
          hint={wt.docker.length > 0
            ? `${wt.docker.filter((c) => c.state === 'running').length}/${wt.docker.length} up`
            : undefined}
        >
          {wt.docker.map((c) => (
            <DockerRow key={c.name} name={c.name} state={c.state} />
          ))}
          {wt.ports.map((p) => (
            <PortRow key={p.name} {...p} />
          ))}
        </Section>
      )}

      </div>

      {/* Fade at the bottom edge while content remains below. Purely a marker —
          pointer-events off, so it never eats a click on the last row. */}
      {moreBelow && (
        <div
          aria-hidden
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: 18,
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${T.bg})`,
          }}
        />
      )}
    </div>
  );
}

/**
 * `hint` carries the section's headline number in the header itself.
 *
 * Worth the extra prop because the body can be out of sight two different ways
 * — collapsed, or scrolled past the panel's bottom edge — and a header reading
 * "DOCKER" with nothing under it does not look truncated, it looks like an
 * answer: no containers. That cost a long debugging session on a stack that was
 * running the whole time.
 */
function Section({ label, hint, collapsed, onToggle, children }: {
  label: string;
  hint?: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: `1px solid ${T.borderLight}` }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 2,
          // Left padding aligns our chevron with the native view header's
          // twistie below; the webview's content starts at the pane's edge,
          // where a real pane header is already inset.
          height: 22, padding: '0 12px 0 10px',
          background: T.sectionHeaderBg, border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <i
          className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`}
          style={{ fontSize: 16, color: T.sectionHeaderFg, flexShrink: 0 }}
        />
        <span style={{ ...SECTION_TITLE_STYLE, color: T.sectionHeaderFg }}>
          {label}
        </span>
        {hint && (
          <span style={{
            marginLeft: 'auto', flexShrink: 0,
            fontFamily: T.mono, fontSize: 10, color: T.textDim,
          }}>
            {hint}
          </span>
        )}
      </button>
      {!collapsed && (
        <div style={{ padding: '0 12px 8px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 22 }}>
      <span style={{ fontSize: 11, color: T.textDim, flexShrink: 0 }}>{k}</span>
      <div style={{ minWidth: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

function Val({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, ...style }}>
      {children}
    </span>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 6px', borderRadius: 3,
      background: `color-mix(in srgb, ${color} 9%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 18%, transparent)`,
      fontFamily: T.sans, fontSize: 11, color,
    }}>
      {children}
    </span>
  );
}

/** Case-insensitive, because the state comes straight from `gh` in upper case. */
function prColor(state: string): string {
  switch (state.toLowerCase()) {
    case 'open':   return T.green;
    case 'merged': return T.purple;
    default:       return T.textMuted;
  }
}

/**
 * One of the worktree's own ports.
 *
 * The number was the missing half of per-worktree docker: Unmess assigned each
 * worktree a block of ports and then never told anyone which, so finding the
 * one you wanted meant reading the generated compose override or guessing from
 * the slot arithmetic.
 */
function PortRow({ name, port, openable }: PortMapping) {
  // HTTP_PORT reads as "http" beside the container names, which are lowercase.
  const label = name.replace(/_PORT$/, '').toLowerCase();
  const value = (
    <span style={{ fontFamily: T.mono, fontSize: 11, color: openable ? T.blue : T.textDim, flexShrink: 0 }}>
      {port}
    </span>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
      {/* Aligns the label with the container rows above, which lead with a dot. */}
      <span aria-hidden style={{ width: 5, flexShrink: 0 }} />
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {openable ? (
        <button
          type="button"
          title={`Open http://localhost:${port}`}
          onClick={() => send({ type: 'openPort', port })}
          style={{ background: 'none', border: 'none', padding: 0, display: 'flex', alignItems: 'center' }}
        >
          {value}
        </button>
      ) : (
        // The debug port: shown because the user asked for it by naming
        // XDEBUG_PORT, but a debugger listener answers nothing a browser can
        // render, so there is no click to offer.
        <span title="Debug port">{value}</span>
      )}
    </div>
  );
}

function DockerRow({ name, state }: { name: string; state: string }) {
  const isUp = state === 'running';
  const color = isUp ? T.green : T.textMuted;
  // strip common prefix noise like "my-app-" and "-1"
  const shortName = name.replace(/^[\w-]+-app-/, '').replace(/-\d+$/, '');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: color, flexShrink: 0,
      }} />
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {shortName}
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 11, color, flexShrink: 0 }}>
        {state}
      </span>
    </div>
  );
}
