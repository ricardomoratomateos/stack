import React, { useCallback, useState } from 'react';
import { anchorKey, anchorKeys, type HunkItem, type Item, type Line, type SplitRow, type Span } from './model';
import { CommentCard, type CommentActions } from './CommentCard';
import type { ReviewComment } from './ui';

/** Comments by the anchor (`old:12` / `new:14`) they hang on. */
export type CommentIndex = ReadonlyMap<string, ReviewComment[]>;

const SIGN = { add: '+', del: '−', ctx: '' } as const;

/** The code of a line, with the words that changed picked out. */
function Code({ text, marks }: { text: string; marks?: Span[] }) {
  if (!marks || marks.length === 0) return <>{text || ' '}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach((m, i) => {
    if (m.s > at) out.push(text.slice(at, m.s));
    out.push(<span key={i} className="rv-w">{text.slice(m.s, m.e)}</span>);
    at = m.e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function HunkHeader({ hunk }: { hunk: HunkItem }) {
  return (
    <div className="rv-hunk" data-h={hunk.block}>
      <span className="rv-hunk-in">
        <span className="rv-hunk-range">{hunk.range}</span>
        {hunk.context && <span className="rv-hunk-ctx">{hunk.context}</span>}
      </span>
    </div>
  );
}

function Cards({ list, actions, onHeight }: { list: ReviewComment[] | undefined; actions: CommentActions; onHeight?: (id: number, h: number) => void }) {
  if (!list) return null;
  return <>{list.map((c) => <CommentCard key={c.id} comment={c} actions={actions} onHeight={onHeight} />)}</>;
}

/** Comments that hang on any of the row's anchors, once each, in order. */
function commentsFor(index: CommentIndex, keys: string[]): ReviewComment[] | undefined {
  if (index.size === 0) return undefined;
  let found: ReviewComment[] | undefined;
  for (const k of keys) {
    const list = index.get(k);
    if (list) found = found ? [...found, ...list] : list;
  }
  return found;
}

const has = (index: CommentIndex, keys: string[]) => index.size > 0 && keys.some((k) => index.has(k));

// ── Inline ───────────────────────────────────────────────────────────────────

const InlineRow = React.memo(function InlineRow({ line, r, commented }: { line: Line; r: number; commented: boolean }) {
  return (
    <div className={`rv-row rv-${line.kind}${commented ? ' has-cm' : ''}`} data-r={r} data-a={anchorKeys(line).join(' ')}>
      <span className={`rv-ln rv-ln-1${line.kind === 'del' ? ' rv-plus' : ''}`} aria-hidden="true">{line.oldNo}</span>
      <span className={`rv-ln rv-ln-2${line.kind === 'del' ? '' : ' rv-plus'}`} aria-hidden="true">{line.newNo}</span>
      <span className="rv-code" data-sign={SIGN[line.kind]}><Code text={line.text} marks={line.marks} /></span>
    </div>
  );
});

export function InlineLines({ items, comments, actions }: { items: Item[]; comments: CommentIndex; actions: CommentActions }) {
  return (
    <div className="rv-lines">
      {items.map((it, r) => {
        if (it.kind === 'hunk') return <HunkHeader key={r} hunk={it} />;
        const keys = anchorKeys(it.line);
        return (
          <React.Fragment key={r}>
            <InlineRow line={it.line} r={r} commented={has(comments, keys)} />
            <Cards list={commentsFor(comments, keys)} actions={actions} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Split, wrapping: one row holds both halves so they always line up ─────────

function Half({ line, side, commented }: { line?: Line; side: 'old' | 'new'; commented: boolean }) {
  if (!line) return <><span className="rv-ln rv-empty" aria-hidden="true" /><span className="rv-code rv-empty" /></>;
  const n = side === 'old' ? line.oldNo : line.newNo;
  const kind = line.kind;
  return (
    <>
      <span className={`rv-ln rv-plus rv-${kind}${commented ? ' has-cm' : ''}`} data-s={side} aria-hidden="true">{n}</span>
      <span className={`rv-code rv-${kind}`} data-s={side} data-sign={SIGN[kind]}><Code text={line.text} marks={line.marks} /></span>
    </>
  );
}

const SplitPair = React.memo(function SplitPair({ left, right, r, lc, rc }: { left?: Line; right?: Line; r: number; lc: boolean; rc: boolean }) {
  const keys = [...(left ? [anchorKey('old', left.oldNo ?? 0)] : []), ...(right ? [anchorKey('new', right.newNo ?? 0)] : [])];
  return (
    <div className="rv-row rv-pair" data-r={r} data-a={keys.join(' ')}>
      <Half line={left} side="old" commented={lc} />
      <Half line={right} side="new" commented={rc} />
    </div>
  );
});

const leftKey = (l?: Line) => (l && l.oldNo !== undefined ? anchorKey('old', l.oldNo) : undefined);
const rightKey = (l?: Line) => (l && l.newNo !== undefined ? anchorKey('new', l.newNo) : undefined);
const list = (idx: CommentIndex, k?: string) => (k ? idx.get(k) : undefined);

export function SplitWrapLines({ rows, comments, actions }: { rows: SplitRow[]; comments: CommentIndex; actions: CommentActions }) {
  return (
    <div className="rv-lines rv-split-wrap">
      {rows.map((row, r) => {
        if (row.kind === 'hunk') return <HunkHeader key={r} hunk={row.hunk} />;
        const L = list(comments, leftKey(row.left));
        const R = list(comments, rightKey(row.right));
        return (
          <React.Fragment key={r}>
            <SplitPair left={row.left} right={row.right} r={r} lc={!!L} rc={!!R} />
            {(L || R) && (
              <div className="rv-pair-cm">
                <div className="rv-pair-half"><Cards list={L} actions={actions} /></div>
                <div className="rv-pair-half"><Cards list={R} actions={actions} /></div>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Split, scrolling: each side is its own scroller; a card on one side gets an empty twin ──

const SideRow = React.memo(function SideRow({ line, side, r, commented }: { line?: Line; side: 'old' | 'new'; r: number; commented: boolean }) {
  if (!line) return <div className="rv-row rv-empty-row" data-r={r} data-s={side}><span className="rv-ln rv-empty" /><span className="rv-code rv-empty" /></div>;
  const n = side === 'old' ? line.oldNo : line.newNo;
  const k = side === 'old' ? leftKey(line) : rightKey(line);
  return (
    <div className={`rv-row rv-${line.kind}${commented ? ' has-cm' : ''}`} data-r={r} data-s={side} data-a={k}>
      <span className="rv-ln rv-plus" aria-hidden="true">{n}</span>
      <span className="rv-code" data-sign={SIGN[line.kind]}><Code text={line.text} marks={line.marks} /></span>
    </div>
  );
});

export function SplitScrollLines({ rows, comments, actions }: { rows: SplitRow[]; comments: CommentIndex; actions: CommentActions }) {
  const [heights, setHeights] = useState<Record<number, number>>({});
  const onHeight = useCallback((id: number, h: number) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);
  const total = (l?: ReviewComment[]) => (l ? l.reduce((n, c) => n + (heights[c.id] ?? 0), 0) : 0);

  const pane = (side: 'old' | 'new') => (
    <div className="rv-pane" data-pane={side}>
      <div className="rv-lines">
        {rows.map((row, r) => {
          if (row.kind === 'hunk') {
            return side === 'old'
              ? <HunkHeader key={r} hunk={row.hunk} />
              : <div key={r} className="rv-hunk" data-h={row.hunk.block} />;
          }
          const mine = side === 'old' ? row.left : row.right;
          const L = list(comments, leftKey(row.left));
          const R = list(comments, rightKey(row.right));
          const own = side === 'old' ? L : R;
          const other = side === 'old' ? R : L;
          const gap = Math.max(0, total(other) - total(own));
          return (
            <React.Fragment key={r}>
              <SideRow line={mine} side={side} r={r} commented={!!own} />
              {(L || R) && (
                <>
                  <Cards list={own} actions={actions} onHeight={onHeight} />
                  {gap > 0 && <div className="rv-filler" style={{ height: gap }} />}
                </>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );

  return <div className="rv-split">{pane('old')}{pane('new')}</div>;
}
