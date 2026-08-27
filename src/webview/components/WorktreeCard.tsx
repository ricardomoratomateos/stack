import React, { useEffect, useRef, useState } from 'react';
import { T } from '../tokens';
import { StateDot } from './StateDot';
import { send } from '../vscode';
import type { SessionItem, WorktreeItem } from '../types';

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
  isSelected: boolean;
  onSelect: () => void;
  defaultProvider?: string;
  installedProviders?: string[];
  dockerEnabled?: boolean;
  cardDragging: boolean;
  cardDragOver: boolean;
  onCardDragStart: () => void;
  onCardDragEnter: () => void;
  onCardDrop: () => void;
  onCardDragEnd: () => void;
}

export function WorktreeCard({
  wt, isSelected, onSelect, defaultProvider, installedProviders, dockerEnabled,
  cardDragging, cardDragOver, onCardDragStart, onCardDragEnter, onCardDrop, onCardDragEnd,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  // Undefined means the extension has not reported yet — assume available
  // rather than dimming the button on first paint (same rule as the menu).
  const primaryInstalled =
    installedProviders === undefined || !defaultProvider || installedProviders.includes(defaultProvider);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Move window `from` to the slot occupied by window `to`, and persist the
  // resulting order of tmux window indexes.
  const commitReorder = (from: number, to: number) => {
    const indexes = wt.sessions.map((s) => s.index);
    const fromPos = indexes.indexOf(from);
    const toPos = indexes.indexOf(to);
    if (fromPos === -1 || toPos === -1 || fromPos === toPos) return;
    const next = [...indexes];
    next.splice(toPos, 0, next.splice(fromPos, 1)[0]);
    send({ type: 'reorderSessions', worktreeId: wt.id, orderedIndexes: next });
  };
  const hasPerm = wt.agent === 'permission';
  const hasSession = wt.agent !== 'idle';
  const dockerRunning = wt.docker.some((c) => c.state === 'running');
  const deleting = wt.deleting;

  const cardStyle: React.CSSProperties = {
    borderRadius: 6,
    border: `1px solid ${hasPerm ? `color-mix(in srgb, ${T.amber} 35%, transparent)` : isSelected ? T.borderStrong : 'transparent'}`,
    padding: '9px 10px',
    cursor: deleting ? 'default' : 'pointer',
    background: hasPerm
      ? `color-mix(in srgb, ${T.amber} 5%, transparent)`
      : isSelected
      ? T.surface3
      : hovered
      ? T.surface2
      : 'transparent',
    transition: 'background .12s, border-color .12s',
    animation: 'unmess-fadein .15s ease',
    boxShadow: cardDragOver ? `inset 0 2px 0 ${T.borderStrong}` : 'none',
    opacity: cardDragging ? 0.4 : 1,
    // While tearing down: fade it out and block every interaction.
    ...(deleting ? { opacity: 0.45, pointerEvents: 'none' } : {}),
  };

  // Only non-main cards reorder; main is pinned first by the extension.
  const draggable = !wt.isMain && !deleting;

  const gitMeta: Array<{ text: string; color: string }> = [];
  if (wt.git.hasChanges) gitMeta.push({ text: `~${wt.git.unstaged + wt.git.staged}`, color: T.green });
  if (wt.git.untracked > 0) gitMeta.push({ text: `?${wt.git.untracked}`, color: T.amber });
  if (wt.git.ahead > 0) gitMeta.push({ text: `↑${wt.git.ahead}`, color: T.green });
  if (wt.git.behind > 0) gitMeta.push({ text: `↓${wt.git.behind}`, color: T.red });

  return (
    <div
      style={cardStyle}
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; onCardDragStart(); } : undefined}
      onDragEnter={(e) => { e.preventDefault(); onCardDragEnter(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => { e.preventDefault(); onCardDrop(); }}
      onDragEnd={onCardDragEnd}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Row 1: state dot + name + git meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
        <StateDot state={wt.agent} />
        <span style={{
          fontSize: T.fontSize,
          fontWeight: 500,
          color: T.textStrong,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}>
          {wt.alias ?? wt.branch}
        </span>
        {deleting ? (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>
            deleting…
          </span>
        ) : gitMeta.length > 0 && (
          <span style={{ fontFamily: T.mono, fontSize: 11, display: 'flex', gap: 6, flexShrink: 0 }}>
            {gitMeta.map((m) => (
              <span key={m.text} style={{ color: m.color }}>{m.text}</span>
            ))}
          </span>
        )}
      </div>

      {/* Sessions list (drag rows to reorder within the worktree) */}
      {wt.sessions.length > 0 && (
        <div style={{ marginLeft: 14, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {wt.sessions.map((s) => (
            <SessionRow
              key={`${s.kind}-${s.index}`}
              session={s}
              worktreeId={wt.id}
              onSelect={onSelect}
              dragging={dragIndex === s.index}
              dragOver={overIndex === s.index && dragIndex !== null && dragIndex !== s.index}
              onDragStart={() => setDragIndex(s.index)}
              onDragEnter={() => setOverIndex(s.index)}
              onDrop={() => { if (dragIndex !== null) commitReorder(dragIndex, s.index); setDragIndex(null); setOverIndex(null); }}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            />
          ))}
        </div>
      )}

      {/* Actions row — always visible */}
      <div style={{
        marginTop: 7, marginLeft: 14,
        display: 'flex', alignItems: 'center', gap: 2,
      }}>
        {/* Split button: the big half launches the primary agent, the chevron
            opens the rest. Relative, because the menu anchors to it. */}
        <div ref={menuAnchorRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          {/* The primary agent gets the same installed check the menu applies.
              Without it the menu greyed an agent out while the button 13px away
              launched it anyway, and the failure surfaced inside tmux rather
              than as a notification. */}
          <IconActionBtn
            title={
              !primaryInstalled
                ? `${defaultProvider ?? 'agent'} is not on your PATH`
                : hasSession
                ? `New ${defaultProvider ?? 'agent'} session`
                : `Launch ${defaultProvider ?? 'agent'}`
            }
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
              if (!primaryInstalled && defaultProvider) {
                send({ type: 'showProviderInstall', provider: defaultProvider as never });
                return;
              }
              send({ type: 'launchAgent', worktreeId: wt.id });
            }}
          >
            <span style={{ opacity: primaryInstalled ? 1 : 0.4, display: 'inline-flex' }}>
              <DefaultProviderIcon provider={defaultProvider} />
            </span>
          </IconActionBtn>
          <IconActionBtn
            title={menuOpen ? 'Close' : 'Launch another agent…'}
            narrow
            onClick={(e) => { e.stopPropagation(); setMenuOpen((open) => !open); }}
          >
            <i
              className={`codicon codicon-chevron-${menuOpen ? 'up' : 'down'}`}
              style={{ fontSize: 12 }}
            />
          </IconActionBtn>
          {menuOpen && (
            <ProviderMenu
              primary={defaultProvider}
              installed={installedProviders}
              containerRef={menuAnchorRef}
              onClose={() => setMenuOpen(false)}
              onLaunch={(provider) => send({ type: 'launchAgent', worktreeId: wt.id, provider: provider as never })}
              onSetPrimary={() => send({ type: 'pickDefaultProvider' })}
              onInstall={(provider) => send({ type: 'showProviderInstall', provider: provider as never })}
            />
          )}
        </div>
        <IconActionBtn
          title="Open terminal"
          onClick={(e) => { e.stopPropagation(); send({ type: 'openTerminal', worktreeId: wt.id }); }}
        >
          <i className="codicon codicon-terminal" />
        </IconActionBtn>
        {!wt.isMain && (
          <IconActionBtn
            title="Run setup script (init worktree)"
            onClick={(e) => { e.stopPropagation(); send({ type: 'initWorktree', worktreeId: wt.id }); }}
          >
            <i className="codicon codicon-zap" />
          </IconActionBtn>
        )}
        <IconActionBtn
          title="Review diff & comment"
          onClick={(e) => { e.stopPropagation(); send({ type: 'openDiff', worktreeId: wt.id }); }}
        >
          <i className="codicon codicon-git-compare" />
        </IconActionBtn>
        {dockerEnabled && (
          dockerRunning ? (
            <IconActionBtn
              title="Stop containers"
              onClick={(e) => { e.stopPropagation(); send({ type: 'dockerDown', worktreeId: wt.id }); }}
              danger
            >
              <i className="codicon codicon-debug-stop" />
            </IconActionBtn>
          ) : (
            <IconActionBtn
              title="Start containers"
              onClick={(e) => { e.stopPropagation(); send({ type: 'dockerUp', worktreeId: wt.id }); }}
            >
              <i className="codicon codicon-play" />
            </IconActionBtn>
          )
        )}
        <IconActionBtn
          title="Rename / set title"
          onClick={(e) => { e.stopPropagation(); send({ type: 'renameWorktree', worktreeId: wt.id }); }}
        >
          <i className="codicon codicon-edit" />
        </IconActionBtn>
        <IconActionBtn
          title="Delete worktree"
          onClick={(e) => { e.stopPropagation(); send({ type: 'deleteWorktree', worktreeId: wt.id }); }}
          danger
        >
          <i className="codicon codicon-trash" />
        </IconActionBtn>
      </div>

    </div>
  );
}

/** Claude's coral sunburst, approximated as an 8-ray asterisk. */
function ClaudeSpark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"
        stroke="#D97757" strokeWidth="1.8" strokeLinecap="round"
      />
    </svg>
  );
}

/** opencode's terminal block: rounded square with a prompt chevron. */
function OpenCodeMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" stroke="#9DA5B4" strokeWidth="1.6" />
      <path d="M5.2 5.8 8 8 5.2 10.2M9 10.5h2" stroke="#9DA5B4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** OpenAI's knot, reduced to a single loop at this size. */
function CodexMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.4" stroke="#10A37F" strokeWidth="1.7" />
      <path d="M8 2.6c2.4 1.6 3.6 3.4 3.6 5.4s-1.2 3.8-3.6 5.4C5.6 11.8 4.4 10 4.4 8S5.6 4.2 8 2.6Z"
        stroke="#10A37F" strokeWidth="1.4" />
    </svg>
  );
}

