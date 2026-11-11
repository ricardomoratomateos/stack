import { invoke } from '@tauri-apps/api/core';
import type { SidebarStyle } from '@core/sidebarStyle';
import { sidebarStyleFromSettings } from './bridge';

/** `stack.sidebarStyle` from the user's VS Code settings; `aside` when there is none (or outside Tauri). */
export async function loadSidebarStyle(): Promise<SidebarStyle> {
  try {
    return sidebarStyleFromSettings(await invoke<string | null>('vscode_settings'));
  } catch {
    return sidebarStyleFromSettings(null);
  }
}
