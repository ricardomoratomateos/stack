import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, Kbd, MOD, useHeight, type ReviewComment } from './ui';

export interface CommentActions {
  change(id: number, body: string): void;
  /** Close the box and keep the text. */
  commit(id: number): void;
  /** Close the box and drop what was typed since it opened (a never-saved comment goes away). */
  cancel(id: number): void;
  edit(id: number): void;
  remove(id: number): void;
  open(file: string, line?: number): void;
}

interface Props {
  comment: ReviewComment;
  actions: CommentActions;
  /** Split view reports each card's height so the other half can leave the same gap. */
  onHeight?: (id: number, h: number) => void;
}

/** A review comment, in the line it belongs to: a box while it is typed, a card once it is added. */
export const CommentCard = React.memo(function CommentCard({ comment: c, actions, onHeight }: Props) {
  const report = useCallback((h: number) => onHeight?.(c.id, h), [onHeight, c.id]);
  const ref = useHeight(onHeight ? report : undefined);
  const loc = `${c.file}${c.line !== undefined ? `:${c.line}` : ''}`;

  return (
    <div className="rv-cm" ref={ref}>
      <div className={`rv-card${c.editing ? ' is-editing' : ''}`} role="group" aria-label={`Comment on ${loc}`}>
        <div className="rv-card-head">
          <button className="rv-card-loc" title="Open in editor" onClick={() => actions.open(c.file, c.line)}>
            <Icon name="comment" />
            <span className="rv-card-path">{c.file}</span>
            {c.line !== undefined && <span className="rv-card-line">:{c.line}</span>}
          </button>
          {c.side === 'old' && <span className="rv-tag" title="This line is in the old file, before the change">before</span>}
          <span className="rv-spacer" />
          {!c.editing && <CardButtons comment={c} actions={actions} />}
        </div>
        {c.editing ? <Composer comment={c} actions={actions} /> : <div className="rv-card-body">{c.body}</div>}
      </div>
    </div>
  );
});

function CardButtons({ comment: c, actions }: { comment: ReviewComment; actions: CommentActions }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <span className="rv-card-actions">
      <button className="rv-icon-btn" title="Edit comment" aria-label="Edit comment" onClick={() => actions.edit(c.id)}>
        <Icon name="edit" />
      </button>
      {confirming ? (
        <button className="rv-confirm" onClick={() => actions.remove(c.id)} onBlur={() => setConfirming(false)} autoFocus>
          Delete?
        </button>
      ) : (
        <button className="rv-icon-btn rv-danger" title="Delete comment" aria-label="Delete comment" onClick={() => setConfirming(true)}>
          <Icon name="trash" />
        </button>
      )}
    </span>
  );
}

function Composer({ comment: c, actions }: { comment: ReviewComment; actions: CommentActions }) {
  const area = useRef<HTMLTextAreaElement>(null);

  // Grow with the text instead of scrolling inside a tiny box.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [c.body]);

  useEffect(() => { area.current?.focus(); }, []);

  const empty = c.body.trim().length === 0;
  const add = () => { if (!empty) actions.commit(c.id); };

  return (
    <>
      <textarea
        ref={area}
        className="rv-input"
        value={c.body}
        rows={2}
        placeholder="Tell the agent what to change here…"
        aria-label={`Comment on ${c.file}${c.line !== undefined ? ` line ${c.line}` : ''}`}
        onChange={(e) => actions.change(c.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); add(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); actions.cancel(c.id); }
        }}
      />
      <div className="rv-card-foot">
        <span className="rv-hint"><Kbd>{MOD}↵</Kbd> add <span className="rv-dot">·</span> <Kbd>Esc</Kbd> cancel</span>
        <span className="rv-spacer" />
        <button className="rv-btn" onClick={() => actions.cancel(c.id)}>Cancel</button>
        <button className="rv-btn rv-btn-primary" disabled={empty} onClick={add}>Add comment</button>
      </div>
    </>
  );
}
