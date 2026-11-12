import { GLOBAL_CSS } from './tokens';
import { ROW_PARTS_CSS, SHARED_CSS } from './styles/shared';
import { ASIDE_CSS } from './styles/aside/aside.css';

/**
 * The sidebar's stylesheet. Layout CSS comes after the shared CSS: where they
 * set the same property at equal specificity, the layout wins. Shared with the
 * desktop app, which renders this same sidebar.
 */
export const WEBVIEW_CSS = [GLOBAL_CSS, SHARED_CSS, ROW_PARTS_CSS, ASIDE_CSS].join('\n');
