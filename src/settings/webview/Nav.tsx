import React, { useEffect, useRef } from 'react';
import { SECTION_IDS, type SectionId } from '../draft';
import { PRODUCT_NAME } from '../../webview/brand';
import type { SettingsSnapshot } from '../types';
import { SECTION_META, STR } from './strings';
import { Icon } from './ui';

/** The sidebar's mark: stacked tiles with a prompt cut out of the front one (ids prefixed — one document, many marks). */
function Mark() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 100 100">
      <defs>
        <mask id="st-mark-mid" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" /><rect x="11" y="31" width="58" height="58" rx="16" fill="#000" />
        </mask>
        <mask id="st-mark-back" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" /><rect x="21" y="21" width="58" height="58" rx="16" fill="#000" />
        </mask>
        <mask id="st-mark-front" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <path d="M27.5 52l9 8-9 8" fill="none" stroke="#000" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M42.5 68h11" stroke="#000" strokeWidth="5.5" strokeLinecap="round" />
        </mask>
      </defs>
      <rect x="35" y="15" width="50" height="50" rx="12" fill="currentColor" opacity="0.32" mask="url(#st-mark-back)" />
      <rect x="25" y="25" width="50" height="50" rx="12" fill="currentColor" opacity="0.6" mask="url(#st-mark-mid)" />
      <rect x="15" y="35" width="50" height="50" rx="12" fill="currentColor" mask="url(#st-mark-front)" />
    </svg>
  );
}

/** The two places a setting can live, so the cards' badges have a key. */
function Legend({ snap, hasRepo, onOpenFile }: { snap: SettingsSnapshot; hasRepo: boolean; onOpenFile: () => void }) {
  const file = snap.projectFile;
  const repoNote = !hasRepo ? STR.noRepoTitle : file.present ? file.relative : STR.fileMissing;
  return (
    <div className="st-legend">
      <span className="st-legend-title">Saved to</span>
      <div className="st-legend-item" data-state={hasRepo && !file.present ? 'missing' : undefined}>
        <Icon name="repo" />
        <div>
          <strong>{STR.legendRepo}</strong>
          <small title={file.path}>{repoNote}</small>
          <small>{STR.legendRepoHint}</small>
          {hasRepo && file.present && <button type="button" className="st-link" onClick={onOpenFile}>{STR.openFile}</button>}
        </div>
      </div>
      <div className="st-legend-item">
        <Icon name="account" />
        <div><strong>{STR.legendMe}</strong><small>{STR.legendMeHint}</small></div>
      </div>
    </div>
  );
}

export function Nav({ snap, hasRepo, section, dirty, broken, onSelect, onOpenFile }: {
  snap: SettingsSnapshot; hasRepo: boolean; section: SectionId; dirty: SectionId[]; broken: SectionId[];
  onSelect: (id: SectionId) => void; onOpenFile: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  // On narrow widths the tabs scroll sideways; keep the current one in view (e.g. when opened on #docker).
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  return (
    <nav className="st-nav" aria-label={STR.settings} ref={navRef}>
      <div className="st-brand">
        <span className="st-mark"><Mark /></span>
        <span><span className="st-brand-name">{PRODUCT_NAME}</span> <span className="st-brand-sub">{STR.settings}</span></span>
      </div>
      <ul className="st-navlist">
        {SECTION_IDS.map((id) => {
          const state = broken.includes(id) ? 'error' : dirty.includes(id) ? 'dirty' : undefined;
          return (
            <li key={id}>
              <button type="button" className="st-navitem" aria-current={section === id ? 'page' : undefined} onClick={() => onSelect(id)}>
                <Icon name={SECTION_META[id].icon} />
                <span className="st-navlabel">{SECTION_META[id].label}</span>
                {state && <span className="st-dot" data-kind={state} role="img" aria-label={state === 'error' ? 'Has a problem' : STR.unsaved} />}
              </button>
            </li>
          );
        })}
      </ul>
      <Legend snap={snap} hasRepo={hasRepo} onOpenFile={onOpenFile} />
    </nav>
  );
}
