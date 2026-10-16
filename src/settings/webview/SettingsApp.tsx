import React, { useEffect, useRef, useState } from 'react';
import { SECTION_IDS, type SectionId } from '../draft';
import { SECTION_META, SECTION_SCOPES, STR } from './strings';
import { Icon } from './ui';
import { AppearanceSection } from './sections/AppearanceSection';
import type { Ctx } from './sections/context';
import { DebuggingSection } from './sections/DebuggingSection';
import { DockerSection } from './sections/DockerSection';
import { GeneralSection } from './sections/GeneralSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { ScriptsSection } from './sections/ScriptsSection';
import { WorktreesSection } from './sections/WorktreesSection';
import { Nav } from './Nav';
import { SaveBar } from './SaveBar';
import { useSettings } from './useSettings';

const SECTIONS: Record<SectionId, (p: { ctx: Ctx }) => React.ReactElement> = {
  general: GeneralSection, appearance: AppearanceSection, worktrees: WorktreesSection, scripts: ScriptsSection,
  docker: DockerSection, debugging: DebuggingSection, notifications: NotificationsSection,
};

/** `#docker` opens on that section — handy for a link, and for looking at one without clicking. */
function initialSection(): SectionId {
  const hash = window.location.hash.slice(1);
  return SECTION_IDS.find((id) => id === hash) ?? 'general';
}

export function SettingsApp() {
  const { snap, ctx, model, pending, notices, save, discard } = useSettings();
  const [section, setSection] = useState<SectionId>(initialSection);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [section]);

  // ⌘S / Ctrl+S saves, as anywhere else in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (!snap || !ctx || !model) {
    return <div className="st fm-aside" role="status" style={{ placeItems: 'center' }}>{STR.loading}</div>;
  }

  const Body = SECTIONS[section];
  const meta = SECTION_META[section];
  // The accent follows the style being chosen, not only the one saved, so picking a card repaints the page at once.
  return (
    <div className={`st fm-${ctx.user.sidebarStyle}`}>
      <Nav snap={snap} hasRepo={ctx.hasRepo} section={section} dirty={model.dirty} broken={model.broken} onSelect={setSection} onOpenFile={ctx.openFile} />
      <main className="st-main" ref={mainRef} aria-labelledby="st-title">
        <div className="st-content">
          <header className="st-head">
            <h2 id="st-title">{meta.title}</h2>
            <p>{meta.description}</p>
            <ul className="st-head-scopes" aria-label="Saved to">
              {SECTION_SCOPES[section].map((scope) => scope === 'repo' ? (
                <li key={scope} title={STR.scopeRepoTitle(ctx.file)}>
                  <Icon name="repo" /><strong>{STR.scopeRepo}</strong>
                  {ctx.hasRepo ? <><code>{ctx.file}</code><span>· {STR.legendRepoHint.toLowerCase()}</span></> : <span>{STR.noRepoTitle}</span>}
                </li>
              ) : (
                <li key={scope} title={STR.scopeMeTitle}>
                  <Icon name="account" /><strong>{STR.scopeMe}</strong><span>{STR.legendMeHint}</span>
                </li>
              ))}
            </ul>
          </header>
          <Body ctx={ctx} />
        </div>
        <SaveBar
          pending={pending > 0} notices={notices} dirty={model.dirty} errorCount={model.errorCount}
          onSave={save} onDiscard={discard}
        />
      </main>
    </div>
  );
}
