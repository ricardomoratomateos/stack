import React, { useEffect, useRef, useState } from 'react';
import { T } from '../tokens';
import { send } from '../vscode';

interface Props {
  branch?: string;
  onClose: () => void;
}

export function NewTaskModal({ branch, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branchName, setBranchName] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Focus the title input once, on mount only. Keeping this out of the
  // keydown effect below prevents App re-renders (which recreate `onClose`)
  // from yanking focus back while you type.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    // Capture-phase handler: blocks VSCode from intercepting keystrokes while modal is open
    const capture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      e.stopPropagation();
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [onClose]);

  const handleSubmit = () => {
    const b = branchName.trim() || slugify(title) || slugify(description);
    if (!b) return;
    send({
      type: 'createWorktree',
      branch: b,
      title: title.trim() || undefined,
      description: description.trim() || undefined,
    });
    onClose();
  };

  const onTextKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit();
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div style={{ width: '100%', maxWidth: 560, animation: 'unmess-fadein .15s ease' }}>

        {/* Context row */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, padding: '0 2px' }}>
          <Chip label={branch ?? 'main'} mono />
        </div>

        {/* Card */}
        <div style={{
          background: T.surface2,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          {/* Title (worktree name) */}
          <div style={{ borderBottom: `1px solid ${T.border}`, padding: '10px 16px' }}>
            <input
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') branchRef.current?.focus(); }}
              placeholder="Title (worktree name)"
              style={{
                width: '100%', background: 'transparent', border: 'none', outline: 'none',
                fontFamily: T.sans, fontSize: T.fontSize, fontWeight: 600, color: T.textStrong,
              }}
            />
          </div>

          {/* Branch name */}
          <div style={{ borderBottom: `1px solid ${T.border}`, padding: '10px 16px' }}>
            <input
              ref={branchRef}
              value={branchName}
              onChange={e => setBranchName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') textRef.current?.focus(); }}
              placeholder="Branch name (auto-generated if empty)"
              style={{
                width: '100%', background: 'transparent', border: 'none', outline: 'none',
                fontFamily: T.mono, fontSize: 11, color: T.textMuted,
              }}
            />
          </div>

          {/* Description textarea */}
          <textarea
            ref={textRef}
            value={description}
            onChange={e => setDescription(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); onTextKey(e); }}
            placeholder="Describe la tarea… ⌘↵ para crear"
            rows={4}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              resize: 'none', padding: '14px 16px',
              fontFamily: T.sans, fontSize: T.fontSize, color: T.textBody, lineHeight: 1.6,
            }}
          />

          {/* Bottom bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px',
            borderTop: `1px solid ${T.border}`,
          }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              ⌘↵ create · Esc cancel
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={handleSubmit}
              style={{
                padding: '5px 16px', borderRadius: 2, border: 'none',
                background: title.trim() || description.trim() || branchName.trim() ? T.accent : T.surface4,
                color: title.trim() || description.trim() || branchName.trim() ? T.accentInk : T.textMuted,
                fontFamily: T.sans, fontSize: T.fontSize, fontWeight: 400,
                transition: 'background .12s, color .12s',
              }}
            >
              Create worktree
            </button>
          </div>
        </div>

        <p style={{
          textAlign: 'center', fontSize: 11, color: T.textMuted, marginTop: 12,
        }}>
          Creates a new branch, git worktree, and launches Claude
        </p>
      </div>
    </div>
  );
}

function Chip({ label, mono }: { label: string; mono?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999,
      border: `1px solid ${T.borderStrong}`, background: T.surface2,
      fontFamily: mono ? T.mono : T.sans, fontSize: 11, color: T.textBody,
    }}>
      {label}
    </span>
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
