import type { DiffComment } from './types';

const SIDE_NEW = 'line in the new file, after the change';
const SIDE_OLD = 'line in the old file, before the change; it was removed or edited';

/**
 * Serialize review comments into a deterministic markdown prompt for the agent.
 * Comments are grouped by file and ordered by line so the agent reads them in a
 * predictable, top-to-bottom order. Returns '' when there are no comments.
 */
export function buildCommentPrompt(comments: DiffComment[]): string {
  if (comments.length === 0) return '';

  const renamed = new Map<string, string>();
  const byFile = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
    if (c.renamedFrom) renamed.set(c.file, c.renamedFrom);
  }

  const sections: string[] = [];
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const blocks = sorted.map((c) => {
      // Old and new line numbers are different numberings of the same file, so
      // a bare `file:12` is ambiguous on any line that moved. Say which one.
      const loc = c.line !== undefined ? `${file}:${c.line} (${c.side === 'old' ? SIDE_OLD : SIDE_NEW})` : file;
      const codeLine = c.code ? `\n\`${c.code.trim()}\`` : '';
      return `- **${loc}**${codeLine}\n  → ${c.body.trim()}`;
    });
    const from = renamed.get(file);
    sections.push(`### ${file}${from ? ` (renamed from ${from})` : ''}\n${blocks.join('\n')}`);
  }

  return [
    'Please address the following code review comments on the current diff. ' +
      'Make the changes directly; do not open a pull request.',
    '',
    ...sections,
  ].join('\n');
}
