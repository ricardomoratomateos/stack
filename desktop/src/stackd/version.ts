/** The root package.json's version, baked in by vite.config.ts — the same one stackd reports. */
declare const __STACK_VERSION__: string;
export const APP_VERSION: string = __STACK_VERSION__;

const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);

/**
 * How stackd's version compares with the app's: `null` when they match. A stackd that reports
 * none predates the field, so it is older.
 */
export function stackdDrift(app: string, stackd: string | undefined): 'older' | 'newer' | null {
  if (stackd === app) return null;
  if (stackd === undefined) return 'older';
  const [a, s] = [parts(app), parts(stackd)];
  for (let i = 0; i < 3; i++) if (a[i] !== s[i]) return s[i] < a[i] ? 'older' : 'newer';
  return null;
}
