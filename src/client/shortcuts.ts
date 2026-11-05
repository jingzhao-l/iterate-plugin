/**
 * src/client/shortcuts.ts — iterate-plugin keyboard-command contributions.
 *
 * dsh 0.2.2-rc.1 added the *unified keyboard-command* capability
 * (`@deepseek-ai/dsh-client-shortcuts`): any client plugin may register a
 * command with a default key binding and a target resolver, and dsh's own
 * keyboard adapter dispatches the gesture to it. The same capability also lets
 * a context-menu action carry a `commandId` so the menu shows the live
 * keycap next to the action (selection still invokes the action's `run`).
 *
 * This module turns that new upstream capability into a *user-perceivable*
 * iterate surface: instead of hunting for the docked observatory (or
 * right-clicking a session), the user can now press **Cmd/Ctrl+Shift+O** to
 * open the iterate quality command center from anywhere in the session. The
 * matching context-menu action carries the same `commandId`, so the shortcut
 * is discoverable in the right-click menu ("open command center" shows the
 * keycap), and dsh's own shortcut settings page lists it as an editable
 * binding.
 *
 * Design (mirrors `context-menu.ts` and the rest of the client half):
 *   - **Defensive**: the `shortcuts` service is optional and probed at
 *     apply-time (see `readShortcuts` in `index.ts`); a host that predates
 *     0.2.2-rc.1 simply has no keyboard command (the docked panel stays the
 *     entry point). Nothing throws.
 *   - **Pure builder**: `buildObservatoryShortcutCommand` returns the command
 *     shape with no `ctx`/DOM side effects, so it is unit-testable on its own
 *     (label resolution, binding defaults, resolve→run). The imperative
 *     wiring (`openObservatory` / `lang`) is injected by
 *     `registerIterateShortcuts`.
 *   - **Bilingual**: the label resolves against the language passed in at
 *     registration (a language switch is picked up by dsh's own command
 *     catalog on the next render).
 *   - **No external import**: like the rest of the client half, the dsh
 *     `@deepseek-ai/dsh-client-shortcuts` types are NOT imported (no
 *     compile-time coupling to a package a pre-0.2.2-rc.1 host may not have);
 *     the surface below is the structural subset this plugin consumes.
 */

import type { Lang } from './i18n.ts'

// ─── Structural service types (defensive; mirrors ContextMenusService) ───────

/** Stable command identity owned by this plugin (a branded string upstream). */
export const OBSERVATORY_SHORTCUT_ID = 'iterate.open-observatory'

/** One physical key + modifiers; `primary` expands to Meta on macOS. */
export interface ShortcutBinding {
  code: string
  secondCode?: string
  modifiers: readonly string[]
}

/** The dsh command catalog shape this plugin registers. */
export interface ShortcutCommand {
  id: string
  label: () => string
  aliases: readonly string[]
  defaults: Readonly<Record<string, ShortcutBinding>>
  regions: readonly string[]
  modals: readonly string[]
  resolve(context: { region?: string; modal?: string | null; target?: Element | null }): ShortcutResolution
}

/** A resolved command either runs, is blocked with a reason, or passes. */
export type ShortcutResolution =
  | { status: 'handled'; run: () => void }
  | { status: 'blocked'; reason: string }
  | { status: 'pass' }

/** Structural view of the dsh `shortcuts` service this plugin consumes. */
export interface ShortcutsService {
  register(command: ShortcutCommand): () => void
}

/** Injection points the shortcut wiring needs (kept dependency-light for tests). */
export interface ShortcutDeps {
  /** Open the observatory panel (optionally for a session, on a tab). */
  openObservatory: (detail?: { sessionId?: string; tab?: string }) => void
  /** Resolve the current UI language at label-build time. */
  lang: () => Lang
}

/**
 * Default key binding for the observatory command: Cmd/Ctrl+Shift+O
 * ("O" = Open), applied uniformly across every runtime/platform profile so the
 * feature is on by default on desktop and web. If an existing dsh command
 * already owns this combination, `register` throws and the plugin degrades
 * gracefully (no keyboard command; the observatory stays mouse-reachable).
 */
const DEFAULT_BINDING: ShortcutBinding = { code: 'KeyO', modifiers: ['primary', 'shift'] }

const DEFAULT_PROFILES = [
  'desktop:macos',
  'desktop:windows',
  'desktop:linux',
  'web:macos',
  'web:windows',
  'web:linux',
] as const

/** Every runtime/platform profile maps to the same default binding. */
export const OBSERVATORY_DEFAULT_BINDINGS: Readonly<Record<string, ShortcutBinding>> = Object.fromEntries(
  DEFAULT_PROFILES.map((profile) => [profile, DEFAULT_BINDING]),
) as Readonly<Record<string, ShortcutBinding>>

/**
 * Build the pure command descriptor for "open iterate observatory". The
 * resolver always handles the gesture and runs the injected opener; it never
 * blocks (opening the observatory is safe from any region and no modal).
 */
export function buildObservatoryShortcutCommand(deps: ShortcutDeps): ShortcutCommand {
  const label = (): string =>
    deps.lang() === 'zh' ? '打开 iterate 观测台' : 'Open iterate observatory'
  return {
    id: OBSERVATORY_SHORTCUT_ID,
    label,
    aliases: [],
    defaults: OBSERVATORY_DEFAULT_BINDINGS,
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: () => ({ status: 'handled', run: () => deps.openObservatory({}) }),
  }
}

/**
 * Register the observatory keyboard command on the (already-validated)
 * `shortcuts` service. Returns an unregister function; a host without the
 * service is a no-op that returns `() => {}` (callers guard).
 */
export function registerIterateShortcuts(service: ShortcutsService, deps: ShortcutDeps): () => void {
  try {
    const dispose = service.register(buildObservatoryShortcutCommand(deps))
    let done = false
    return () => {
      if (done) return
      done = true
      try {
        dispose()
      } catch {
        /* noop */
      }
    }
  } catch (err) {
    // A duplicate id or an overlapping default binding must not take the
    // plugin down — log and continue with no keyboard command (the docked
    // panel and the context-menu "open" action remain the entry points).
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[iterate-ui] keyboard-command registration failed; continuing without it.', err)
    }
    return () => {}
  }
}
