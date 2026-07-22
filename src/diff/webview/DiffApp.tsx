import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { html as diff2html, parse as parseDiff } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import { send } from './vscode';
import type { DiffBase, DiffComment, SendDestination, DiffPanelExtMessage } from '../types';

type OutputFormat = 'line-by-line' | 'side-by-side';

interface Comment extends DiffComment {
  id: number;
}

export function DiffApp() {
  const [base, setBase] = useState<DiffBase>('branch');
  const [format, setFormat] = useState<OutputFormat>('line-by-line');
  const [unified, setUnified] = useState<string>('');
  const [label, setLabel] = useState<string>('');
  const [hasLiveAgent, setHasLiveAgent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<Comment[]>([]);
  const [filesOpen, setFilesOpen] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const diffRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  // comment id → the diff row it is anchored to (for the highlight marker).
  const rowFor = useRef(new Map<number, HTMLElement>());
  // comment id → the injected <td> the inline editor portal renders into.
  const mountFor = useRef(new Map<number, HTMLElement>());

  /** Remove every injected comment row + highlight from the current DOM. */
  const clearAnchors = useCallback(() => {
    for (const row of rowFor.current.values()) row.classList.remove('u-commented');
    for (const td of mountFor.current.values()) td.parentElement?.remove();
    rowFor.current.clear();
    mountFor.current.clear();
  }, []);

  // ── Extension messages ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as DiffPanelExtMessage;
      if (msg.type === 'diff') {
        setUnified(msg.unified);
        setBase(msg.base);
        setHasLiveAgent(msg.hasLiveAgent);
        setLabel(msg.label);
        setLoading(false);
      } else if (msg.type === 'sent') {
        setModalOpen(false);
        if (msg.ok) {
          clearAnchors();
          setComments([]);
          setToast(sentMessage(msg.destination));
        } else {
          setToast('Nothing sent — no target available.');
        }
        setTimeout(() => setToast(null), 4000);
      } else if (msg.type === 'error') {
        setToast(msg.message);
        setLoading(false);
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [clearAnchors]);

  // Expose the diff scrollport's visible width (scrollbar excluded) as a CSS var
  // so inline comment boxes can match it instead of stretching to the full
  // (often huge) table width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => el.style.setProperty('--u-view-width', `${el.clientWidth}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const requestDiff = useCallback((next: DiffBase) => {
    setLoading(true);
    clearAnchors();
    setComments([]);
    send({ type: 'requestDiff', base: next });
  }, [clearAnchors]);

  // ── Render the diff HTML ────────────────────────────────────────────────────
  const rendered = useMemo(() => {
    if (!unified.trim()) return '';
    // Match diff2html's palette to the active VSCode theme (body carries the class).
    const colorScheme = document.body.classList.contains('vscode-light')
      ? ColorSchemeType.LIGHT
      : ColorSchemeType.DARK;
    // matching:'none' skips the (costly) intra-line word diffing; the file list
    // is drawn as our own sidebar instead of diff2html's top summary.
    return diff2html(unified, { drawFileList: false, matching: 'none', outputFormat: format, colorScheme });
  }, [unified, format]);

  // Parsed file summary, powering the GitHub-style sidebar (same order as render).
  const files = useMemo(() => (unified.trim() ? parseDiff(unified) : []), [unified]);

  const scrollToFile = useCallback((index: number) => {
    const wrappers = diffRef.current?.querySelectorAll<HTMLElement>('.d2h-file-wrapper');
    wrappers?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** Inject a full-width row right under `row` and record its cell as the portal target. */
  const anchorRow = useCallback((row: HTMLElement, id: number) => {
    row.classList.add('u-commented');
    rowFor.current.set(id, row);
    const tr = document.createElement('tr');
    tr.className = 'u-comment-row';
    const td = document.createElement('td');
    td.colSpan = row.children.length || 2;
    tr.appendChild(td);
    row.parentNode?.insertBefore(tr, row.nextSibling);
    mountFor.current.set(id, td);
  }, []);

  // ── Line-click → add an inline comment ──────────────────────────────────────
  const addComment = useCallback((row: HTMLElement) => {
    const info = extractLine(row);
    if (!info) return;
    const id = nextId.current++;
    anchorRow(row, id);
    setComments((cs) => [...cs, { id, body: '', ...info }]);
  }, [anchorRow]);

  const updateBody = useCallback((id: number, body: string) => {
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
  }, []);

  const removeComment = useCallback((id: number) => {
    rowFor.current.get(id)?.classList.remove('u-commented');
    mountFor.current.get(id)?.parentElement?.remove();
    rowFor.current.delete(id);
    mountFor.current.delete(id);
    setComments((cs) => cs.filter((c) => c.id !== id));
  }, []);

  // ── Re-anchor after the diff DOM is (re)built (format toggle / new diff) ─────
  // diff2html replaces innerHTML wholesale, destroying our injected rows. Rebuild
  // them from the comment list, dropping any whose line no longer exists.
  useEffect(() => {
    const container = diffRef.current;
    if (!container) return;
    rowFor.current.clear();
    mountFor.current.clear();
    setComments((cs) => {
      const survivors = cs.filter((c) => {
        const row = findRowForComment(container, c);
        if (!row) return false;
        anchorRow(row, c.id);
        return true;
      });
      return survivors.length === cs.length ? cs : survivors;
    });
  }, [rendered, anchorRow]);

  const ready = comments.filter((c) => c.body.trim().length > 0);

  const doSend = useCallback(
    (destination: SendDestination) => {
      const payload: DiffComment[] = ready.map(({ file, side, line, code, body }) => ({ file, side, line, code, body }));
      send({ type: 'send', destination, comments: payload });
    },
    [ready],
  );

  return (
    <div className="u-diff-root">
      <div className="u-toolbar">
        {files.length > 0 && (
          <button
            className="u-files-toggle"
            title={filesOpen ? 'Hide file list' : 'Show file list'}
            onClick={() => setFilesOpen((v) => !v)}
          >
            ☰
          </button>
        )}
        <span className="u-title">{label ? `Review — ${label}` : 'Review'}</span>
        <div className="u-seg">
          <button className={base === 'branch' ? 'on' : ''} onClick={() => requestDiff('branch')}>branch</button>
          <button className={base === 'working' ? 'on' : ''} onClick={() => requestDiff('working')}>working</button>
        </div>
        <div className="u-seg">
          <button className={format === 'line-by-line' ? 'on' : ''} onClick={() => setFormat('line-by-line')}>inline</button>
          <button className={format === 'side-by-side' ? 'on' : ''} onClick={() => setFormat('side-by-side')}>split</button>
        </div>
        <span className="u-spacer" />
        {comments.length > 0 && (
          <span className="u-count">{ready.length}/{comments.length} comments</span>
        )}
        <button className="u-send" disabled={ready.length === 0} onClick={() => setModalOpen(true)}>
          Send to agent
        </button>
      </div>

      <div className="u-body">
        {files.length > 0 && filesOpen && (
          <div className="u-files">
            <div className="u-files-head">{files.length} file{files.length === 1 ? '' : 's'} changed</div>
            {files.map((f, i) => {
              const name = f.newName && f.newName !== '/dev/null' ? f.newName : f.oldName;
              const status = f.isNew ? 'A' : f.isDeleted ? 'D' : f.isRename ? 'R' : 'M';
              const slash = name.lastIndexOf('/');
              const fileBase = name.slice(slash + 1);
              const dir = slash >= 0 ? name.slice(0, slash + 1) : '';
              return (
                <div key={`${name}-${i}`} className="u-file" title={name} onClick={() => scrollToFile(i)}>
                  <span className={`u-file-status u-st-${status}`}>{status}</span>
                  <span className="u-file-name">
                    <span className="u-file-base">{fileBase}</span>
                    {dir && <span className="u-file-dir">{dir.replace(/\/$/, '')}</span>}
                  </span>
                  <span className="u-file-stat">
                    {f.addedLines > 0 && <span className="u-add">+{f.addedLines}</span>}
                    {f.deletedLines > 0 && <span className="u-del">−{f.deletedLines}</span>}
                  </span>
                  {status !== 'D' && (
                    <button
                      className="u-file-open"
                      title="Open in editor"
                      onClick={(e) => { e.stopPropagation(); send({ type: 'openFile', path: name }); }}
                    >
                      ↗
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="u-diff-scroll" ref={scrollRef}>
          {loading ? (
            <div className="u-empty">Loading diff…</div>
          ) : rendered ? (
            <DiffHtml html={rendered} containerRef={diffRef} onRowClick={addComment} />
          ) : (
            <div className="u-empty">No changes to review on this {base === 'branch' ? 'branch' : 'working tree'}.</div>
          )}
          {!loading && rendered && (
            <div className="u-hint">Click any line to attach a comment.</div>
          )}
        </div>
      </div>

      {/* Inline comment editors, portalled into the rows injected under each line. */}
      {comments.map((c) => {
        const mount = mountFor.current.get(c.id);
        return mount
          ? createPortal(
              <InlineComment
                comment={c}
                onChange={(b) => updateBody(c.id, b)}
                onRemove={() => removeComment(c.id)}
                onOpen={() => send({ type: 'openFile', path: c.file, line: c.line })}
              />,
              mount,
              String(c.id),
            )
          : null;
      })}

      {toast && <div className="u-toast">{toast}</div>}

      {modalOpen && (
        <SendModal
          count={ready.length}
          hasLiveAgent={hasLiveAgent}
          onPick={doSend}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function InlineComment({
  comment,
  onChange,
  onRemove,
  onOpen,
}: {
  comment: Comment;
  onChange: (body: string) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="u-inline-comment">
      <div className="u-ic-head">
        <button className="u-ic-loc" title="Open in editor" onClick={onOpen}>
          {comment.file}{comment.line !== undefined ? `:${comment.line}` : ''}
        </button>
        <button className="u-x" title="Remove comment" onClick={onRemove}>✕</button>
      </div>
      <textarea
        autoFocus
        value={comment.body}
        placeholder="Leave a comment…"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * The rendered diff, isolated behind React.memo so it never re-renders (nor
 * re-parses the large HTML) when comments change or the modal opens. It only
 * re-renders when the diff `html` string itself changes, and owns the click
 * listener that turns a line click into a comment.
 */
const DiffHtml = React.memo(function DiffHtml({
  html,
  containerRef,
  onRowClick,
}: {
  html: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onRowClick: (row: HTMLElement) => void;
}) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Ignore clicks inside an inline comment editor (it lives in an injected row).
      if (target.closest('.u-comment-row')) return;
      const row = target.closest('tr') as HTMLElement | null;
      if (!row || !row.querySelector('.d2h-code-line, .d2h-code-side-line')) return;
      onRowClick(row);
    };
    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [html, containerRef, onRowClick]);

  return <div ref={containerRef} className="u-diff" dangerouslySetInnerHTML={{ __html: html }} />;
});

function SendModal({
  count,
  hasLiveAgent,
  onPick,
  onClose,
}: {
  count: number;
  hasLiveAgent: boolean;
  onPick: (d: SendDestination) => void;
  onClose: () => void;
}) {
  return (
    <div className="u-modal-backdrop" onClick={onClose}>
      <div className="u-modal" onClick={(e) => e.stopPropagation()}>
        <div className="u-modal-title">Send {count} comment{count === 1 ? '' : 's'} to…</div>
        <button className="u-modal-opt" disabled={!hasLiveAgent} onClick={() => onPick('live')}>
          <strong>Running agent</strong>
          <span>{hasLiveAgent ? 'Paste into the live session in this worktree' : 'No agent running in this worktree'}</span>
        </button>
        <button className="u-modal-opt" onClick={() => onPick('new')}>
          <strong>New agent</strong>
          <span>Launch a fresh agent seeded with the comments</span>
        </button>
        <button className="u-modal-opt" onClick={() => onPick('clipboard')}>
          <strong>Clipboard</strong>
          <span>Copy the prompt to paste it yourself</span>
        </button>
        <button className="u-modal-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function sentMessage(d: SendDestination): string {
  if (d === 'live') return 'Sent to the running agent.';
  if (d === 'new') return 'Launched a new agent with your comments.';
  return 'Prompt copied to clipboard.';
}

/** Pull (file, side, line, code) out of a diff2html table row. */
function extractLine(row: HTMLElement): Omit<DiffComment, 'body'> | undefined {
  const lineEl = row.querySelector('.d2h-code-line, .d2h-code-side-line');
  if (!lineEl) return undefined;

  const fileEl = row.closest('.d2h-file-wrapper')?.querySelector('.d2h-file-name');
  const file = fileEl?.textContent?.trim() || 'unknown';

  const newNum = row.querySelector('.line-num2')?.textContent?.trim();
  const oldNum = row.querySelector('.line-num1')?.textContent?.trim();
  // Side-by-side rows carry a single line-number cell instead of num1/num2.
  const soleNum = row.querySelector('.d2h-code-side-linenumber')?.textContent?.trim();

  let side: 'old' | 'new' = 'new';
  let line: number | undefined;
  if (newNum) { side = 'new'; line = parseInt(newNum, 10); }
  else if (oldNum) { side = 'old'; line = parseInt(oldNum, 10); }
  else if (soleNum) { line = parseInt(soleNum, 10); }
  if (line !== undefined && Number.isNaN(line)) line = undefined;

  const code = lineEl.querySelector('.d2h-code-line-ctn')?.textContent
    ?? lineEl.textContent
    ?? '';

  return { file, side, line, code };
}

/** Find the diff row a comment was anchored to (used to re-anchor after re-render). */
function findRowForComment(container: HTMLElement, c: Comment): HTMLElement | undefined {
  const wrappers = Array.from(container.querySelectorAll<HTMLElement>('.d2h-file-wrapper'));
  for (const w of wrappers) {
    const name = w.querySelector('.d2h-file-name')?.textContent?.trim();
    if (name !== c.file) continue;
    const rows = Array.from(w.querySelectorAll<HTMLElement>('tr'));
    for (const row of rows) {
      if (!row.querySelector('.d2h-code-line, .d2h-code-side-line')) continue;
      const info = extractLine(row);
      if (info && info.side === c.side && info.line === c.line) return row;
    }
  }
  return undefined;
}
