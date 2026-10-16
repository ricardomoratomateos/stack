import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { send, loadState, saveState } from './vscode';
import type { DiffBase, DiffComment, SendDestination, DiffPanelExtMessage } from '../types';
import { DEFAULT_SIDEBAR_STYLE, normalizeSidebarStyle, type SidebarStyle } from '../../sidebarStyle';
import {
  anchorOf, filterReview, hasAnchor, prepareReview, type FileEntry, type Line, type Review, type Side,
} from './model';
import { FileView, type FileHandlers, type FocusReq } from './FileView';
import { FileTree } from './FileTree';
import { Toolbar, ShortcutsHelp } from './Toolbar';
import { SendDialog } from './SendDialog';
import type { CommentActions } from './CommentCard';
import type { CommentIndex } from './Lines';
import { Icon, Visibility, type ReviewComment, type View } from './ui';

const EMPTY_INDEX: CommentIndex = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_REVIEW: Review = prepareReview('');
const TREE_MIN = 200;
const TREE_MAX = 560;

interface Cursor { file: FileEntry; line: Line; side?: Side }

function sameList<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function DiffApp() {
  const saved = useMemo(loadState, []);
  const [style, setStyle] = useState<SidebarStyle>(DEFAULT_SIDEBAR_STYLE);
  const [base, setBase] = useState<DiffBase>('branch');
  const [view, setView] = useState<View>(saved.format ?? 'inline');
  const [wrap, setWrap] = useState(saved.wrap ?? false);
  const [treeOpen, setTreeOpen] = useState(saved.treeOpen ?? (typeof window === 'undefined' || window.innerWidth >= 780));
  const [treeWidth, setTreeWidth] = useState(saved.treeWidth ?? 288);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set(saved.collapsedDirs ?? []));
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set(saved.viewed ?? []));
  // signature -> the user's own choice for the file, over the default (open, unless viewed or heavy).
  const [openOverride, setOpenOverride] = useState<Readonly<Record<string, boolean>>>({});

  const [review, setReview] = useState<Review>(EMPTY_REVIEW);
  const [label, setLabel] = useState('');
  const [hasLiveAgent, setHasLiveAgent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [activePos, setActivePos] = useState(0);
  const [focus, setFocus] = useState<(FocusReq & { fileIndex: number }) | undefined>(undefined);
  const [dialog, setDialog] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [vis, setVis] = useState<Visibility | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const nonce = useRef(1);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cursor = useRef<Cursor | null>(null);
  const painted = useRef(false);

  // ── Derived ────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => filterReview(review, query), [review, query]);
  const shown = filtered.files;
  const ready = useMemo(() => comments.filter((c) => c.body.trim().length > 0), [comments]);

  // A file's comment index keeps its identity while that file's comments do not
  // change, so typing in one box rebuilds one file, not the whole review.
  const cache = useRef(new Map<string, { list: ReviewComment[]; index: CommentIndex }>());
  const indexes = useMemo(() => {
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const l = byFile.get(c.file);
      if (l) l.push(c); else byFile.set(c.file, [c]);
    }
    const next = new Map<string, { list: ReviewComment[]; index: CommentIndex }>();
    for (const [path, list] of byFile) {
      const prev = cache.current.get(path);
      if (prev && sameList(prev.list, list)) { next.set(path, prev); continue; }
      const index = new Map<string, ReviewComment[]>();
      for (const c of list) {
        if (c.line === undefined) continue;
        const k = `${c.side}:${c.line}`;
        const l = index.get(k);
        if (l) l.push(c); else index.set(k, [c]);
      }
      next.set(path, { list, index });
    }
    cache.current = next;
    return next;
  }, [comments]);
  const commentCounts = useMemo(() => new Map([...indexes].map(([p, v]) => [p, v.list.length])), [indexes]);

  const isOpen = useCallback((f: FileEntry) => openOverride[f.signature] ?? !(viewed.has(f.signature) || f.heavy), [openOverride, viewed]);

  // Handlers read the latest state through a ref so their identity never changes
  // and a keystroke in a comment box does not re-render every file.
  const latest = useRef({ comments, shown, isOpen, viewed, activePos, view, hasLiveAgent });
  latest.current = { comments, shown, isOpen, viewed, activePos, view, hasLiveAgent };

  // ── Extension messages ─────────────────────────────────────────────────────
  const flash = useCallback((text: string, ms = 4000) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as DiffPanelExtMessage;
      if (msg.type === 'style') {
        setStyle(normalizeSidebarStyle(msg.style));
      } else if (msg.type === 'diff') {
        // Parsed here, once; everything the UI shows is derived from this.
        const next = msg.error ? EMPTY_REVIEW : prepareReview(msg.unified);
        setReview(next);
        setDiffError(msg.error);
        setBase(msg.base);
        setHasLiveAgent(msg.hasLiveAgent);
        setLabel(msg.label);
        setLoading(false);
        setRefreshing(false);
        // Comments whose line is not in the new diff have nothing to point at.
        const before = latest.current.comments;
        const kept = before.filter((c) => hasAnchor(next, c.file, c.side, c.line));
        if (kept.length !== before.length) {
          setComments(kept);
          flash(`${before.length - kept.length} comment${before.length - kept.length === 1 ? '' : 's'} dropped: the line is not in this diff.`);
        }
      } else if (msg.type === 'sent') {
        setDialog(false);
        if (msg.ok) {
          setComments([]);
          flash(sentMessage(msg.destination, msg.fellBack === true));
        } else {
          flash('Nothing sent — no target available.');
        }
      } else if (msg.type === 'error') {
        flash(msg.message);
        setLoading(false);
        setRefreshing(false);
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'ready' });
    return () => { window.removeEventListener('message', handler); clearTimeout(toastTimer.current); };
  }, [flash]);

  // ── Lazy rendering: one observer rooted at the scroller ────────────────────
  useLayoutEffect(() => {
    if (!scroller.current) return;
    const v = new Visibility(scroller.current);
    setVis(v);
    return () => v.dispose();
  }, []);

  // ── Persist what should survive the panel being hidden ─────────────────────
  useEffect(() => {
    saveState({ format: view, wrap, treeOpen, treeWidth, collapsedDirs: [...collapsedDirs], viewed: [...viewed].slice(-4000) });
  }, [view, wrap, treeOpen, treeWidth, collapsedDirs, viewed]);

  // ── Scroll-spy: which file is at the top ───────────────────────────────────
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const els = stream.current?.children;
      if (!els || els.length === 0) return;
      const y = sc.scrollTop + 16;
      let lo = 0, hi = els.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((els[mid] as HTMLElement).offsetTop <= y) lo = mid; else hi = mid - 1;
      }
      setActivePos(lo);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => { sc.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  const requestDiff = useCallback((next: DiffBase, keepView = false) => {
    if (keepView) setRefreshing(true); else setLoading(true);
    send({ type: 'requestDiff', base: next });
  }, []);

  const goToFile = useCallback((pos: number) => {
    const { shown: list } = latest.current;
    const p = Math.max(0, Math.min(list.length - 1, pos));
    const el = stream.current?.children[p] as HTMLElement | undefined;
    if (!el || !scroller.current) return;
    scroller.current.scrollTo({ top: el.offsetTop - 1 });
    setActivePos(p);
  }, []);

  const paintCursor = useCallback((c: Cursor | null, visible: boolean) => {
    if (painted.current) {
      scroller.current?.querySelectorAll('.rv-cursor').forEach((n) => n.classList.remove('rv-cursor'));
      painted.current = false;
    }
    if (!c || !visible) return;
    painted.current = true;
    const a = anchorOf(c.line, c.side);
    if (!a) return;
    document.getElementById(`rv-f-${c.file.index}`)
      ?.querySelectorAll(`[data-a~="${a.side}:${a.line}"]`)
      .forEach((n) => n.classList.add('rv-cursor'));
  }, []);

  const startComment = useCallback((file: FileEntry, line: Line, side?: Side) => {
    const a = anchorOf(line, side);
    if (!a) return;
    cursor.current = { file, line, side };
    setComments((cs) => {
      const existing = cs.find((c) => c.file === file.path && c.side === a.side && c.line === a.line);
      // Never leave empty boxes behind: they are what a stray click produces.
      const base = cs.filter((c) => !(c.editing && c.prev === undefined && c.body.trim() === '' && c !== existing));
      if (existing) {
        return base.map((c) => (c === existing && !c.editing ? { ...c, editing: true, prev: c.body } : c));
      }
      return [...base, { id: nextId.current++, file: file.path, ...(file.status === 'R' && file.oldPath !== file.path ? { renamedFrom: file.oldPath } : {}), side: a.side, line: a.line, code: line.text, body: '', editing: true }];
    });
  }, []);

  const actions = useMemo<CommentActions>(() => ({
    change: (id, body) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c))),
    commit: (id) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, editing: false, prev: undefined } : c))),
    cancel: (id) => setComments((cs) => cs.flatMap((c) => {
      if (c.id !== id) return [c];
      return c.prev === undefined ? [] : [{ ...c, body: c.prev, editing: false, prev: undefined }];
    })),
    edit: (id) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, editing: true, prev: c.body } : c))),
    remove: (id) => setComments((cs) => cs.filter((c) => c.id !== id)),
    open: (file, line) => send({ type: 'openFile', path: file, line }),
  }), []);

  const handlers = useMemo<FileHandlers>(() => ({
    actions,
    toggleOpen: (f) => setOpenOverride((o) => {
      const cur = o[f.signature] ?? !(latest.current.viewed.has(f.signature) || f.heavy);
      return { ...o, [f.signature]: !cur };
    }),
    toggleViewed: (f) => {
      setViewed((v) => {
        const n = new Set(v);
        if (n.has(f.signature)) n.delete(f.signature); else n.add(f.signature);
        return n;
      });
      // Viewing (or un-viewing) decides again whether it is open.
      setOpenOverride((o) => {
        if (!(f.signature in o)) return o;
        const { [f.signature]: _gone, ...rest } = o;
        return rest;
      });
    },
    openInEditor: (f) => send({ type: 'openFile', path: f.path }),
    line: startComment,
    hover: (file, line, side) => { cursor.current = { file, line, side }; paintCursor(null, false); },
    landed: (file, line, side) => { cursor.current = { file, line, side }; paintCursor(cursor.current, true); },
  }), [actions, startComment, paintCursor]);

  /** The hunk the viewport is "in": the last header at or above the top of the file in view, or -1 above the first. */
  const currentHunk = useCallback((pos: number): { block: number; atTop: boolean } => {
    const sc = scroller.current;
    const el = stream.current?.children[pos];
    if (!sc || !el) return { block: -1, atTop: false };
    // Headers land 44px under the scroller's top (below the sticky file header) when n/p scroll to them.
    const line = sc.getBoundingClientRect().top + 44;
    let block = -1;
    let atTop = false;
    const seen = new Set<string>();
    el.querySelectorAll<HTMLElement>('[data-h]').forEach((h) => {
      const id = h.dataset.h ?? '';
      if (seen.has(id)) return; // split view has one per pane
      seen.add(id);
      const top = h.getBoundingClientRect().top;
      if (top <= line + 8) { block = Number(id); atTop = Math.abs(top - line) <= 8; }
    });
    return { block, atTop };
  }, []);

  const moveHunk = useCallback((dir: 1 | -1) => {
    const { shown: list, isOpen: open, activePos: pos } = latest.current;
    const cur = currentHunk(pos);
    // Going back from the middle of a hunk goes to its start; from its start, to the one before.
    let b = dir === 1 ? cur.block + 1 : cur.atTop ? cur.block - 1 : Math.max(cur.block, 0) - (cur.block < 0 ? 1 : 0);
    let p = pos;
    for (;;) {
      const f = list[p];
      if (!f) return;
      if (open(f) && !f.binary && b >= 0 && b < f.blocks.length) break;
      p += dir;
      const nf = list[p];
      if (!nf) return;
      b = dir === 1 ? 0 : nf.blocks.length - 1;
    }
    setActivePos(p);
    setFocus({ fileIndex: list[p].index, block: b, nonce: nonce.current++ });
  }, [currentHunk]);

  const toggleDir = useCallback((id: string) => {
    setCollapsedDirs((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const doSend = useCallback((destination: SendDestination) => {
    const payload: DiffComment[] = latest.current.comments
      .filter((c) => c.body.trim().length > 0)
      .map(({ file, renamedFrom, side, line, code, body }) => ({ file, renamedFrom, side, line, code, body }));
    send({ type: 'send', destination, comments: payload });
  }, []);

  const readyCount = ready.length;
  const requestSend = useCallback(() => { if (readyCount > 0) setDialog(true); }, [readyCount]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inText = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (dialog) setDialog(false); else if (help) setHelp(false);
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (t?.tagName === 'TEXTAREA' || dialog) return;
        e.preventDefault();
        requestSend();
        return;
      }
      if (inText || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      const { shown: list, activePos: pos } = latest.current;
      switch (e.key) {
        case 'j': goToFile(pos + 1); break;
        case 'k': goToFile(pos - 1); break;
        case 'n': moveHunk(1); break;
        case 'p': moveHunk(-1); break;
        case 'c': if (cursor.current) startComment(cursor.current.file, cursor.current.line, cursor.current.side); break;
        case 'v': if (list[pos]) handlers.toggleViewed(list[pos]); break;
        case '/': e.preventDefault(); setTreeOpen(true); setTimeout(() => filterInput.current?.focus(), 0); break;
        case '?': setHelp((h) => !h); break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, help, goToFile, moveHunk, startComment, handlers, requestSend]);

  // ── Resizing the file tree ─────────────────────────────────────────────────
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    const move = (ev: PointerEvent) => setTreeWidth(Math.max(TREE_MIN, Math.min(TREE_MAX, startW + ev.clientX - startX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hasFiles = review.files.length > 0;
  const activeIndex = shown[Math.min(activePos, shown.length - 1)]?.index ?? -1;

  const pickFile = useCallback((f: FileEntry) => {
    const pos = latest.current.shown.findIndex((x) => x.index === f.index);
    if (pos >= 0) goToFile(pos);
  }, [goToFile]);

  return (
    <div className="rv-root" data-style={style}>
      <Toolbar
        label={label}
        base={base}
        onBase={(b) => b !== base && requestDiff(b)}
        view={view}
        onView={setView}
        wrap={wrap}
        onWrap={setWrap}
        hasFiles={hasFiles}
        treeOpen={treeOpen}
        onTree={() => setTreeOpen((v) => !v)}
        files={review.files.length}
        added={review.added}
        deleted={review.deleted}
        refreshing={refreshing}
        onRefresh={() => requestDiff(base, true)}
        ready={readyCount}
        onSend={requestSend}
        onHelp={() => setHelp((h) => !h)}
      />

      <div className="rv-main">
        {hasFiles && treeOpen && (
          <>
            <div className="rv-side" style={{ width: treeWidth }}>
              <FileTree
                tree={filtered.tree}
                total={review.files.length}
                shown={shown.length}
                query={query}
                onQuery={setQuery}
                collapsed={collapsedDirs}
                onToggleDir={toggleDir}
                activeIndex={activeIndex}
                viewed={viewed.size ? viewed : EMPTY_SET}
                commentCounts={commentCounts}
                onPick={pickFile}
                filterRef={filterInput}
              />
            </div>
            <div className="rv-resizer" role="separator" aria-orientation="vertical" aria-label="Resize file list" onPointerDown={startResize} />
          </>
        )}

        <div className="rv-scroll" ref={scroller} tabIndex={-1}>
          {loading ? (
            <Loading />
          ) : diffError ? (
            <State icon="error" title={`Couldn't compute the diff: ${diffError}`}>
              <button className="rv-btn" onClick={() => requestDiff(base)}>Try again</button>
            </State>
          ) : !hasFiles ? (
            <State icon="check-all" title={`No changes to review on this ${base === 'branch' ? 'branch' : 'working tree'}.`}>
              <button className="rv-btn" onClick={() => requestDiff(base === 'branch' ? 'working' : 'branch')}>
                Look at the {base === 'branch' ? 'working tree' : 'branch'} instead
              </button>
            </State>
          ) : shown.length === 0 ? (
            <State icon="search" title={`No files match “${query}”.`}>
              <button className="rv-btn" onClick={() => setQuery('')}>Clear filter</button>
            </State>
          ) : (
            <>
              <div className="rv-stream" ref={stream}>
                {shown.map((f) => (
                  <FileView
                    key={f.index}
                    file={f}
                    view={view}
                    wrap={wrap}
                    open={isOpen(f)}
                    viewed={viewed.has(f.signature)}
                    comments={indexes.get(f.path)?.index ?? EMPTY_INDEX}
                    commentCount={commentCounts.get(f.path) ?? 0}
                    vis={vis}
                    focusReq={focus && focus.fileIndex === f.index ? focus : undefined}
                    handlers={handlers}
                  />
                ))}
              </div>
              <div className="rv-end">
                <Icon name="check-all" /> End of review · {shown.length} file{shown.length === 1 ? '' : 's'}.
                Click a line, or press <kbd className="rv-kbd">c</kbd>, to leave a comment.
              </div>
            </>
          )}
        </div>
      </div>

      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {toast && <div className="rv-toast" role="status">{toast}</div>}
      {dialog && <SendDialog count={readyCount} hasLiveAgent={hasLiveAgent} onPick={doSend} onClose={() => setDialog(false)} />}
    </div>
  );
}

function Loading() {
  return (
    <div className="rv-state" role="status" aria-label="Computing the diff">
      <div className="rv-shimmer" style={{ width: '38%' }} />
      <div className="rv-shimmer" style={{ width: '82%' }} />
      <div className="rv-shimmer" style={{ width: '64%' }} />
      <div className="rv-shimmer" style={{ width: '71%' }} />
      <p>Computing the diff…</p>
    </div>
  );
}

function State({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="rv-state">
      <Icon name={icon} className="rv-state-icon" />
      <p>{title}</p>
      {children}
    </div>
  );
}

function sentMessage(d: SendDestination, fellBack: boolean): string {
  if (d === 'live') return 'Sent to the running agent.';
  // The agent the panel offered has exited since, so the comments went to a new one.
  if (d === 'new' && fellBack) return 'The agent had exited, so a new one was launched with your comments.';
  if (d === 'new') return 'Launched a new agent with your comments.';
  return 'Prompt copied to clipboard.';
}
