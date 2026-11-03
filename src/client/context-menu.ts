/**
 * src/client/context-menu.ts — iterate-plugin right-click menu contributions.
 *
 * dsh 0.2.2-alpha.3 added the *unified context-menu* capability
 * (`@deepseek-ai/dsh-client-ui-context-menu`): any client plugin may register
 * actions that appear on right-click / Shift+F10 / ContextMenu key over a
 * Session, file, directory, URL, image, tab, or workspace, without importing
 * a React component. The captured target stays fixed even when selection
 * changes, and contributions are withdrawn automatically when the plugin
 * unloads.
 *
 * This module turns that new upstream capability into a *user-perceivable*
 * iterate surface: instead of only being reachable through the docked
 * observatory and the empty-dashboard CTA, the iterate entry points now also
 * hang off the native right-click menus — on a Session (open the quality
 * command center, copy a preflight / dry-run / resume / disk-snapshot
 * instruction), on a file (dry-run review scoped to that file), and on a
 * directory (scoped review + preflight).
 *
 * Design (mirrors the rest of the client half):
 *   - **Defensive**: the `contextMenus` service is optional and probed at
 *     apply-time; a host that predates 0.2.2-alpha.3 simply has no menu
 *     entries (the docked panel remains the entry point). Nothing throws.
 *   - **Pure builders**: `buildSessionMenuEntries` / `buildFileMenuEntries` /
 *     `buildDirectoryMenuEntries` return *localized descriptors* with no DOM
 *     or clipboard side effects, so they are unit-testable on their own
 *     (normal + empty + boundary). The imperative wiring (`copy` / `openPanel`
 *     / `notify`) is injected by `registerIterateContextMenus`.
 *   - **Bilingual**: every label carries zh + en and resolves against the
 *     language passed in (the caller reads `getLang()` at menu-build time, so
 *     a language switch is picked up on the next open).
 *
 * Event bridge: the observatory is a React panel with its own open/tab state.
 * The browser client cannot call harness tools, so the "open command center"
 * menu action dispatches a window CustomEvent (`OBS_OPEN_EVENT`) that the
 * ObservatoryPanel listens for — the panel expands and switches tab without
 * any cross-plugin import. The event carries an optional `sessionId` so a
 * right-click in the session sidebar targets the right session's panel and is
 * ignored by every other mounted panel.
 */

import { getLang, type Lang } from './i18n.ts'

// ─── Structural service types (defensive; mirrors SlotsService) ──────────────
//
// The dsh client runtime is not type-imported (no compile-time coupling to a
// package a pre-0.2.2-alpha.3 host may not have). The surface below is the
// subset this plugin consumes; `register` is only ever called when a service
// with the right shape is present.

/** A right-click target this plugin contributes actions to. */
export type IterateMenuTarget =
  | { kind: 'session'; value: { sessionId: string; displayTitle?: string } }
  | { kind: 'file'; value: { sessionId: string; path: string; line?: number } }
  | { kind: 'directory'; value: { sessionId: string; path: string } }

/** One menu action (presentation + optional execution). */
export interface IterateMenuAction {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  /** Localized operation + recovery guidance when `run` rejects. */
  failureLabel?: string
  run?: () => void | Promise<void>
}

/** A namespaced contribution, ordered within its target family. */
export interface IterateMenuContribution<K extends string> {
  id: string
  target: K
  order: number
  resolve(target: unknown, signal: AbortSignal): readonly IterateMenuAction[]
}

/** Structural view of the dsh `contextMenus` service this plugin consumes. */
export interface ContextMenusService {
  register<K extends string>(contribution: IterateMenuContribution<K>): () => void
  notify(
    text: string,
    success?: boolean,
    action?: { label: string; run: () => void | Promise<void>; failureLabel: string },
  ): void
}

// ─── Observatory open event bridge ───────────────────────────────────────────

/** Window event that asks the (matching) ObservatoryPanel to expand. */
export const OBS_OPEN_EVENT = 'iterate-plugin:open-observatory'

/** Payload carried by {@link OBS_OPEN_EVENT}. */
export interface ObsOpenDetail {
  /** Optional target session; omitted = open whatever panel is mounted. */
  sessionId?: string
  /** Tab key to switch to (`live` by default). */
  tab?: string
}

