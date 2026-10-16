import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildItems, buildSplit, fmt, gutterChars, splitPath,
  type FileEntry, type Line, type Side,
} from './model';
import { InlineLines, SplitScrollLines, SplitWrapLines, type CommentIndex } from './Lines';
import type { CommentActions } from './CommentCard';
import { Icon, type View, type Visibility } from './ui';

/** Rows drawn before "show more": a 20,000-line file should not be built in one go. */
const ROW_CHUNK = 1500;
/** Rough height of a row, for the placeholder that keeps the scrollbar honest before a file is built. */
const EST_ROW = 20;

export interface FocusReq {
  nonce: number;
  block: number;
}

export interface FileHandlers {
  actions: CommentActions;
  toggleOpen(file: FileEntry): void;
  toggleViewed(file: FileEntry): void;
  openInEditor(file: FileEntry): void;
  /** A line was clicked (or `c` was pressed on it): start a comment there. */
  line(file: FileEntry, line: Line, side?: Side): void;
  /** The pointer is over this line; it is where `c` will comment. */
  hover(file: FileEntry, line: Line, side?: Side): void;
  /** A hunk was scrolled to by n/p: put the cursor on its first changed line. */
  landed(file: FileEntry, line: Line, side: Side): void;
}

interface Props {
  file: FileEntry;
  view: View;
  wrap: boolean;
  open: boolean;
  viewed: boolean;
  comments: CommentIndex;
  commentCount: number;
  vis: Visibility | null;
  focusReq?: FocusReq;
  handlers: FileHandlers;
}

const STATUS_TITLE = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' } as const;

