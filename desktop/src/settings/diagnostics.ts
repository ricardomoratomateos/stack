import type { Check } from '@core/daemon/doctorReport';
import { stackdDrift } from '../stackd/version';

export type { Check };

/**
 * The Diagnostics list: the app's own check (stackd's version against the app's) ahead of
 * stackd's `doctor`. When stackd does not answer, that is the one failure shown, with the
 * terminal command that runs the rest without it.
 */
export function diagnostics(app: string, running: boolean, stackdVersion: string | undefined, doctor: Check[] | { error: string }): Check[] {
  if (!running) {
    return [{
      id: 'stackd', ok: false, detail: 'stackd is not running.',
      fix: 'Start it from the app, or run `node <Stack.app>/Contents/Resources/stackd/stackd.js doctor` in a terminal for the other checks.',
    }];
  }
  const drift = stackdDrift(app, stackdVersion);
  const version: Check = drift
    ? { id: 'version', ok: false, detail: `stackd ${stackdVersion ?? '(no version)'} is ${drift} than the app (${app}).`, fix: 'Restart stackd from the banner at the top of the window.' }
    : { id: 'version', ok: true, detail: `stackd and app ${app}` };
  if ('error' in doctor) return [version, { id: 'doctor', ok: false, detail: `stackd could not run its checks: ${doctor.error}`, fix: drift ? 'Restart stackd.' : undefined }];
  return [version, ...doctor];
}