/**
 * Dispatch the "open observatory" event. No-op outside a browser (SSR / test
 * environments without `window`). Returns whether the event was dispatched.
 */
export function openObservatory(detail?: ObsOpenDetail): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false
  try {
    window.dispatchEvent(new CustomEvent<ObsOpenDetail>(OBS_OPEN_EVENT, { detail: detail ?? {} }))
    return true
  } catch {
    return false
  }
}

// ─── Localized descriptors (pure, testable) ──────────────────────────────────

/** The action ids this plugin registers, for tests + duplicate guards. */
export const SESSION_MENU_IDS = ['iterate.open-panel', 'iterate.preflight', 'iterate.dry-run', 'iterate.resume', 'iterate.pull'] as const
export const FILE_MENU_IDS = ['iterate.review-file', 'iterate.open-panel'] as const
export const DIRECTORY_MENU_IDS = ['iterate.review-dir', 'iterate.preflight', 'iterate.open-panel'] as const

interface MenuEntry {
  id: string
  label: string
  instruction?: string
  /** Tab key to open when this entry is the "open panel" action. */
  openTab?: string
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
}

/** Bilingual labels; resolved by `pick` at build time. */
const LABELS: Record<string, { zh: string; en: string }> = {
  'iterate.open-panel': { zh: '打开 iterate 质量指挥中心', en: 'Open iterate command center' },
  'iterate.preflight': { zh: '复制开跑预检指令', en: 'Copy preflight instruction' },
  'iterate.dry-run': { zh: '复制 dry-run 审查指令', en: 'Copy dry-run review instruction' },
  'iterate.resume': { zh: '复制断点恢复指令', en: 'Copy checkpoint-resume instruction' },
  'iterate.pull': { zh: '复制拉取磁盘快照指令', en: 'Copy disk-snapshot pull instruction' },
  'iterate.review-file': { zh: '复制「仅审查此文件」指令', en: 'Copy "review this file only" instruction' },
  'iterate.review-dir': { zh: '复制「仅审查此目录」指令', en: 'Copy "review this directory only" instruction' },
}

/** Pick a localized label; unknown ids degrade to the raw id (never throw). */
function pick(id: string, lang: Lang): string {
  const entry = LABELS[id]
  if (!entry) return id
  return lang === 'zh' ? entry.zh : entry.en
}

/** Copy-failure guidance (a menu action's `failureLabel`). */
const COPY_FAILURE: Record<'zh' | 'en', string> = {
  zh: '复制失败：剪贴板被拒绝。请改为在观测台面板里用同一指令的「复制」按钮，或手动选中指令文本复制。',
  en: 'Copy failed: clipboard denied. Use the matching "Copy" button in the observatory panel, or select the instruction text manually.',
}

/** Build the Session target menu entries (pure). */
export function buildSessionMenuEntries(lang: Lang, opts?: { hasCheckpoint?: boolean }): MenuEntry[] {
  return [
    { id: 'iterate.open-panel', label: pick('iterate.open-panel', lang), openTab: 'live' },
    { id: 'iterate.preflight', label: pick('iterate.preflight', lang), separatorBefore: true },
    { id: 'iterate.dry-run', label: pick('iterate.dry-run', lang) },
    { id: 'iterate.resume', label: pick('iterate.resume', lang), disabled: opts?.hasCheckpoint === false },
    { id: 'iterate.pull', label: pick('iterate.pull', lang), separatorBefore: true },
  ]
}

/** Build the File target menu entries (pure). */
export function buildFileMenuEntries(lang: Lang): MenuEntry[] {
  return [
    { id: 'iterate.review-file', label: pick('iterate.review-file', lang) },
    { id: 'iterate.open-panel', label: pick('iterate.open-panel', lang) },
  ]
}

/** Build the Directory target menu entries (pure). */
export function buildDirectoryMenuEntries(lang: Lang): MenuEntry[] {
  return [
    { id: 'iterate.review-dir', label: pick('iterate.review-dir', lang) },
    { id: 'iterate.preflight', label: pick('iterate.preflight', lang), separatorBefore: true },
    { id: 'iterate.open-panel', label: pick('iterate.open-panel', lang) },
  ]
}

