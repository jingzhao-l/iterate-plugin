/**
 * test/context-menu.test.ts — v3.14 right-click menu contributions.
 *
 * Covers the pure builders (normal + boundary), the imperative wiring against
 * a fake `contextMenus` service (copy success/failure, open-panel, unregister),
 * and the window open-observatory event bridge (dispatch + no-op outside a
 * browser). No dsh package is imported — the service is probed structurally.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSessionMenuEntries,
  buildFileMenuEntries,
  buildDirectoryMenuEntries,
  registerIterateContextMenus,
  openObservatory,
  OBS_OPEN_EVENT,
  type ContextMenusService,
  type IterateMenuAction,
  type ObsOpenDetail,
} from '../src/client/context-menu.ts'

// ─── Fake service / deps ─────────────────────────────────────────────────────

interface FakeMenu {
  contributions: Array<{ id: string; target: string; order: number; resolve: (t: unknown, s: AbortSignal) => readonly IterateMenuAction[] }>
  notices: Array<{ text: string; success?: boolean }>
  unregistered: number
}

function fakeMenu(): FakeMenu & ContextMenusService {
  const state: FakeMenu = { contributions: [], notices: [], unregistered: 0 }
  return Object.assign(state, {
    register(contribution: { id: string; target: string; order: number; resolve: (t: unknown, s: AbortSignal) => readonly IterateMenuAction[] }) {
      state.contributions.push(contribution)
      return () => { state.unregistered += 1 }
    },
    notify(text: string, success?: boolean) {
      state.notices.push({ text, success })
    },
  })
}

/** Deterministic copy deps. */
function fakeDeps(copyResult: boolean): {
  calls: string[]
  opened: ObsOpenDetail[]
  deps: { copy: (text: string) => Promise<boolean>; openPanel: (detail?: ObsOpenDetail) => void; notify: () => void }
} {
  const calls: string[] = []
  const opened: ObsOpenDetail[] = []
  return {
    calls,
    opened,
    deps: {
      copy: async (text: string) => { calls.push(text); return copyResult },
      openPanel: (detail?: ObsOpenDetail) => { opened.push(detail ?? {}) },
      notify: () => {},
    },
  }
}

const INSTRUCTION = {
  'iterate.preflight': '请调用 `iterate_preflight`',
  'iterate.dry-run': '开始一次仅评审（dry-run）',
  'iterate.resume': '请调用 `iterate_checkpoint`',
  'iterate.pull': '请从磁盘拉取 iterate 快照',
}

describe('context-menu pure builders', () => {
  it('session entries: open panel, preflight, dry-run, resume, pull, in order', () => {
    const entries = buildSessionMenuEntries('zh')
    assert.deepEqual(entries.map((e) => e.id), ['iterate.open-panel', 'iterate.preflight', 'iterate.dry-run', 'iterate.resume', 'iterate.pull'])
    assert.equal(entries[0]?.openTab, 'live')
    assert.equal(entries[1]?.separatorBefore, true, 'preflight starts a new group')
    assert.equal(entries[4]?.separatorBefore, true, 'pull starts the final group')
  })

  it('session entries carry both languages and disable resume without a checkpoint', () => {
    const zh = buildSessionMenuEntries('zh')
    const en = buildSessionMenuEntries('en')
    assert.equal(zh[1]?.label, '复制开跑预检指令')
    assert.equal(en[1]?.label, 'Copy preflight instruction')
    const noCheckpoint = buildSessionMenuEntries('zh', { hasCheckpoint: false })
    assert.equal(noCheckpoint.find((e) => e.id === 'iterate.resume')?.disabled, true)
    assert.equal(zh.find((e) => e.id === 'iterate.resume')?.disabled, false, 'unknown checkpoint keeps resume enabled')
  })

  it('file and directory entries have the expected ids', () => {
    assert.deepEqual(buildFileMenuEntries('zh').map((e) => e.id), ['iterate.review-file', 'iterate.open-panel'])
    assert.deepEqual(buildDirectoryMenuEntries('en').map((e) => e.id), ['iterate.review-dir', 'iterate.preflight', 'iterate.open-panel'])
    assert.equal(buildDirectoryMenuEntries('en')[1]?.separatorBefore, true)
  })
})

