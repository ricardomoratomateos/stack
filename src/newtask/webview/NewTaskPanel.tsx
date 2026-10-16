import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { send } from './vscode';
import { Picker, type PickerItem } from './Picker';
import { BranchChip } from './BranchChip';
import { useAutoGrow } from './useAutoGrow';
import { PROVIDER_ORDER, ProviderMark } from '../../webview/components/providers';
import { normalizeSidebarStyle } from '../../sidebarStyle';
import { isCancelKey, isSubmitKey, providerName, resolveBranch, submitShortcutLabel } from '../composer';
import type { ProviderId } from '../../ports/IAgentProvider';
import type { NewTaskExtMessage, NewTaskInit } from '../types';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export function NewTaskPanel() {
  const [init, setInit] = useState<NewTaskInit>({
    branches: [], baseBranch: '', defaultProvider: 'claude', installedProviders: ['claude', 'codex', 'opencode'],
    // The extension writes the style into <body> so the first paint is already right.
    sidebarStyle: normalizeSidebarStyle(document.body.dataset.style),
  });
  // What the user chose; null means "whatever the extension currently suggests".
  const [pickedBase, setPickedBase] = useState<string | null>(null);
  const [pickedProvider, setPickedProvider] = useState<ProviderId | null>(null);
  const [manualBranch, setManualBranch] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const errorId = useId();

  const base = pickedBase ?? init.baseBranch;
  const provider = pickedProvider ?? init.defaultProvider;
  const installed = init.installedProviders.includes(provider);
  const branch = resolveBranch(manualBranch, description);
  const generated = resolveBranch(null, description).name;
  const dirty = description.trim().length > 0;
  const canSubmit = !!branch.name && !branch.error && installed && !busy;

  useAutoGrow(textRef, description);

  // Announce readiness only after the listener is attached, so the init reply
  // can't be missed — the same handshake the sidebar uses.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as NewTaskExtMessage;
      if (msg.type === 'init') setInit(msg.init);
      else {
        busyRef.current = false;
        setBusy(false);
        setFailure(msg.message);
        textRef.current?.focus();
      }
    };
    // Coming back to the tab (retainContextWhenHidden keeps the page alive)
    // should leave the cursor where the typing is.
    const onFocus = () => { if (document.activeElement === document.body) textRef.current?.focus(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    send({ type: 'ready' });
    textRef.current?.focus();
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const submit = useCallback(() => {
    // The guard is a ref: two ⌘↵ in the same frame both see the same render's state.
    if (!canSubmit || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(undefined);
    send({
      type: 'create',
      branch: branch.name,
      description: description.trim() || undefined,
      baseBranch: base || undefined,
      provider,
    });
  }, [canSubmit, branch.name, description, base, provider]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSubmitKey(e)) {
        e.preventDefault();
        submit();
      } else if (isCancelKey(e) && !e.defaultPrevented && !busyRef.current) {
        e.preventDefault();
        send({ type: 'cancel', dirty });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, dirty]);

  const baseItems = useMemo<PickerItem[]>(
    () => [...new Set([base, ...init.branches].filter(Boolean))].map((b) => ({ value: b, label: b })),
    [base, init.branches],
  );
  const providerItems = PROVIDER_ORDER.map<PickerItem>((id) => {
    const ok = init.installedProviders.includes(id);
    return { value: id, label: providerName(id), icon: <ProviderMark provider={id} size={13} />, dim: !ok, hint: ok ? undefined : 'not installed' };
  });

  const chooseProvider = (id: string) => {
    if (init.installedProviders.includes(id as ProviderId)) setPickedProvider(id as ProviderId);
    else send({ type: 'showProviderInstall', provider: id as ProviderId });
  };

  const shortcut = submitShortcutLabel(IS_MAC);
  const sendTitle = busy ? 'Creating…' : !installed ? `${providerName(provider)} is not installed` : canSubmit ? `Create and start (${shortcut})` : 'Describe the task to start';

  return (
    <div className={`nt nt-${init.sidebarStyle}`}>
      <main className="nt-col">
        <h1 className="nt-title">New task</h1>
        <p className="nt-sub">One task, one branch, one worktree, one agent.</p>

        <div className="nt-card">
          <textarea
            ref={textRef}
            className="nt-text"
            value={description}
            readOnly={busy}
            placeholder="Describe the task…"
            aria-label="Task description"
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="nt-bar">
            <Picker
              items={baseItems} value={base} onSelect={setPickedBase} mono searchable disabled={busy}
              label={`Base branch: ${base || 'none'}`} title="Branch the new one is created from"
              searchPlaceholder="Search branches"
            >
              <i className="codicon codicon-git-branch" aria-hidden="true" />
              <span className="nt-chip-label">{base || 'branch'}</span>
            </Picker>
            <BranchChip
              name={branch.name} manual={manualBranch} generated={generated} error={branch.error}
              errorId={errorId} disabled={busy} onChange={setManualBranch}
            />
            {branch.error && (
              <span id={errorId} role="alert" className="nt-inline-error">
                <i className="codicon codicon-error" aria-hidden="true" />{branch.error}
              </span>
            )}
            <Picker
              items={providerItems} value={provider} onSelect={chooseProvider} dim={!installed} disabled={busy}
              label={`Agent: ${providerName(provider)}`} title="Agent that works on the task"
            >
              <span className="nt-mark"><ProviderMark provider={provider} size={13} /></span>
              <span>{providerName(provider)}</span>
            </Picker>
            <span className="nt-spacer" />
            <button
              type="button" className="nt-send" disabled={!canSubmit} aria-busy={busy}
              title={sendTitle} aria-label={sendTitle} onClick={submit}
            >
              <i className={busy ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-arrow-up'} aria-hidden="true" />
            </button>
          </div>
        </div>

        {failure && (
          <div className="nt-failure" role="alert">
            <i className="codicon codicon-error" aria-hidden="true" /><span>{failure}</span>
          </div>
        )}

        <p className="nt-note">
          {busy ? 'Creating the worktree…' : !installed ? (
            <>
              <span className="nt-warn">{providerName(provider)} is not on your PATH.</span>{' '}
              <button type="button" className="nt-link" onClick={() => send({ type: 'showProviderInstall', provider })}>How to install it</button>
              {' '}or pick another agent.
            </>
          ) : (
            <>
              {init.branches.includes(branch.name)
                ? <>Reuses <code>{branch.name}</code></>
                : <>Creates {branch.name ? <code>{branch.name}</code> : 'a branch'} from <code>{base || 'HEAD'}</code></>}
              {' '}and starts {providerName(provider)} · Esc to cancel
            </>
          )}
        </p>
      </main>
    </div>
  );
}
