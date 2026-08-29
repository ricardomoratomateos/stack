import React, { useEffect, useRef, useState } from 'react';
import { T } from '../../webview/tokens';
import { send } from './vscode';
import type { NewTaskExtMessage, NewTaskInit } from '../types';

export function NewTaskPanel() {
  const [init, setInit] = useState<NewTaskInit>({ branches: [], baseBranch: '' });
  const [title, setTitle] = useState('');
  const [branchName, setBranchName] = useState('');
  const [base, setBase] = useState('');
  const [description, setDescription] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Announce readiness only after the listener is attached, so the init reply
  // (branches + base) can't be missed — same handshake the sidebar uses.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as NewTaskExtMessage;
      if (msg.type === 'init') {
        setInit(msg.init);
        setBase((b) => b || msg.init.baseBranch);
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'ready' });
    titleRef.current?.focus();
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); send({ type: 'cancel' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const canSubmit = !!(title.trim() || description.trim() || branchName.trim());

  const handleSubmit = () => {
    const b = branchName.trim() || slugify(title) || slugify(description);
    if (!b) return;
    send({
      type: 'create',
      branch: b,
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      baseBranch: base || undefined,
    });
  };

  const onTextKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit();
  };

  // Keep the selected base representable even before the list arrives.
  const baseOptions = [...new Set([...(base ? [base] : []), ...init.branches])];
  if (baseOptions.length === 0) baseOptions.push('main');

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center',
      background: 'var(--vscode-editor-background)',
    }}>
      <div style={{
        width: '100%', maxWidth: 860, height: '100%',
        display: 'flex', flexDirection: 'column',
        padding: '32px 32px 24px', gap: 16,
      }}>
        {/* Header: title + which branch it's cut from */}
        <div>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New agent"
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              fontFamily: T.sans, fontSize: 26, fontWeight: 700, color: T.textStrong,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>from</span>
              <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <select
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  title="Branch the new one is created from"
                  style={{
                    appearance: 'none', WebkitAppearance: 'none',
                    padding: '3px 20px 3px 8px',
                    border: `1px solid ${T.border}`, borderRadius: 6, background: T.surface2,
                    fontFamily: T.mono, fontSize: 12, color: T.textDim, outline: 'none', cursor: 'pointer',
                    maxWidth: 360, textOverflow: 'ellipsis',
                  }}
                >
                  {baseOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <i className="codicon codicon-chevron-down" style={{
                  position: 'absolute', right: 5, fontSize: 12, color: T.textMuted, pointerEvents: 'none',
                }} />
              </span>
            </span>
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="branch-name (auto if empty)"
              style={{
                flex: 1, minWidth: 200,
                background: 'transparent', border: 'none', borderBottom: `1px solid ${T.border}`,
                outline: 'none', padding: '3px 2px',
                fontFamily: T.mono, fontSize: 12, color: T.textMuted,
              }}
            />
          </div>
        </div>

        {/* The reason this panel exists: a prompt area with room to think. */}
        <textarea
          ref={textRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onTextKey}
          placeholder="Describe the task for the agent…  ⌘↵ to create"
          style={{
            flex: 1, width: '100%', resize: 'none',
            background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 10,
            outline: 'none', padding: '18px 20px',
            fontFamily: T.sans, fontSize: 15, color: T.textBody, lineHeight: 1.65,
          }}
        />

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
            ⌘↵ create · Esc cancel
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => send({ type: 'cancel' })}
            style={{
              padding: '7px 16px', borderRadius: 6, border: `1px solid ${T.border}`,
              background: 'transparent', color: T.textDim, fontFamily: T.sans, fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: '7px 20px', borderRadius: 6, border: 'none',
              background: canSubmit ? T.accent : T.surface4,
              color: canSubmit ? T.accentInk : T.textMuted,
              fontFamily: T.sans, fontSize: 13, fontWeight: 500,
              cursor: canSubmit ? 'pointer' : 'default',
              transition: 'background .12s, color .12s',
            }}
          >
            Create worktree
          </button>
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: T.textMuted }}>
          Creates a new branch, git worktree, and launches the agent
        </p>
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}
