import React from 'react';
import { createRoot } from 'react-dom/client';
import { DiffApp } from './DiffApp';

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  overflow: hidden;
}
button { font-family: inherit; cursor: pointer; }

.u-diff-root { display: flex; flex-direction: column; height: 100%; }

.u-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; flex-shrink: 0;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
}
.u-title { font-weight: 600; font-size: 12px; }
.u-files-toggle { border: none; background: transparent; color: var(--vscode-descriptionForeground); font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
.u-files-toggle:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.u-spacer { flex: 1; }
.u-count { font-size: 11px; color: var(--vscode-descriptionForeground); }

.u-seg { display: inline-flex; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 5px; overflow: hidden; }
.u-seg button {
  border: none; background: transparent; color: var(--vscode-descriptionForeground);
  padding: 3px 10px; font-size: 11px;
}
.u-seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

.u-send {
  border: none; border-radius: 5px; padding: 4px 12px; font-size: 12px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
.u-send:disabled { opacity: .4; cursor: default; }

.u-body { flex: 1; display: flex; min-height: 0; }

.u-files {
  width: 240px; flex-shrink: 0; overflow: auto;
  border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  background: var(--vscode-sideBar-background);
  padding: 6px 4px;
}
.u-files-head { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); padding: 4px 8px 8px; }
.u-file {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  border: none; background: transparent; color: var(--vscode-foreground);
  padding: 3px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;
}
.u-file:hover { background: var(--vscode-list-hoverBackground); }
.u-file-open {
  flex-shrink: 0; border: none; background: transparent; color: var(--vscode-descriptionForeground);
  font-size: 13px; line-height: 1; padding: 0 2px; border-radius: 3px;
  opacity: 0; transition: opacity .1s;
}
.u-file:hover .u-file-open { opacity: 1; }
.u-file-open:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
.u-file-status { flex-shrink: 0; width: 13px; text-align: center; font-family: var(--vscode-editor-font-family); font-size: 10px; font-weight: 700; }
.u-st-A { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
.u-st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.u-st-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }
.u-st-R { color: var(--vscode-gitDecoration-renamedResourceForeground, #4caf50); }
.u-file-name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 5px; overflow: hidden; }
.u-file-base { flex-shrink: 0; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.u-file-dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 10px; }
.u-file-stat { flex-shrink: 0; font-family: var(--vscode-editor-font-family); font-size: 10px; display: flex; gap: 5px; }
.u-file-stat .u-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
.u-file-stat .u-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336); }

.u-diff-scroll { flex: 1; overflow: auto; padding: 8px 10px 40px; }
.u-empty, .u-hint { padding: 16px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.u-hint { text-align: center; opacity: .6; }

/* diff2html pins the file header (position:sticky) so it floats over the code
   as you scroll — kill it so headers stay at the top of their own block. */
.u-diff .d2h-file-header.d2h-sticky-header { position: static; }
/* diff2html absolutely-positions the line-number cells assuming the PAGE
   scrolls. We scroll an inner container, so without a positioned ancestor the
   numbers anchor to the viewport and stay frozen while the code scrolls. Make
   each row the containing block so the numbers scroll with their line. */
.u-diff tr { position: relative; }
.u-diff .d2h-code-line, .u-diff .d2h-code-side-line { cursor: pointer; }
.u-diff tr.u-commented td { box-shadow: inset 3px 0 0 var(--vscode-editorInfo-foreground, #3794ff); }

/* Inline comment editor: injected as a full-width row under the commented line. */
.u-comment-row > td { padding: 0 !important; border: none !important; box-shadow: none !important; background: var(--vscode-editor-background); }
.u-inline-comment {
  /* The row's <td> spans the full (often huge) table width when code lines are
     long. Size the box to the diff scrollport's visible width (--u-view-width,
     set from JS, scrollbar excluded) and pin it left so it stays in view instead
     of stretching to the whole table width. */
  position: sticky;
  left: 8px;
  box-sizing: border-box;
  width: calc(var(--u-view-width, 100%) - 32px);
  margin: 4px 0 8px 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  border-left: 2px solid var(--vscode-editorInfo-foreground, #3794ff);
  border-radius: 6px; padding: 8px;
  background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  font-family: var(--vscode-font-family);
}
.u-ic-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.u-ic-loc { flex: 1; min-width: 0; text-align: left; border: none; background: transparent; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--vscode-textLink-foreground, var(--vscode-descriptionForeground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; }
.u-ic-loc:hover { text-decoration: underline; }
.u-x { border: none; background: transparent; color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; }
.u-inline-comment textarea {
  width: 100%; min-height: 52px; resize: vertical;
  font-family: var(--vscode-font-family); font-size: 12px; padding: 6px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px;
}

.u-toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: var(--vscode-notifications-background, #333); color: var(--vscode-notifications-foreground, #fff);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  padding: 8px 14px; border-radius: 6px; font-size: 12px; z-index: 20;
}

.u-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 30; }
.u-modal { width: 340px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); border-radius: 8px; padding: 14px; }
.u-modal-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
.u-modal-opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: transparent; color: var(--vscode-foreground); }
.u-modal-opt:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.u-modal-opt:disabled { opacity: .45; cursor: default; }
.u-modal-opt strong { font-size: 12px; }
.u-modal-opt span { font-size: 11px; color: var(--vscode-descriptionForeground); }
.u-modal-cancel { width: 100%; border: none; background: transparent; color: var(--vscode-descriptionForeground); padding: 6px; font-size: 12px; }
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) createRoot(root).render(<DiffApp />);
