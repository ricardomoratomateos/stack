import React, { useEffect, useRef } from 'react';
import type { DiffComment } from '../types';

export type View = 'inline' | 'split';

/** A comment on the review: what is sent, plus whether the box is still open for typing. */
export interface ReviewComment extends DiffComment {
  id: number;
  editing: boolean;
  /** The text to go back to if the edit is cancelled; absent for a comment that was never saved. */
  prev?: string;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function Icon({ name, className }: { name: string; className?: string }) {
  return <i className={`codicon codicon-${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rv-kbd">{children}</kbd>;
}

/** Calls `cb` whenever the element's height changes (used to size the empty twin of a comment in split view). */
export function useHeight(cb: ((h: number) => void) | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !cb) return;
    const ro = new ResizeObserver(() => cb(el.offsetHeight));
    ro.observe(el);
    cb(el.offsetHeight);
    return () => ro.disconnect();
  }, [cb]);
  return ref;
}

/**
 * One IntersectionObserver for every file, rooted at the scroller. A file only
 * builds its rows while it is within a couple of screens of the viewport, so
 * opening a 100-file review costs a handful of files, not all of them.
 */
export class Visibility {
  private io: IntersectionObserver;
  private cbs = new Map<Element, (near: boolean) => void>();
  constructor(root: Element) {
    this.io = new IntersectionObserver(
      (entries) => { for (const e of entries) this.cbs.get(e.target)?.(e.isIntersecting); },
      { root, rootMargin: '2200px 0px' },
    );
  }
  watch(el: Element, cb: (near: boolean) => void): () => void {
    this.cbs.set(el, cb);
    this.io.observe(el);
    return () => { this.cbs.delete(el); this.io.unobserve(el); };
  }
  dispose() { this.io.disconnect(); this.cbs.clear(); }
}