// ─── Imperative wiring (register + run callbacks) ────────────────────────────

/** Injection points the menu wiring needs (kept dependency-light for tests). */
export interface IterateMenuDeps {
  /** Copy an instruction; resolves to whether the clipboard write succeeded. */
  copy: (text: string) => Promise<boolean>
  /** Open the observatory panel (optionally for a session, on a tab). */
  openPanel: (detail?: ObsOpenDetail) => void
  /** Show the shared toast. */
  notify: (text: string, success?: boolean, action?: { label: string; run: () => void | Promise<void>; failureLabel: string }) => void
}

/** Map a pure entry to a runnable menu action, wiring the injected deps. */
function toAction(entry: MenuEntry, deps: IterateMenuDeps, lang: Lang): IterateMenuAction {
  const action: IterateMenuAction = {
    id: entry.id,
    label: entry.label,
    danger: entry.danger,
    separatorBefore: entry.separatorBefore,
  }
  if (entry.disabled) action.disabled = true
  if (entry.openTab) {
    action.run = () => {
      deps.openPanel({ tab: entry.openTab })
      deps.notify(lang === 'zh' ? '已打开 iterate 观测台。' : 'Iterate observatory opened.', true)
    }
    return action
  }
  if (entry.instruction) {
    const text = entry.instruction
    const failureLabel = COPY_FAILURE[lang]
    action.failureLabel = failureLabel
    action.run = async () => {
      const ok = await deps.copy(text)
      if (!ok) throw new Error(failureLabel)
      deps.notify(lang === 'zh' ? '指令已复制，粘贴给模型即可。' : 'Instruction copied — paste it to the model.', true)
    }
  }
  return action
}

/**
 * Register this plugin's context-menu contributions on the (already-validated)
 * `contextMenus` service. Returns an unregister function; a host without the
 * service is a no-op that returns `() => {}` (callers guard).
 */
export function registerIterateContextMenus(
  service: ContextMenusService,
  deps: IterateMenuDeps,
  instructionByEntry: (id: string) => string,
): () => void {
  const unregister: Array<() => void> = []

  const register = <K extends string>(target: K, order: number, build: (lang: Lang, target: unknown) => MenuEntry[]) => {
    try {
      const dispose = service.register({
        id: `iterate-plugin.${target}`,
        target,
        order,
        resolve: (t, _signal) => {
          const lang = getLang()
          return build(lang, t).map((entry) => {
            const full: MenuEntry = { ...entry, instruction: entry.instruction ?? instructionByEntry(entry.id) }
            return toAction(full, deps, lang)
          })
        },
      })
      unregister.push(dispose)
    } catch (err) {
      // A duplicate contribution id or an unsupported target family must not
      // take the plugin down — log and continue with the remaining targets.
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[iterate-ui] context-menu registration failed for target', target, err)
      }
    }
  }

  register('session', 300, (_lang, t) => {
    const target = t as { value?: { sessionId?: string } } | undefined
    return buildSessionMenuEntries(getLang(), { hasCheckpoint: target?.value?.sessionId ? true : undefined })
  })
  register('file', 300, (_lang, t) => {
    const target = t as { value?: { path?: string; line?: number } } | undefined
    return buildFileMenuEntries(getLang()).map((e) => ({
      ...e,
      instruction: e.id === 'iterate.review-file'
        ? instructionByEntry(`file:${target?.value?.path ?? ''}${typeof target?.value?.line === 'number' ? `:${target.value.line}` : ''}`)
        : e.instruction,
    }))
  })
  register('directory', 300, (_lang, t) => {
    const target = t as { value?: { path?: string } } | undefined
    return buildDirectoryMenuEntries(getLang()).map((e) => ({
      ...e,
      instruction: e.id === 'iterate.review-dir'
        ? instructionByEntry(`dir:${target?.value?.path ?? ''}`)
        : e.instruction,
    }))
  })

  return () => {
    for (const dispose of unregister.splice(0)) {
      try { dispose() } catch { /* noop */ }
    }
  }
}
