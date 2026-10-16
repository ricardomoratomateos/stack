import React, { useEffect, useMemo, useRef } from 'react';
import { flattenTree, fmt, splitPath, type DirNode, type FileEntry, type TreeRow } from './model';
import { Icon } from './ui';

interface Props {
  tree: DirNode;
  total: number;
  shown: number;
  query: string;
  onQuery(q: string): void;
  collapsed: ReadonlySet<string>;
  onToggleDir(id: string): void;
  activeIndex: number;
  viewed: ReadonlySet<string>;
  commentCounts: ReadonlyMap<string, number>;
  onPick(file: FileEntry): void;
  filterRef: React.RefObject<HTMLInputElement | null>;
}

/** The changed files as a folder tree: the sidebar of the review. */
export function FileTree(p: Props) {
  const filtering = p.query.trim().length > 0;
  const rows = useMemo(() => flattenTree(p.tree, p.collapsed, filtering), [p.tree, p.collapsed, filtering]);
  const viewedCount = useMemo(() => {
    let n = 0;
    const walk = (d: DirNode) => { for (const f of d.files) if (p.viewed.has(f.signature)) n++; d.dirs.forEach(walk); };
    walk(p.tree);
    return n;
  }, [p.tree, p.viewed]);

  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [p.activeIndex]);

  return (
    <nav className="rv-tree" aria-label="Changed files">
      <div className="rv-filter">
        <Icon name="search" />
        <input
          ref={p.filterRef}
          type="text"
          value={p.query}
          placeholder="Filter files…"
          aria-label="Filter files"
          spellCheck={false}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { p.onQuery(''); e.currentTarget.blur(); } }}
        />
        {filtering && (
          <button className="rv-icon-btn" aria-label="Clear filter" title="Clear filter" onClick={() => p.onQuery('')}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="rv-tree-meta">
        <span>{filtering ? `${p.shown} of ${p.total} files` : `${p.total} file${p.total === 1 ? '' : 's'} changed`}</span>
        {viewedCount > 0 && <span className="rv-tree-viewed"><Icon name="check" /> {viewedCount} viewed</span>}
      </div>
      <div className="rv-tree-list" ref={list} role="tree">
        {rows.map((row) => (row.type === 'dir'
          ? <DirRow key={`d:${row.node.id}`} row={row} onToggle={p.onToggleDir} filtering={filtering} />
          : <FileRow key={`f:${row.file.index}`} row={row} active={row.file.index === p.activeIndex}
              viewed={p.viewed.has(row.file.signature)} comments={p.commentCounts.get(row.file.path) ?? 0} onPick={p.onPick} />
        ))}
        {rows.length === 0 && <div className="rv-tree-empty">No files match “{p.query}”.</div>}
      </div>
    </nav>
  );
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 });

const DirRow = React.memo(function DirRow({ row, onToggle, filtering }: {
  row: Extract<TreeRow, { type: 'dir' }>; onToggle(id: string): void; filtering: boolean;
}) {
  const { node, open } = row;
  return (
    <button
      className="rv-trow rv-trow-dir"
      style={indent(row.depth)}
      role="treeitem"
      aria-expanded={open}
      title={node.id}
      onClick={() => !filtering && onToggle(node.id)}
    >
      <Icon name={open ? 'chevron-down' : 'chevron-right'} className="rv-chev" />
      <span className="rv-tname">{node.name}</span>
      <span className="rv-tmeta">{node.fileCount}</span>
    </button>
  );
});

const FileRow = React.memo(function FileRow({ row, active, viewed, comments, onPick }: {
  row: Extract<TreeRow, { type: 'file' }>; active: boolean; viewed: boolean; comments: number; onPick(f: FileEntry): void;
}) {
  const f = row.file;
  const { name } = splitPath(f.path);
  return (
    <button
      className={`rv-trow rv-trow-file${active ? ' is-active' : ''}${viewed ? ' is-viewed' : ''}`}
      style={indent(row.depth)}
      role="treeitem"
      aria-current={active ? 'true' : undefined}
      title={f.status === 'R' ? `${f.oldPath} → ${f.path}` : f.path}
      onClick={() => onPick(f)}
    >
      <span className={`rv-st rv-st-${f.status}`} aria-label={f.status}>{f.status}</span>
      <span className="rv-tname rv-tname-file">{name}</span>
      {comments > 0 && <span className="rv-cbadge"><Icon name="comment" /> {comments}</span>}
      {viewed ? (
        <Icon name="check" className="rv-tcheck" />
      ) : (
        <span className="rv-counts">
          {f.added > 0 && <span className="rv-add-n">+{fmt(f.added)}</span>}
          {f.deleted > 0 && <span className="rv-del-n">−{fmt(f.deleted)}</span>}
        </span>
      )}
    </button>
  );
});