/** xAI's slashed X. */
function GrokMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2.6 13 13.4M13 2.6 3 13.4" stroke="#C8CDD6" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Stand-in for a provider this build does not know about (an older session's id). */
function UnknownMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.6" stroke="#6E7681" strokeWidth="1.6" strokeDasharray="2.4 2" />
    </svg>
  );
}

type ProviderVisual = { icon: (props: { size?: number }) => React.ReactElement; tint: string; label: string };

/** Brand icon + tint + display name per provider. */
const PROVIDER_VISUAL: Record<string, ProviderVisual> = {
  claude:   { icon: ClaudeSpark,  tint: 'color-mix(in srgb, #D97757 16%, transparent)', label: 'claude' },
  codex:    { icon: CodexMark,    tint: 'color-mix(in srgb, #10A37F 16%, transparent)', label: 'codex' },
  grok:     { icon: GrokMark,     tint: 'color-mix(in srgb, #C8CDD6 14%, transparent)', label: 'grok' },
  opencode: { icon: OpenCodeMark, tint: 'color-mix(in srgb, #9DA5B4 14%, transparent)', label: 'opencode' },
};

const UNKNOWN_VISUAL: ProviderVisual = {
  icon: UnknownMark, tint: 'color-mix(in srgb, #6E7681 14%, transparent)', label: 'agent',
};

