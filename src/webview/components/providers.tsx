import React from 'react';

/** Claude's coral sunburst, approximated as an 8-ray asterisk. */
function ClaudeSpark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"
        stroke="#D97757" strokeWidth="1.8" strokeLinecap="round"
      />
    </svg>
  );
}

/** opencode's terminal block: rounded square with a prompt chevron. */
function OpenCodeMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" stroke="#9DA5B4" strokeWidth="1.6" />
      <path d="M5.2 5.8 8 8 5.2 10.2M9 10.5h2" stroke="#9DA5B4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** OpenAI's knot, reduced to a single loop at this size. */
function CodexMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" stroke="#10A37F" strokeWidth="1.7" />
      <path d="M8 2.6c2.4 1.6 3.6 3.4 3.6 5.4s-1.2 3.8-3.6 5.4C5.6 11.8 4.4 10 4.4 8S5.6 4.2 8 2.6Z"
        stroke="#10A37F" strokeWidth="1.4" />
    </svg>
  );
}

/** Stand-in for a provider this build does not know about (an older session's id). */
function UnknownMark({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="#6E7681" strokeWidth="1.6" strokeDasharray="2.4 2" />
    </svg>
  );
}

export type ProviderVisual = { icon: (props: { size?: number }) => React.ReactElement; label: string };

/** Brand icon + display name per provider. */
const PROVIDER_VISUAL: Record<string, ProviderVisual> = {
  claude:   { icon: ClaudeSpark,  label: 'claude' },
  codex:    { icon: CodexMark,    label: 'codex' },
  opencode: { icon: OpenCodeMark, label: 'opencode' },
};

const UNKNOWN_VISUAL: ProviderVisual = { icon: UnknownMark, label: 'agent' };

/**
 * Never falls back to Claude. Sessions recorded before providers existed, and
 * ids from a newer build, are genuinely unknown — painting them with Claude's
 * mark asserts something we do not know, and Claude is no longer the safe guess.
 */
export function visualFor(provider?: string): ProviderVisual {
  return (provider && PROVIDER_VISUAL[provider]) || UNKNOWN_VISUAL;
}

/** Order shown in the dropdown — stable, so the list never reshuffles under the cursor. */
export const PROVIDER_ORDER = ['claude', 'codex', 'opencode'] as const;

export function ProviderMark({ provider, size = 12 }: { provider?: string; size?: number }) {
  const visual = visualFor(provider);
  return <visual.icon size={size} />;
}
