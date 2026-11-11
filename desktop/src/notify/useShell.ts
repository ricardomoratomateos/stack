import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Snapshot } from '../stackd/api';
import { NotifyPolicy } from './policy';
import { needsOf, trayModel } from './tray';

const DND_KEY = 'stack.dnd';
const loadDnd = (): boolean => { try { return localStorage.getItem(DND_KEY) === '1'; } catch { return false; } };

export interface ShellHandlers {
  /** A notification, the tray or a shortcut asked for this worktree (any repo). */
  onSelect(id: string): void;
  /** ⌃⌥⌘J: the next worktree needing you. */
  onNext(): void;
  /** ⌃⌥⌘M. */
  onManager(): void;
  /** Something to tell the user in-app (a notification that could not be delivered). */
  onNotice(text: string): void;
}

/** Notifications, tray and the events of the global shortcuts; the rules are in policy.ts, delivery in shell.rs. */
export function useShell(snapshot: Snapshot | null, selectedId: string | undefined, h: ShellHandlers): { dnd: boolean } {
  const [dnd, setDnd] = useState(loadDnd);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const policy = useRef(new NotifyPolicy());
  const handlers = useRef(h);
  handlers.current = h;
  const failed = useRef(false);

  useEffect(() => { try { localStorage.setItem(DND_KEY, dnd ? '1' : '0'); } catch { /* lasts until reload */ } }, [dnd]);

  useEffect(() => {
    const on = () => setFocused(document.hasFocus());
    window.addEventListener('focus', on);
    window.addEventListener('blur', on);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', on); };
  }, []);

  // Policy: feed it the state, and check what is due once a second.
  useEffect(() => { policy.current.update(Date.now(), { needs: needsOf(snapshot), focused, selectedId, dnd }); }, [snapshot, focused, selectedId, dnd]);
  useEffect(() => {
    const t = window.setInterval(() => {
      const n = policy.current.due(Date.now());
      if (!n) return;
      invoke('notify_show', { title: n.title, body: n.body, id: n.ids[0] }).catch((e) => {
        console.warn(String(e));
        if (!failed.current) { failed.current = true; handlers.current.onNotice('Notifications are not delivered in this build — the menu-bar item still counts.'); }
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Menu-bar item.
  const last = useRef('');
  useEffect(() => {
    const model = trayModel(snapshot, dnd);
    const key = JSON.stringify(model);
    if (key === last.current) return;
    last.current = key;
    invoke('set_tray', { model }).catch(() => { last.current = ''; });
  }, [snapshot, dnd]);

  useEffect(() => {
    const offs = [
      listen<string>('app://select', (e) => handlers.current.onSelect(e.payload)),
      listen('app://next', () => handlers.current.onNext()),
      listen('app://manager', () => handlers.current.onManager()),
      listen('tray://dnd', () => setDnd((d) => !d)),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
  }, []);

  return { dnd };
}
