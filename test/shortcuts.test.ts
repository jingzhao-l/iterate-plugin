/**
 * test/shortcuts.test.ts — v3.15 keyboard-command contributions.
 *
 * Covers the pure command builder (label resolution, default bindings across
 * every runtime/platform profile, regions, modals, resolve→run), the imperative
 * wiring against a fake `shortcuts` service (register exactly once, disposer
 * idempotent, registration-throw degrades to a no-op), and the cross-module
 * contract that the context-menu "open command center" action carries the same
 * `commandId` so the shortcut is discoverable in the right-click menu. No dsh
 * package is imported — the service is probed structurally.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OBSERVATORY_SHORTCUT_ID,
  buildObservatoryShortcutCommand,
  registerIterateShortcuts,
  type ShortcutsService,
  type ShortcutCommand,
} from '../src/client/shortcuts.ts'
import {
  registerIterateContextMenus,
  type ContextMenusService,
  type IterateMenuAction,
} from '../src/client/context-menu.ts'
import type { Lang } from '../src/client/i18n.ts'

// ─── Fake service / deps ─────────────────────────────────────────────────────

interface FakeShortcuts {
  commands: ShortcutCommand[]
  unregistered: number
}

function fakeShortcuts(): FakeShortcuts & ShortcutsService {
  const state: FakeShortcuts = { commands: [], unregistered: 0 }
  return Object.assign(state, {
    register(command: ShortcutCommand) {
      state.commands.push(command)
      return () => { state.unregistered += 1 }
    },
  })
}

function deps(lang: Lang = 'en') {
  const opened: Array<{ sessionId?: string; tab?: string }> = []
  return {
    opened,
    deps: {
      openObservatory: (d?: { sessionId?: string; tab?: string }) => { opened.push(d ?? {}) },
      lang: () => lang,
    },
  }
}

function resolveOf(cmd: ShortcutCommand) {
  return cmd.resolve({ region: 'page', modal: null, target: null })
}

// ─── Pure builder ────────────────────────────────────────────────────────────

describe('buildObservatoryShortcutCommand', () => {
  it('registers the canonical command id for the open-observatory action', () => {
    const { deps: d } = deps()
    const cmd = buildObservatoryShortcutCommand(d)
    assert.equal(cmd.id, OBSERVATORY_SHORTCUT_ID)
    assert.equal(cmd.id, 'iterate.open-observatory')
  })

  it('resolves the label against the current language (en/zh)', () => {
    const en = buildObservatoryShortcutCommand(deps('en').deps)
    const zh = buildObservatoryShortcutCommand(deps('zh').deps)
    assert.equal(en.label(), 'Open iterate observatory')
    assert.equal(zh.label(), '打开 iterate 观测台')
  })

  it('declares a default binding on every runtime/platform profile', () => {
    const cmd = buildObservatoryShortcutCommand(deps().deps)
    const profiles = ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows', 'web:linux']
    for (const p of profiles) {
      const b = cmd.defaults[p]
      assert.ok(b, `missing default binding for ${p}`)
      assert.equal(b.code, 'KeyO')
      assert.deepEqual([...b.modifiers], ['primary', 'shift'])
    }
  })

  it('covers every input region and no modal', () => {
    const cmd = buildObservatoryShortcutCommand(deps().deps)
    assert.deepEqual([...cmd.regions].sort(), ['editable', 'page', 'terminal'])
    assert.deepEqual([...cmd.modals], [])
    assert.deepEqual([...cmd.aliases], [])
  })

  it('handles the gesture and runs the injected opener', () => {
    const { opened, deps: d } = deps()
    const cmd = buildObservatoryShortcutCommand(d)
    const resolution = resolveOf(cmd)
    assert.equal(resolution.status, 'handled')
    if (resolution.status === 'handled') {
      assert.equal(opened.length, 0)
      resolution.run()
      assert.equal(opened.length, 1)
      assert.deepEqual(opened[0], {})
    }
  })

  it('never blocks the gesture from any region', () => {
    const cmd = buildObservatoryShortcutCommand(deps().deps)
    for (const region of ['page', 'editable', 'terminal']) {
      const r = cmd.resolve({ region, modal: null, target: null })
      assert.equal(r.status, 'handled', `region ${region} should be handled`)
    }
  })
})

// ─── Imperative wiring ───────────────────────────────────────────────────────

describe('registerIterateShortcuts', () => {
  it('registers exactly one command and returns a disposer', () => {
    const svc = fakeShortcuts()
    const { deps: d } = deps()
    const dispose = registerIterateShortcuts(svc, d)
    assert.equal(svc.commands.length, 1)
    assert.equal(svc.commands[0]!.id, OBSERVATORY_SHORTCUT_ID)
    dispose()
    assert.equal(svc.unregistered, 1)
  })

  it('disposer is idempotent and never throws', () => {
    const svc = fakeShortcuts()
    const { deps: d } = deps()
    const dispose = registerIterateShortcuts(svc, d)
    dispose()
    dispose()
    assert.equal(svc.unregistered, 1) // the fake's disposer is called once per real dispose
  })

  it('a throwing register (duplicate id / conflicting binding) degrades to a no-op', () => {
    const state: FakeShortcuts = { commands: [], unregistered: 0 }
    const svc: ShortcutsService = Object.assign(state, {
      register() { throw new Error('duplicate id iterate.open-observatory') },
    })
    const { deps: d } = deps()
    const dispose = registerIterateShortcuts(svc, d)
    assert.equal(state.commands.length, 0)
    assert.doesNotThrow(() => dispose())
  })

  it('a throwing disposer does not propagate', () => {
    const state: FakeShortcuts = { commands: [], unregistered: 0 }
    const svc: ShortcutsService = Object.assign(state, {
      register() { return () => { throw new Error('dispose failed') } },
    })
    const { deps: d } = deps()
    const dispose = registerIterateShortcuts(svc, d)
    assert.doesNotThrow(() => dispose())
  })
})

// ─── Cross-module contract: menu action carries the commandId ────────────────

type FakeMenuContribution = { target: string; resolve: (t: unknown, s: AbortSignal) => readonly IterateMenuAction[] }

describe('context-menu open action carries the observatory commandId', () => {
  function fakeMenuService(contributions: FakeMenuContribution[]): ContextMenusService {
    return Object.assign({
      register(c: FakeMenuContribution) {
        contributions.push(c)
        return () => {}
      },
      notify() {},
    }, {})
  }

  it('session "open command center" action advertises the shortcut', () => {
    const contributions: FakeMenuContribution[] = []
    const svc = fakeMenuService(contributions)
    registerIterateContextMenus(svc, { copy: async () => true, openPanel: () => {}, notify: () => {} }, () => '')
    const session = contributions.find((c) => c.target === 'session')
    assert.ok(session, 'expected a session contribution')
    const open = session.resolve({ value: { sessionId: 's1' } }, new AbortController().signal)
      .find((a) => a.id === 'iterate.open-panel')
    assert.ok(open, 'expected an open-panel action')
    assert.equal(open.commandId, OBSERVATORY_SHORTCUT_ID)
  })

  it('file and directory "open command center" actions advertise the shortcut', () => {
    const contributions: FakeMenuContribution[] = []
    const svc = fakeMenuService(contributions)
    registerIterateContextMenus(svc, { copy: async () => true, openPanel: () => {}, notify: () => {} }, () => '')
    for (const target of ['file', 'directory']) {
      const c = contributions.find((x) => x.target === target)
      assert.ok(c, `expected a ${target} contribution`)
      const open = c.resolve({ value: { path: '/x' } }, new AbortController().signal)
        .find((a) => a.id === 'iterate.open-panel')
      assert.ok(open, `expected an open-panel action on ${target}`)
      assert.equal(open.commandId, OBSERVATORY_SHORTCUT_ID, `${target} open action should carry the shortcut`)
    }
  })
})
