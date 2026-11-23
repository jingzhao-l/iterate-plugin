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
 * v3.21: the cache is now ALSO keyed by session identity. dsh 0.2.3-alpha.1
 * added the `conversation.input.placeholder` chain slot and the session
 * `conversation.session.panel.indicator` list slot — both session-scoped but
 * neither hands the component a `session` object (they pass `sessionId` only).
 * The iterate composer hint / run indicator therefore look the session up by
 * id here. Because the chain `select` is required to stay a pure function of
 * the owner props (the decline decision must not live in a mounted component),
 * the dashboard primes the keyed entry SYNCHRONOUSLY during render via
 * `primeSession` (no subscriber notification — that stays in the effect),
 * so the very first `select` pass already sees the session.
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

/** Keyed store: session identity → last session object the slots saw. */
const byId = new Map<string, CachedSession>()

const listeners = new Set<() => void>()

/** Extract a session identity from an opaque host-shaped session object. */
function sessionIdOf(session: CachedSession): string | null {
  if (!session || typeof session !== 'object') return null
  const s = session as Record<string, unknown>
  const candidates = [s.sessionId, s.id, s.header, s.session] as unknown[]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      for (const k of ['sessionId', 'id']) {
        if (typeof o[k] === 'string' && o[k]) return o[k] as string
      }
    }
  }
  return null
}

/**
 * Publish the session a session-scoped slot was rendered with.
 * Notifies subscribers only when the identity actually changes.
 */
export function noteSession(session: CachedSession): void {
  const id = sessionIdOf(session)
  if (id !== null) byId.set(id, session)
  if (Object.is(session, current)) return
  current = session
  for (const listener of [...listeners]) listener()
}

/**
 * Prime the keyed entry for a session WITHOUT notifying subscribers. Called
 * synchronously during a session slot's render so a chain `select` in the SAME
 * render pass (the composer placeholder, which renders after the dock) already
 * sees the session on its first pass. The effect-side `noteSession` still
 * notifies subscribers for the mounted components.
 */
export function primeSession(session: CachedSession): void {
  const id = sessionIdOf(session)
  if (id !== null) byId.set(id, session)
}

/** Last published session (or `null` before any session slot has rendered). */
export function readSession(): CachedSession {
  return current
}

/**
 * The last session object the slots saw for a given session identity, or
 * `null` when that session has not been rendered (or never had a session
 * object — the honest "nothing echoed yet" state).
 */
export function readSessionById(id: string | undefined | null): CachedSession {
  if (typeof id !== 'string' || !id) return null
  return byId.get(id) ?? null
}

/** Subscribe to session changes; returns the unsubscribe function. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
