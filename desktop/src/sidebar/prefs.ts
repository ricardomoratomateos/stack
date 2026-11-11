import { PROVIDER_IDS, type ProviderId } from '@core/ports/IAgentProvider';

const KEY = 'stack.defaultProvider';

/** The app's own default agent (the extension keeps it in `stack.defaultProvider`); undefined = stackd's. */
export function loadDefaultProvider(): ProviderId | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return PROVIDER_IDS.find((id) => id === v);
  } catch {
    return undefined;
  }
}

export function saveDefaultProvider(id: ProviderId): void {
  try { localStorage.setItem(KEY, id); } catch { /* private mode: the choice lasts until reload */ }
}
