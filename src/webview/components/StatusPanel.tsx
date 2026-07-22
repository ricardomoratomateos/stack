import React, { useState } from 'react';
import { SECTION_TITLE_STYLE, T } from '../tokens';
import type { WorktreeItem } from '../types';

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
  return (
    <div style={{
      borderTop: `1px solid ${T.border}`,
      overflowY: 'auto',
      flexShrink: 0,
      maxHeight: '55%',
    }}>

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
        <Section label="Agents">
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
      <Section label="Git">
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
        <Section label="Pull Request">
          <Row k="Number">
            <Badge color={T.blue}>#{wt.pr.number}</Badge>
          </Row>
          <Row k="State">
            <Badge color={wt.pr.state === 'open' ? T.green : wt.pr.state === 'merged' ? T.purple : T.textMuted}>
              {wt.pr.state}
            </Badge>
          </Row>
        </Section>
      )}

      {/* Docker */}
      {wt.docker.length > 0 && (
        <Section label="Docker">
          {wt.docker.map((c) => (
            <DockerRow key={c.name} name={c.name} state={c.state} />
          ))}
        </Section>
      )}

    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${T.borderLight}` }}>
      <button
        onClick={() => setCollapsed(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 2,
          height: 22, padding: '0 12px 0 4px',
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
