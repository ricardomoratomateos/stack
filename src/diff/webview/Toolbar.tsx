import React from 'react';
import { fmt } from './model';
import { Icon, Kbd, MOD, type View } from './ui';
import type { DiffBase } from '../types';

interface SegOption<T extends string> { value: T; label: string; icon: string; title: string }

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: SegOption<T>[]; onChange(v: T): void;
}) {
  return (
    <div className="rv-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-on' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          <Icon name={o.icon} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const BASES: SegOption<DiffBase>[] = [
  { value: 'branch', label: 'Branch', icon: 'git-branch', title: 'Everything this branch changed since it left main' },
  { value: 'working', label: 'Working', icon: 'edit', title: 'Uncommitted and untracked changes against HEAD' },
];
const VIEWS: SegOption<View>[] = [
  { value: 'inline', label: 'Inline', icon: 'list-flat', title: 'One column, removals above additions' },
  { value: 'split', label: 'Split', icon: 'split-horizontal', title: 'Old and new side by side' },
];

interface Props {
  label: string;
  base: DiffBase;
  onBase(b: DiffBase): void;
  view: View;
  onView(v: View): void;
  wrap: boolean;
  onWrap(w: boolean): void;
  hasFiles: boolean;
  treeOpen: boolean;
  onTree(): void;
  files: number;
  added: number;
  deleted: number;
  refreshing: boolean;
  onRefresh(): void;
  ready: number;
  onSend(): void;
  onHelp(): void;
}

export function Toolbar(p: Props) {
  return (
    <div className="rv-toolbar" role="toolbar" aria-label="Review">
      {p.hasFiles && (
        <button
          className="rv-icon-btn"
          aria-pressed={p.treeOpen}
          title={p.treeOpen ? 'Hide file list' : 'Show file list'}
          aria-label={p.treeOpen ? 'Hide file list' : 'Show file list'}
          onClick={p.onTree}
        >
          <Icon name="list-tree" />
        </button>
      )}
      <div className="rv-title">
        <span className="rv-title-main">Review</span>
        {p.label && <span className="rv-title-label" title={p.label}>{p.label}</span>}
      </div>
      <Segmented label="Compare against" value={p.base} options={BASES} onChange={p.onBase} />
      <Segmented label="Diff layout" value={p.view} options={VIEWS} onChange={p.onView} />
      <button
        className={`rv-tgl${p.wrap ? ' is-on' : ''}`}
        aria-pressed={p.wrap}
        title="Wrap long lines instead of scrolling sideways"
        onClick={() => p.onWrap(!p.wrap)}
      >
        <Icon name="word-wrap" />
        <span>Wrap</span>
      </button>
      <span className="rv-spacer" />
      {p.hasFiles && (
        <span className="rv-summary" aria-label={`${p.files} files, ${p.added} added, ${p.deleted} removed`}>
          <span>{fmt(p.files)} file{p.files === 1 ? '' : 's'}</span>
          <span className="rv-dot">·</span>
          <span className="rv-add-n">+{fmt(p.added)}</span>
          <span className="rv-del-n">−{fmt(p.deleted)}</span>
        </span>
      )}
      <button className="rv-icon-btn" title="Refresh the diff" aria-label="Refresh the diff" disabled={p.refreshing} onClick={p.onRefresh}>
        <Icon name="refresh" className={p.refreshing ? 'rv-spin' : undefined} />
      </button>
      <button className="rv-icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={p.onHelp}>
        <Icon name="keyboard" />
      </button>
      <button
        className="rv-send"
        disabled={p.ready === 0}
        title={p.ready === 0 ? 'Click a line to leave a comment, then send them all to an agent' : undefined}
        onClick={p.onSend}
      >
        <Icon name="send" />
        <span>{p.ready === 0 ? 'Send to agent' : `Send ${p.ready} comment${p.ready === 1 ? '' : 's'} to agent`}</span>
        {p.ready > 0 && <Kbd>{MOD}↵</Kbd>}
      </button>
    </div>
  );
}

export function ShortcutsHelp({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['j  k', 'Next / previous file'],
    ['n  p', 'Next / previous change'],
    ['c', 'Comment on the line under the pointer or cursor'],
    ['v', 'Mark the current file viewed'],
    ['/', 'Filter files'],
    [`${MOD} ↵`, 'Add comment in the box, otherwise send comments'],
    ['Esc', 'Cancel a comment or close this'],
  ];
  return (
    <div className="rv-pop" role="dialog" aria-label="Keyboard shortcuts">
      <div className="rv-pop-head">
        <strong>Keyboard shortcuts</strong>
        <button className="rv-icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <dl>
        {rows.map(([k, d]) => (
          <React.Fragment key={k}>
            <dt>{k.split('  ').map((x) => <Kbd key={x}>{x}</Kbd>)}</dt>
            <dd>{d}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}