/**
 * Never falls back to Claude. Sessions recorded before providers existed, and
 * ids from a newer build, are genuinely unknown — painting them with Claude's
 * mark asserts something we do not know, and Claude is no longer the safe guess.
 */
function visualFor(provider?: string): ProviderVisual {
  return (provider && PROVIDER_VISUAL[provider]) || UNKNOWN_VISUAL;
}

/** Brand icon of the configured primary provider, sized to match the codicons beside it. */
function DefaultProviderIcon({ provider }: { provider?: string }) {
  const visual = visualFor(provider);
  return <visual.icon size={13} />;
}

/** Order shown in the dropdown — stable, so the list never reshuffles under the cursor. */
const PROVIDER_ORDER = ['claude', 'codex', 'grok', 'opencode'] as const;

/**
 * The chevron's menu, rendered here rather than through VSCode's QuickPick.
 * The QuickPick pulls focus to the command palette at the top of the window,
 * which is a long way from the card you clicked.
 */
function ProviderMenu({
  primary, installed, containerRef, onClose, onLaunch, onSetPrimary, onInstall,
}: {
  primary?: string;
  installed?: string[];
  /** The split button, which wraps this menu. See the mousedown handler below. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onLaunch: (provider: string) => void;
  onSetPrimary: () => void;
  onInstall: (provider: string) => void;
}) {
  // Dismiss on outside click or Escape. Capture phase, because the card itself
  // stops propagation on click to avoid selecting the worktree.
  //
  // The bounds checked are the whole split button, not just this menu: with the
  // chevron treated as "outside", clicking it while open closed the menu here
  // and the button's own onClick immediately reopened it, so it could never be
  // collapsed by the control that opened it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, containerRef]);

  // Undefined means the extension has not reported yet; treat everything as
  // available rather than dimming the whole menu on first paint.
  const isInstalled = (id: string) => installed === undefined || installed.includes(id);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 3,
        minWidth: 150, padding: 3,
        background: T.menuBg, color: T.menuFg,
        border: `1px solid ${T.menuBorder}`, borderRadius: 5,
        // A black shadow is invisible on a black sidebar; the theme's own
        // widget shadow is the only one that shows up in every theme.
        boxShadow: '0 4px 12px var(--vscode-widget-shadow, rgba(0,0,0,.35))',
      }}
    >
      {PROVIDER_ORDER.map((id) => {
        const visual = visualFor(id);
        const available = isInstalled(id);
        return (
          <button
            key={id}
            className="u-menu-item"
            data-disabled={!available}
            title={available ? `Launch ${visual.label}` : `${visual.label} is not on your PATH`}
            onClick={() => { onClose(); available ? onLaunch(id) : onInstall(id); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, width: '100%',
              padding: '4px 7px', border: 'none', borderRadius: 3,
              background: 'transparent', color: 'inherit',
              font: 'inherit', fontSize: 11, textAlign: 'left', cursor: 'pointer',
              opacity: available ? 1 : 0.4,
            }}
          >
            <visual.icon size={12} />
            <span style={{ flex: 1, fontWeight: id === primary ? 600 : 400 }}>{visual.label}</span>
            {id === primary && (
              <i className="codicon codicon-check" style={{ fontSize: 11, opacity: 0.7 }} />
            )}
          </button>
        );
      })}
      <div style={{ height: 1, background: T.menuSepBg, margin: '3px 0' }} />
      <button
        className="u-menu-item"
        title="Choose which agent the big button launches"
        onClick={() => { onClose(); onSetPrimary(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%',
          padding: '4px 7px', border: 'none', borderRadius: 3,
          background: 'transparent', color: 'inherit', opacity: 0.75,
          font: 'inherit', fontSize: 11, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <i className="codicon codicon-ellipsis" style={{ fontSize: 11 }} />
        <span>change primary…</span>
      </button>
    </div>
  );
}

/** Warp-style avatar: brand icon in a tinted circle + state badge overlaid bottom-right. */
function SessionAvatar({ session }: { session: SessionItem }) {
  const isAgent = session.kind === 'agent';
  const visual = visualFor(session.provider);
  const badgeColor = STATE_COLOR[session.state] ?? T.textMuted;
  const badgeCls = session.state === 'active' ? 'u-dot-active' : session.state === 'permission' ? 'u-dot-perm' : '';
  return (
    <span style={{ position: 'relative', width: 18, height: 18, flexShrink: 0 }}>
      <span style={{
        width: 18, height: 18, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: isAgent ? visual.tint : T.surface2,
      }}>
        {isAgent
          ? <visual.icon />
          : <i className="codicon codicon-terminal" style={{ fontSize: 11, color: T.textDim }} />}
      </span>
      {isAgent && (
        <span
          className={badgeCls}
          style={{
            position: 'absolute', right: -1, bottom: -1,
            width: 7, height: 7, borderRadius: '50%',
            background: badgeColor,
            boxShadow: `0 0 0 2px ${T.bg}`,
          }}
        />
      )}
    </span>
  );
}

function SessionRow({
  session, worktreeId, onSelect,
  dragging, dragOver, onDragStart, onDragEnter, onDrop, onDragEnd,
}: {
  session: SessionItem;
  worktreeId: string;
  onSelect: () => void;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const [hov, setHov] = useState(false);

  const isAgent = session.kind === 'agent';
  const dotColor = isAgent ? STATE_COLOR[session.state] : T.textMuted;

  return (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); onDragEnter(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(); }}
      onDragEnd={(e) => { e.stopPropagation(); onDragEnd(); }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
        send({ type: 'focusSession', worktreeId, kind: session.kind, index: session.index });
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '4px 6px', borderRadius: 4,
        background: hov ? T.surface4 : 'transparent',
        transition: 'background .1s',
        cursor: 'pointer',
        opacity: dragging ? 0.4 : 1,
        boxShadow: dragOver ? `inset 0 2px 0 ${T.borderStrong}` : 'none',
      }}
    >
      <SessionAvatar session={session} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {/* Line 1: window name + state label / kill button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: T.mono, fontSize: 11,
            color: hov ? T.textDim : T.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1, minWidth: 0,
          }}>
            {session.name}
          </span>
          {/* right slot: state label pinned to the edge; action buttons slide in
              from the right on hover (collapsed to zero width when idle, so the
              state label never looks off-center) */}
          <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {isAgent && (
              <span style={{ fontFamily: T.mono, fontSize: 10, lineHeight: 1, color: dotColor, whiteSpace: 'nowrap' }}>
                {STATE_LABEL[session.state]}
              </span>
            )}
            <span style={{
              display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden',
              maxWidth: hov ? 40 : 0, opacity: hov ? 1 : 0,
              marginLeft: hov ? 6 : 0,
              transition: 'max-width .12s ease, opacity .1s, margin-left .12s ease',
              pointerEvents: hov ? 'auto' : 'none',
            }}>
              <button
                title="Kill session"
                onClick={(e) => { e.stopPropagation(); send({ type: 'killSession', worktreeId, index: session.index }); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 12, height: 12, border: 'none', background: 'transparent', color: T.textMuted,
                  cursor: 'pointer', padding: 0,
                }}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                  <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </span>
          </span>
        </div>
        {/* Line 2: live task subtitle (from the agent's terminal title) */}
        {session.title && (
          <span
            title={session.title}
            style={{
              fontSize: 11, color: T.textDim,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {session.title}
          </span>
        )}
      </div>
    </div>
  );
}

function IconActionBtn({ children, title, onClick, danger, narrow }: {
  children: React.ReactNode;
  title: string;
  onClick: React.MouseEventHandler;
  danger?: boolean;
  /** Half-width — visually attaches to the button on its left (split button). */
  narrow?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: narrow ? 13 : 22, height: 22, borderRadius: 4, border: 'none',
        background: hov ? (danger ? T.redBg : T.surface4) : 'transparent',
        color: danger ? (hov ? T.red : T.textMuted) : (hov ? T.textBody : T.textMuted),
        transition: 'background .1s, color .1s',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