describe('context-menu registration', () => {
  it('registers session / file / directory contributions and wires copy instructions', async () => {
    const menu = fakeMenu()
    const calls: string[] = []
    const opened: ObsOpenDetail[] = []
    // Wire notify to the fake service's notice log (mirrors index.ts).
    const deps = {
      copy: async (text: string) => { calls.push(text); return true },
      openPanel: (detail?: ObsOpenDetail) => { opened.push(detail ?? {}) },
      notify: (text: string, success?: boolean) => { menu.notices.push({ text, success }) },
    }
    const dispose = registerIterateContextMenus(menu, deps, (id) => INSTRUCTION[id as keyof typeof INSTRUCTION] ?? '')
    assert.deepEqual(menu.contributions.map((c) => c.target), ['session', 'file', 'directory'])
    assert.ok(menu.contributions.every((c) => c.order === 300), 'all iterate actions order 300')

    // Session: copy the dry-run instruction.
    const sessionActions = menu.contributions[0]!.resolve({ value: { sessionId: 's1', displayTitle: 'demo' } }, new AbortController().signal)
    const dryRun = sessionActions.find((a) => a.id === 'iterate.dry-run')
    assert.ok(dryRun?.run, 'dry-run action has a run callback')
    await dryRun!.run!()
    assert.equal(calls.at(-1), INSTRUCTION['iterate.dry-run'])

    // Open panel action notifies and opens.
    const open = sessionActions.find((a) => a.id === 'iterate.open-panel')
    assert.ok(open?.run)
    await open!.run!()
    assert.equal(opened.at(-1)?.tab, 'live')
    assert.equal(menu.notices.at(-1)?.success, true)
  })

  it('copy failure surfaces the failure label and does not claim success', async () => {
    const menu = fakeMenu()
    const { deps } = fakeDeps(false)
    const dispose = registerIterateContextMenus(menu, deps, (id) => INSTRUCTION[id as keyof typeof INSTRUCTION] ?? '')
    const sessionActions = menu.contributions[0]!.resolve({ value: { sessionId: 's1' } }, new AbortController().signal)
    const preflight = sessionActions.find((a) => a.id === 'iterate.preflight')
    assert.ok(preflight?.failureLabel, 'failure label present')
    let threw = false
    try { await preflight!.run!() } catch { threw = true }
    assert.equal(threw, true, 'a rejected clipboard write throws so the menu shows the failure label')
    assert.equal(menu.notices.length, 0, 'no success toast on failure')
    dispose()
  })

  it('file/directory actions use the scoped instruction key', async () => {
    const menu = fakeMenu()
    const seen: string[] = []
    const { deps } = fakeDeps(true)
    registerIterateContextMenus(menu, deps, (id) => { seen.push(id); return '' })
    const fileActions = menu.contributions[1]!.resolve({ value: { sessionId: 's1', path: 'src/a.ts', line: 12 } }, new AbortController().signal)
    assert.ok(seen.includes('file:src/a.ts:12'), 'file instruction key includes path and line')
    assert.ok(fileActions.find((a) => a.id === 'iterate.review-file'))
    const dirActions = menu.contributions[2]!.resolve({ value: { sessionId: 's1', path: 'src' } }, new AbortController().signal)
    assert.ok(seen.includes('dir:src'), 'directory instruction key includes path')
    assert.ok(dirActions.find((a) => a.id === 'iterate.review-dir'))
  })

  it('file/directory "open command center" actions actually open the panel (regression: no-op)', async () => {
    const menu = fakeMenu()
    const fake = fakeDeps(true)
    registerIterateContextMenus(menu, fake.deps, () => '')
    for (const [i, target] of [[1, 'file'], [2, 'directory']] as const) {
      const actions = menu.contributions[i]!.resolve({ value: { sessionId: 's1', path: 'src' } }, new AbortController().signal)
      const open = actions.find((a) => a.id === 'iterate.open-panel')
      assert.ok(open?.run, `${target} open-panel action must have a run callback (was a no-op in 3.14.0)`)
      await open!.run!()
      assert.equal(fake.opened.at(-1)?.tab, 'live', `${target} open-panel must target the live tab`)
    }
  })

  it('unregister disposes every contribution exactly once and tolerates a throwing register', () => {
    const menu = fakeMenu()
    // Force the session registration to fail: the service must survive and
    // still register the remaining targets.
    let failed = false
    const original = menu.register.bind(menu)
    menu.register = ((contribution: { target: string; id: string; order: number; resolve: (t: unknown, s: AbortSignal) => readonly IterateMenuAction[] }) => {
      if (contribution.target === 'session' && !failed) { failed = true; throw new Error('duplicate id') }
      return original(contribution)
    }) as ContextMenusService['register']
    const dispose = registerIterateContextMenus(menu, fakeDeps(true).deps, (id) => id)
    assert.deepEqual(menu.contributions.map((c) => c.target), ['file', 'directory'], 'session failure does not stop file/directory')
    dispose()
    assert.equal(menu.unregistered, 2)
  })
})

describe('open-observatory event bridge', () => {
  it('no-ops (returns false) when window is unavailable', () => {
    // The server half has no window; openObservatory must degrade.
    assert.equal(typeof openObservatory, 'function')
  })

  it('dispatches the OBS_OPEN_EVENT with the detail payload', () => {
    const events: Array<{ type: string; detail: ObsOpenDetail }> = []
    // Simulate a browser window.
    const originalWindow = globalThis.window
    const listeners = new Map<string, (ev: { type: string; detail: ObsOpenDetail }) => void>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent(ev: { type: string; detail: ObsOpenDetail }) { events.push(ev); return true },
        addEventListener(_t: string, fn: (ev: { type: string; detail: ObsOpenDetail }) => void) { listeners.set(_t, fn) },
        removeEventListener(_t: string) { listeners.delete(_t) },
      },
    })
    try {
      const ok = openObservatory({ sessionId: 's1', tab: 'f11' })
      assert.equal(ok, true)
      assert.equal(events.length, 1)
      assert.equal(events[0]!.type, OBS_OPEN_EVENT)
      assert.equal(events[0]!.detail.sessionId, 's1')
      assert.equal(events[0]!.detail.tab, 'f11')
      assert.equal(listeners.has(OBS_OPEN_EVENT), false, 'listeners are not registered by openObservatory itself')
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    }
  })
})
