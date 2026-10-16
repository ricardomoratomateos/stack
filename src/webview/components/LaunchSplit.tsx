import React from 'react';
import { send } from '../vscode';
import type { ProviderId, WorktreeItem } from '../types';
import { MenuItem, MenuPanel, MenuSeparator, useDropdown } from './Menu';
import { PROVIDER_ORDER, ProviderMark, visualFor } from './providers';

interface Props {
  wt: WorktreeItem;
  defaultProvider?: ProviderId;
  installedProviders?: ProviderId[];
  /** Text beside the provider mark on the main half; omit for an icon-only button. */
  label?: React.ReactNode;
  /** Look of the split: filled with the layout's primary colour, or outlined. */
  tone?: 'solid' | 'ghost';
}

/**
 * Split button: the big half launches the primary agent, the chevron opens the
 * rest. Providers whose command is not on PATH are dimmed, and choosing one
 * explains how to install it rather than failing inside tmux.
 */
export function LaunchSplit({ wt, defaultProvider, installedProviders, label, tone = 'ghost' }: Props) {
  const menu = useDropdown();
  // Undefined means the extension has not reported yet — assume available
  // rather than dimming the button on first paint (same rule as the menu).
  const isInstalled = (id: string) => installedProviders === undefined || installedProviders.includes(id as ProviderId);
  const primaryInstalled = !defaultProvider || isInstalled(defaultProvider);
  const hasSession = wt.agent !== 'idle';
  const name = defaultProvider ?? 'agent';
  const title = !primaryInstalled
    ? `${name} is not on your PATH`
    : hasSession ? `New ${name} session` : `Launch ${name}`;

  const launchPrimary = (e: React.MouseEvent) => {
    e.stopPropagation();
    menu.close();
    // The primary agent gets the same installed check the menu applies. Without
    // it the menu greyed an agent out while the button beside it launched it
    // anyway, and the failure surfaced inside tmux rather than as a notification.
    if (!primaryInstalled && defaultProvider) send({ type: 'showProviderInstall', provider: defaultProvider });
    else send({ type: 'launchAgent', worktreeId: wt.id });
  };

  return (
    <div ref={menu.anchorRef} className={`fm-split fm-split-${tone}`}>
      <button type="button" className="fm-split-main" title={title} aria-label={label ? undefined : title} onClick={launchPrimary}>
        <span className="fm-split-mark" style={{ opacity: primaryInstalled ? 1 : 0.4 }}>
          <ProviderMark provider={defaultProvider} size={13} />
        </span>
        {label && <span className="fm-split-label">{label}</span>}
      </button>
      <button
        type="button"
        className="fm-split-chev"
        aria-label="Launch another agent"
        title={menu.open ? 'Close' : 'Launch another agent…'}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(e) => { e.stopPropagation(); menu.toggle(); }}
      >
        <i className={`codicon codicon-chevron-${menu.open ? 'up' : 'down'}`} aria-hidden="true" />
      </button>
      {menu.open && (
        <MenuPanel anchorRef={menu.anchorRef} onClose={menu.close} up={menu.up} label="Launch an agent">
          {PROVIDER_ORDER.map((id) => {
            const visual = visualFor(id);
            const available = isInstalled(id);
            return (
              <MenuItem
                key={id}
                dim={!available}
                checked={id === defaultProvider}
                title={available ? `Launch ${visual.label}` : `${visual.label} is not on your PATH`}
                onClick={() => {
                  menu.close();
                  if (available) send({ type: 'launchAgent', worktreeId: wt.id, provider: id });
                  else send({ type: 'showProviderInstall', provider: id });
                }}
              >
                <visual.icon size={12} />
                <span className="fm-menu-label" style={{ fontWeight: id === defaultProvider ? 600 : 400 }}>{visual.label}</span>
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem
            title="Choose which agent the main button launches"
            onClick={() => { menu.close(); send({ type: 'pickDefaultProvider' }); }}
          >
            <i className="codicon codicon-ellipsis" aria-hidden="true" />
            <span className="fm-menu-label">Change primary…</span>
          </MenuItem>
        </MenuPanel>
      )}
    </div>
  );
}
