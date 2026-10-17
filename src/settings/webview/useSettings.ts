import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SECTION_IDS, dirtySections, errorSections, projectDirty, projectDraft, projectErrors, projectValues, reconcileProject, reconcileUser,
  userDirty, userErrors, type NumericField, type ProjectDraft, type SectionId,
} from '../draft';
import type { FileField, SettingsExtMessage, SettingsSnapshot, UserValues } from '../types';
import type { Ctx } from './sections/context';
import { send } from './vscode';

export interface Notice { scope: 'project' | 'user'; problems: string[] }

/**
 * All of the panel's state: the snapshot, a draft per scope, and what Save has
 * said. The two drafts are independent — a snapshot that follows a save
 * replaces only the scope nobody is editing (see `reconcile*`).
 */
export function useSettings() {
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [user, setUser] = useState<UserValues | null>(null);
  const [pending, setPending] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const snapRef = useRef<SettingsSnapshot | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as SettingsExtMessage;
      if (msg.type === 'snapshot') {
        const prev = snapRef.current;
        const next = msg.snapshot;
        setDraft((d) => (prev && d ? reconcileProject(prev.project, d, next.project) : projectDraft(next.project)));
        setUser((u) => (prev && u ? reconcileUser(prev.user, u, next.user) : next.user));
        snapRef.current = next;
        setSnap(next);
      } else if (msg.type === 'picked') {
        setDraft((d) => {
          if (!d) return d;
          const p = d.project;
          const project = msg.field === 'composeFile' || msg.field === 'overrideFile'
            ? { ...p, docker: { ...p.docker, [msg.field]: msg.path } }
            : { ...p, [msg.field]: msg.path };
          return { ...d, project };
        });
      } else {
        setNotices((n) => [...n.filter((x) => x.scope !== msg.scope), { scope: msg.scope, problems: msg.problems }]);
        setPending((n) => Math.max(0, n - 1));
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // A clean "Saved" confirmation fades; one with problems stays until the next edit.
  const clean = notices.length > 0 && notices.every((n) => n.problems.length === 0);
  useEffect(() => {
    if (clean && pending === 0) {
      const t = setTimeout(() => setNotices([]), 2500);
      return () => clearTimeout(t);
    }
  }, [clean, pending]);

  const model = useMemo(() => {
    if (!snap || !draft || !user) return null;
    const pErrors = projectErrors(draft);
    const uErrors = userErrors(user);
    const pDirty = projectDirty(draft, snap.project);
    const uDirty = userDirty(user, snap.user);
    const changed = new Set(dirtySections(draft, user, snap.project, snap.user));
    const broken = new Set(errorSections(draft, user));
    return {
      pErrors, uErrors, pDirty, uDirty,
      errorCount: Object.keys(pErrors).length + Object.keys(uErrors).length,
      // An edit that does not validate is still an edit (it must show the bar, and a dot), even though it saves as what it was.
      dirty: SECTION_IDS.filter((id) => changed.has(id) || broken.has(id)),
      broken: SECTION_IDS.filter((id) => broken.has(id)),
    };
  }, [snap, draft, user]);

  const edit = useCallback(<T,>(fn: () => T): T => { setNotices([]); return fn(); }, []);

  const ctx: Ctx | null = useMemo(() => {
    if (!snap || !draft || !user || !model) return null;
    const setProject = (fn: (d: ProjectDraft) => ProjectDraft) => edit(() => setDraft((d) => (d ? fn(d) : d)));
    return {
      snap, draft, user, hasRepo: !!snap.repoRoot, file: snap.projectFile.relative,
      errors: model.pErrors, userErrors: model.uErrors,
      patch: (p) => setProject((d) => ({ ...d, project: { ...d.project, ...p } })),
      patchDocker: (p) => setProject((d) => ({ ...d, project: { ...d.project, docker: { ...d.project.docker, ...p } } })),
      setNumber: (field: NumericField, text: string) => setProject((d) => ({ ...d, numbers: { ...d.numbers, [field]: text } })),
      setDockerOn: (dockerOn) => setProject((d) => ({ ...d, dockerOn })),
      setTemplateText: (templateText) => setProject((d) => ({ ...d, templateText })),
      patchUser: (u) => edit(() => setUser((cur) => (cur ? { ...cur, ...u } : cur))),
      pick: (field: FileField) => send({ type: 'pickFile', field }),
      createScript: (kind) => send({ type: 'createScript', kind }),
      clearOverrides: () => send({ type: 'clearPersonalOverrides' }),
      openFile: () => send({ type: 'openProjectFile' }),
      setManager: (enabled: boolean) => send({ type: 'setManager', enabled }),
    };
  }, [snap, draft, user, model, edit]);

  const save = useCallback(() => {
    if (!snap || !draft || !user || !model || model.errorCount > 0) return;
    const saves = (model.pDirty ? 1 : 0) + (model.uDirty ? 1 : 0);
    if (saves === 0) return;
    setNotices([]);
    setPending(saves);
    if (model.pDirty) send({ type: 'saveProject', values: projectValues(draft) });
    if (model.uDirty) send({ type: 'saveUser', values: user });
  }, [snap, draft, user, model]);

  const discard = useCallback(() => {
    if (!snap) return;
    setNotices([]);
    setDraft(projectDraft(snap.project));
    setUser(snap.user);
  }, [snap]);

  return { snap, ctx, model, user, pending, notices, save, discard };
}

export type { SectionId };
