/**
 * The three looks the sidebar can wear. The data and every action behind them
 * are the same; only the layout and the palette differ.
 *
 * Kept free of vscode and DOM imports because three different bundles read it:
 * the extension (setting, quick pick), the sidebar webview (which layout to
 * render) and the settings panel (the select).
 */
export const SIDEBAR_STYLES = ['aside', 'claude', 'mission'] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];

export const DEFAULT_SIDEBAR_STYLE: SidebarStyle = 'aside';

/** Name and one-line pitch per style, shared by the quick pick and the settings select. */
export const SIDEBAR_STYLE_INFO: Record<SidebarStyle, { label: string; description: string }> = {
  aside: {
    label: 'Aside',
    description: 'Monochrome with a single lime accent, filter chips and a health strip.',
  },
  claude: {
    label: 'Claude',
    description: 'Warm terracotta accent, a prompt composer and worktrees grouped by what they need from you.',
  },
  mission: {
    label: 'Mission control',
    description: 'State counters that filter, an attention queue and cards with a metadata grid.',
  },
};

/**
 * Anything but a known style falls back to the default. The value comes out of
 * settings.json, where a typo or a style from a newer build is entirely
 * possible, and a sidebar that renders nothing is the worse failure.
 */
export function normalizeSidebarStyle(value: unknown): SidebarStyle {
  return SIDEBAR_STYLES.includes(value as SidebarStyle) ? (value as SidebarStyle) : DEFAULT_SIDEBAR_STYLE;
}
