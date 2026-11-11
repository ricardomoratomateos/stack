import { invoke } from '@tauri-apps/api/core';
import { normalizeSidebarStyle, type SidebarStyle } from '@core/sidebarStyle';
import { sidebarStyleFromSettings } from './bridge';
import { sidebarStyleOf } from '../settings/schema';

/** The style in Stack's own settings.json when it has a valid one; else VS Code's. */
export function resolveSidebarStyle(stackSettings: Record<string, unknown> | null | undefined, vscodeText: string | null | undefined): SidebarStyle {
  const own = stackSettings ? sidebarStyleOf(stackSettings) : undefined;
  return own !== undefined && normalizeSidebarStyle(own) === own ? (own as SidebarStyle) : sidebarStyleFromSettings(vscodeText);
}

/** `stack.sidebarStyle`: ~/.config/stack/settings.json first, then the user's VS Code settings; `aside` when neither has it (or outside Tauri). */
export async function loadSidebarStyle(): Promise<SidebarStyle> {
  const [own, code] = await Promise.all([
    invoke<Record<string, unknown>>('read_settings').catch(() => null),
    invoke<string | null>('vscode_settings').catch(() => null),
  ]);
  return resolveSidebarStyle(own, code);
}