export const FileView = React.memo(function FileView(p: Props) {
  const { file, open, viewed, handlers } = p;
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const height = useRef(0);

  useEffect(() => {
    const el = root.current;
    if (!el || !p.vis) return;
    return p.vis.watch(el, (n) => {
      // Remember how tall it was, so the scrollbar does not jump when it is torn down.
      if (!n && body.current) height.current = body.current.offsetHeight;
      setNear(n);
    });
  }, [p.vis]);

  const { dir, name } = splitPath(file.path);
  const built = near || p.focusReq !== undefined;
  const placeholderHeight = height.current || Math.min(file.rowCount * EST_ROW, 4000);

  return (
    <section ref={root} className={`rv-file${open ? '' : ' is-closed'}${viewed ? ' is-viewed' : ''}`} id={`rv-f-${file.index}`} data-fi={file.index}>
      <header className="rv-fh">
        <button
          className="rv-fh-toggle rv-icon-btn"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${file.path}`}
          title={open ? 'Collapse file' : 'Expand file'}
          onClick={() => handlers.toggleOpen(file)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        <span className={`rv-st rv-st-${file.status}`} title={STATUS_TITLE[file.status]}>{file.status}</span>
        <button className="rv-fh-path" title={file.path} onClick={() => handlers.toggleOpen(file)}>
          {dir && <span className="rv-dir">{dir}</span>}
          <span className="rv-name">{name}</span>
        </button>
        {file.status === 'R' && file.oldPath !== file.path && (
          <span className="rv-from" title={`Renamed from ${file.oldPath}`}>
            <Icon name="arrow-left" /> {file.oldPath}
          </span>
        )}
        <span className="rv-counts" aria-label={`${file.added} added, ${file.deleted} removed`}>
          {file.added > 0 && <span className="rv-add-n">+{fmt(file.added)}</span>}
          {file.deleted > 0 && <span className="rv-del-n">−{fmt(file.deleted)}</span>}
        </span>
        <span className="rv-spacer" />
        {p.commentCount > 0 && (
          <span className="rv-cbadge" title={`${p.commentCount} comment${p.commentCount === 1 ? '' : 's'} on this file`}>
            <Icon name="comment" /> {p.commentCount}
          </span>
        )}
        {file.status !== 'D' && (
          <button className="rv-icon-btn" title="Open file in editor" aria-label="Open file in editor" onClick={() => handlers.openInEditor(file)}>
            <Icon name="go-to-file" />
          </button>
        )}
        <label className="rv-viewed" title="Mark as viewed and collapse (v)">
          <input type="checkbox" checked={viewed} onChange={() => handlers.toggleViewed(file)} />
          <span>Viewed</span>
        </label>
      </header>

      {open && (
        <div ref={body} className="rv-fb">
          {file.binary ? (
            <Note icon="file-binary">Binary file not shown.</Note>
          ) : file.blocks.length === 0 ? (
            <Note icon="info">{file.status === 'R' ? 'Renamed without changes to the content.' : 'No content changes (mode or metadata only).'}</Note>
          ) : built ? (
            <FileBody {...p} />
          ) : (
            <div className="rv-skeleton" style={{ minHeight: placeholderHeight }} aria-hidden="true" />
          )}
        </div>
      )}
      {!open && file.heavy && !viewed && (
        <div className="rv-note rv-note-heavy">
          <Icon name={file.heavy === 'generated' ? 'gear' : 'warning'} />
          <span>
            {file.heavy === 'generated' ? 'Generated file' : 'Large file'} · {fmt(file.added + file.deleted)} changed lines, collapsed to keep the review fast.
          </span>
          <button className="rv-btn" onClick={() => handlers.toggleOpen(file)}>Show diff</button>
        </div>
      )}
    </section>
  );
});

function Note({ icon, children }: { icon: string; children: React.ReactNode }) {
  return <div className="rv-note"><Icon name={icon} /><span>{children}</span></div>;
}

/** The rows of one file. Built only while the file is near the viewport. */
function FileBody({ file, view, wrap, comments, focusReq, handlers }: Props) {
  const rootEl = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildItems(file), [file]);
  const split = useMemo(() => (view === 'split' ? buildSplit(items) : null), [items, view]);
  const [limit, setLimit] = useState(ROW_CHUNK);
  const lastHover = useRef('');
  const handled = useRef(0);

  const total = split ? split.length : items.length;
  const shownItems = useMemo(() => (items.length > limit ? items.slice(0, limit) : items), [items, limit]);
  const shownSplit = useMemo(() => (split && split.length > limit ? split.slice(0, limit) : split), [split, limit]);

  /** The line (and the half of a split row) a pointer event landed on. */
  const resolve = useCallback((target: HTMLElement): { line: Line; side?: Side } | undefined => {
    const rowEl = target.closest<HTMLElement>('[data-r]');
    if (!rowEl) return undefined;
    const r = Number(rowEl.dataset.r);
    if (split) {
      const row = split[r];
      if (!row || row.kind !== 'pair') return undefined;
      const side = (target.closest<HTMLElement>('[data-s]')?.dataset.s ?? rowEl.dataset.s) as Side | undefined;
      const line = side === 'old' ? row.left : side === 'new' ? row.right : undefined;
      return line && side ? { line, side } : undefined;
    }
    const it = items[r];
    return it && it.kind === 'line' ? { line: it.line } : undefined;
  }, [items, split]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('.rv-cm, button, a')) return;
    // Dragging to select code ends in a click; that is not a request for a comment.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = resolve(t);
    if (hit) handlers.line(file, hit.line, hit.side);
  };

  const onOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('.rv-cm')) return;
    const rowEl = t.closest<HTMLElement>('[data-r]');
    if (!rowEl) return;
    const id = `${rowEl.dataset.r}:${t.closest<HTMLElement>('[data-s]')?.dataset.s ?? ''}`;
    if (id === lastHover.current) return;
    lastHover.current = id;
    const hit = resolve(t);
    if (hit) handlers.hover(file, hit.line, hit.side);
  };

  // n/p asked for one of this file's hunks: bring it into view and put the cursor on its first change.
  useLayoutEffect(() => {
    if (!focusReq || handled.current === focusReq.nonce) return;
    handled.current = focusReq.nonce;
    const el = rootEl.current?.querySelector<HTMLElement>(`[data-h="${focusReq.block}"]`);
    el?.scrollIntoView({ block: 'start' });
    const first = items.find((it) => it.kind === 'line' && it.block === focusReq.block && it.line.kind !== 'ctx');
    if (first && first.kind === 'line') handlers.landed(file, first.line, first.line.kind === 'del' ? 'old' : 'new');
  }, [focusReq, items, file, handlers]);

  const hidden = total - limit;
  const lnw = gutterChars(file);

  return (
    <div
      ref={rootEl}
      className={`rv-body${wrap ? ' is-wrap' : ''}`}
      style={{ '--lnw': `calc(${lnw}ch + 22px)` } as React.CSSProperties}
      onClick={onClick}
      onMouseOver={onOver}
    >
      {!split ? (
        <div className="rv-pane"><InlineLines items={shownItems} comments={comments} actions={handlers.actions} /></div>
      ) : wrap ? (
        <div className="rv-pane"><SplitWrapLines rows={shownSplit ?? []} comments={comments} actions={handlers.actions} /></div>
      ) : (
        <SplitScrollLines rows={shownSplit ?? []} comments={comments} actions={handlers.actions} />
      )}
      {hidden > 0 && (
        <div className="rv-more">
          <button className="rv-btn" onClick={() => setLimit((n) => n + ROW_CHUNK * 2)}>
            Show {fmt(Math.min(hidden, ROW_CHUNK * 2))} more of {fmt(hidden)} remaining rows
          </button>
        </div>
      )}
    </div>
  );
}
