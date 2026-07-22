import type { DiffComment } from './types';

/**
 * Serialize review comments into a deterministic markdown prompt for the agent.
 * Comments are grouped by file and ordered by line so the agent reads them in a
 * predictable, top-to-bottom order. Returns '' when there are no comments.
 */
export function buildCommentPrompt(comments: DiffComment[]): string {
  if (comments.length === 0) return '';

  const byFile = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }

  const sections: string[] = [];
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const blocks = sorted.map((c) => {
      const loc = c.line !== undefined ? `${file}:${c.line}` : file;
      const codeLine = c.code ? `\n\`${c.code.trim()}\`` : '';
      return `- **${loc}**${codeLine}\n  → ${c.body.trim()}`;
    });
    sections.push(`### ${file}\n${blocks.join('\n')}`);
  }

  return [
    'Please address the following code review comments on the current diff. ' +
      'Make the changes directly; do not open a pull request.',
    '',
    ...sections,
  ].join('\n');
}
