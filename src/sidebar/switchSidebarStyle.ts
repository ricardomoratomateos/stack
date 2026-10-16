import { SIDEBAR_STYLES, SIDEBAR_STYLE_INFO, type SidebarStyle } from '../sidebarStyle';

export interface SidebarStylePickItem {
  label: string;
  description?: string;
  detail: string;
  style: SidebarStyle;
}

/** What the "Switch Sidebar Style" command needs from VS Code, so it tests on doubles. */
export interface SwitchSidebarStyleDeps {
  current(): SidebarStyle;
  pick(items: SidebarStylePickItem[], placeHolder: string): Promise<SidebarStylePickItem | undefined>;
  save(style: SidebarStyle): Promise<void>;
}

/**
 * A quick pick over the sidebar's looks. The current one is marked and listed
 * first so Enter is a no-op rather than a surprise; nothing is written when the
 * pick is dismissed or unchanged.
 */
export async function switchSidebarStyle(deps: SwitchSidebarStyleDeps): Promise<SidebarStyle | undefined> {
  const current = deps.current();
  const items: SidebarStylePickItem[] = [...SIDEBAR_STYLES]
    .sort((a, b) => Number(b === current) - Number(a === current))
    .map((style) => ({
      label: SIDEBAR_STYLE_INFO[style].label,
      description: style === current ? 'current' : undefined,
      detail: SIDEBAR_STYLE_INFO[style].description,
      style,
    }));
  const picked = await deps.pick(items, 'Choose how the Stack sidebar looks');
  if (!picked || picked.style === current) return undefined;
  await deps.save(picked.style);
  return picked.style;
}
