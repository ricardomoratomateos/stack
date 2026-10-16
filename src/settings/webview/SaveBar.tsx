import React from 'react';
import type { SectionId } from '../draft';
import type { Notice } from './useSettings';
import { SECTION_META, STR } from './strings';
import { Button, Icon } from './ui';

/**
 * One bar for the whole page: it appears when anything is unsaved, says where,
 * and saves both scopes at once (each to its own place). After a save it reports
 * what the file read back with.
 */
export function SaveBar({ pending, notices, dirty, errorCount, onSave, onDiscard }: {
  pending: boolean; notices: Notice[]; dirty: SectionId[]; errorCount: number; onSave: () => void; onDiscard: () => void;
}) {
  const problems = notices.flatMap((n) => n.problems);
  if (!pending && dirty.length === 0 && notices.length === 0) return null;

  let message: React.ReactNode;
  if (pending) message = <><Icon name="loading" spin /><span>{STR.saving}</span></>;
  else if (dirty.length > 0 && errorCount > 0) message = <><span className="codicon codicon-error" data-tone="bad" aria-hidden="true" /><span>{STR.fixToSave(errorCount)}</span></>;
  else if (dirty.length > 0) {
    message = <><span className="st-dot" aria-hidden="true" /><span>{STR.unsaved} <small>{STR.inSections(dirty.map((id) => SECTION_META[id].label).join(', '))}</small></span></>;
  } else if (problems.length > 0) message = <><span className="codicon codicon-warning" data-tone="bad" aria-hidden="true" /><span title={problems.join(' · ')}>{problems.join(' · ')}</span></>;
  else message = <><span className="codicon codicon-check" data-tone="ok" aria-hidden="true" /><span>{STR.saved}</span></>;

  return (
    <div className="st-bar-wrap">
      <div className="st-bar" role="status" aria-live="polite">
        <div className="st-bar-msg">{message}</div>
        {dirty.length > 0 && (
          <div className="st-bar-actions">
            <Button kind="ghost" onClick={onDiscard} disabled={pending}>{STR.discard}</Button>
            <Button kind="primary" onClick={onSave} disabled={pending || errorCount > 0}>{STR.save}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
