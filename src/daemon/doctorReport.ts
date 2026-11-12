/** One answer to "why doesn't Stack work on this Mac" (stackd doctor, Settings → Diagnostics). */
export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  /** What to do about it, when not ok. */
  fix?: string;
}

/** Plain text for a terminal or an issue: one line per check, its fix indented below. No Node, so the app shares it. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(0, ...checks.map((c) => c.id.length));
  const lines = checks.flatMap((c) => [
    `${c.ok ? 'ok  ' : 'FAIL'}  ${c.id.padEnd(width)}  ${c.detail}`,
    ...(!c.ok && c.fix ? [`${' '.repeat(width + 8)}fix: ${c.fix}`] : []),
  ]);
  return lines.join('\n') + '\n';
}
