import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { TerminalRegistry } from './registry';
import { log } from '../log';

/** Like Terminal.app: backslash before anything the shell would read specially. */
export function shellEscapePath(p: string): string {
  return p.replace(/([^A-Za-z0-9_\-.,:+@%/=])/g, '\\$1');
}

/** The text a drop of `paths` types: escaped paths, space separated, trailing space. */
export function dropText(paths: string[]): string {
  return paths.length ? `${paths.map(shellEscapePath).join(' ')} ` : '';
}

/** The pane whose terminal is under a point (CSS px), via the host element's data-pane. */
export function paneAt(x: number, y: number, doc: Document = document): string | null {
  const el = doc.elementFromPoint(x, y)?.closest<HTMLElement>('[data-pane]');
  return el?.dataset.pane ?? null;
}

/**
 * Files dropped on a terminal are typed into it as paths, the way Terminal.app does — Claude
 * Code and Codex attach an image when its path is pasted. Returns the unlisten function.
 */
export async function watchFileDrops(registry: TerminalRegistry): Promise<() => void> {
  if (!('__TAURI_INTERNALS__' in window)) return () => {};
  return getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type !== 'drop') return;
    log('info', 'drop', JSON.stringify(ev.payload), window.devicePixelRatio);
    // Typed as a PhysicalPosition, but on macOS Tauri reports it in logical (CSS) points already.
    const { x, y } = ev.payload.position;
    const pane = paneAt(x, y);
    log('info', 'drop target', pane ?? '(none)');
    if (!pane || !ev.payload.paths.length) return;
    const dropped = ev.payload.paths;
    // A screenshot thumbnail's file vanishes after the drag: the backend copies those first.
    void invoke<string[]>('stage_drops', { paths: dropped })
      .catch(() => dropped)
      .then((paths) => {
        registry.paste(pane, dropText(paths));
        registry.focus(pane);
      });
  });
}
