import { useEffect, useLayoutEffect, type RefObject } from 'react';

/**
 * Sizes a textarea to its content. The CSS gives it a floor (5 lines) and a
 * ceiling (60vh) and the scrollbar takes over past that; this only has to
 * report the content height. Width changes re-wrap lines, so resizing re-measures.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
}
