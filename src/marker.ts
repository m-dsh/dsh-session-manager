/**
 * The rewind marker's message-source identity.
 *
 * A producer owns its source `kind` outright (`MessageSourceMap` is
 * merge-extensible and has no catch-all `plugin` kind), so this module
 * declares the `dsh-session-manager-rewind` source every marker carries.
 * Kept in a leaf with no cordis or node imports.
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/marker.ts.
 *
 * @module dsh-session-manager/marker
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-manager-rewind': { kind: 'dsh-session-manager-rewind' }
  }
}

/** Producer kind carried by every marker this plugin appends. */
const REWIND_MARKER_KIND = 'dsh-session-manager-rewind'

/** The marker's source: one producer-owned kind, no private fields. */
export const REWIND_MARKER_SOURCE = Object.freeze({ kind: REWIND_MARKER_KIND } as const)