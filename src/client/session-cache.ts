/**
 * src/client/session-cache.ts — the newest session the session-scoped slots saw.
 *
 * Slot scopes in dsh are not uniform: `conversation.input.dock` (dashboard,
 * observatory) renders inside a session and receives `props.session`, while
 * `settings.section` renders at ROOT scope on the settings page and gets no
 * session at all. The settings card nevertheless needs session-derived state —
 * specifically the config the model echoed back through `iterate_config`, which
 * is what closes the config write → read-back loop.
 *
 * Rather than fake a session for the root slot, the session-scoped slots
 * publish what the host handed them and root-scoped panels subscribe:
 *
 *   session slot renders → noteSession(props.session)
 *   settings panel       → useSessionSnapshot() (via subscribeSession)
 *
 * Design constraints (mirrors `i18n.ts`):
 *   - **Pure**: no React, no DOM — the store is unit-testable on its own, and
 *     the React binding lives next to `useLang()` in index.ts.
 *   - **Identity-compared**: the same session object never notifies twice, so
 *     a slot that re-renders every frame cannot spin its subscribers.
 *   - **Never fabricated**: it only ever holds what the host really passed; an
 *     empty cache reads as "nothing echoed yet", which is the honest state.
 */

/** Anything host-shaped; the plugins only ever pass it through opaque. */
export type CachedSession = unknown

let current: CachedSession = null

const listeners = new Set<() => void>()

/**
 * Publish the session a session-scoped slot was rendered with.
 * Notifies subscribers only when the identity actually changes.
 */
export function noteSession(session: CachedSession): void {
  if (Object.is(session, current)) return
  current = session
  for (const listener of [...listeners]) listener()
}

/** Last published session (or `null` before any session slot has rendered). */
export function readSession(): CachedSession {
  return current
}

/** Subscribe to session changes; returns the unsubscribe function. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
