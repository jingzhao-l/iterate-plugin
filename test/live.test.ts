/**
 * test/live.test.ts — unit tests for the live reviewer-activity feed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  classifyTool,
  appendLive,
  readLive,
  liveFilePath,
  LIVE_MAX_ENTRIES,
  registerLiveCapture,
  type LiveActivityEntry,
} from '../src/live.ts'

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-live-'))
  return dir
}

test('classifyTool: read_file maps to a read activity with file path', () => {
  const entry = classifyTool('read_file', { path: 'src/a.ts' }, '/tmp')
  assert.ok(entry, 'read_file should be classified')
  assert.equal(entry.type, 'read')
  assert.equal(entry.target, 'src/a.ts')
  assert.equal(entry.tool, 'read_file')
})

test('classifyTool: read_file without a path is skipped', () => {
  assert.equal(classifyTool('read_file', {}, '/tmp'), null)
  assert.equal(classifyTool('read_file', null, '/tmp'), null)
})

test('classifyTool: iterate tools are typed by name', () => {
  const fix = classifyTool('iterate_fix', { file: 'src/b.ts' }, '/tmp')
  assert.equal(fix?.type, 'fix')
  assert.equal(fix?.target, 'src/b.ts')

  const review = classifyTool('iterate_review', { operation: 'aggregate' }, '/tmp')
  assert.equal(review?.type, 'review')
  assert.equal(review?.target, 'aggregate')

  const rollback = classifyTool('iterate_rollback', { id: 'fix-abc' }, '/tmp')
  assert.equal(rollback?.type, 'rollback')
  assert.equal(rollback?.target, 'fix fix-abc')
})

test('classifyTool: v3.0 command-center tools surface activity in the live feed', () => {
  const qg = classifyTool('iterate_quality_gate', { operation: 'compute' }, '/tmp')
  assert.equal(qg?.type, 'info')
  assert.equal(qg?.target, 'compute')

  const exp = classifyTool('iterate_experience', { operation: 'add', pattern: 'guard null' }, '/tmp')
  assert.equal(exp?.type, 'info')
  assert.equal(exp?.target, 'add')

  const def = classifyTool('iterate_defense_events', { operation: 'list' }, '/tmp')
  assert.equal(def?.type, 'info')
  assert.equal(def?.target, 'list')
})

test('classifyTool: unknown tools are ignored', () => {
  assert.equal(classifyTool('ls', { path: '/tmp' }, '/tmp'), null)
  assert.equal(classifyTool('web_search', {}, '/tmp'), null)
})

test('appendLive/readLive: round-trips entries newest-first', async () => {
  const root = freshRoot()
  try {
    assert.equal(existsSync(liveFilePath(root)), false)
    const a: LiveActivityEntry = { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'a.ts' }
    const b: LiveActivityEntry = { ts: '2026-01-01T00:00:00.001Z', type: 'fix', tool: 'iterate_fix', target: 'b.ts' }
    await appendLive(root, a)
    await appendLive(root, b)
    const live = await readLive(root)
    // Newest first.
    assert.equal(live.length, 2)
    assert.equal(live[0]?.target, 'b.ts')
    assert.equal(live[1]?.target, 'a.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readLive: caps to the last LIVE_MAX_ENTRIES entries', async () => {
  const root = freshRoot()
  try {
    const total = LIVE_MAX_ENTRIES + 25
    for (let i = 0; i < total; i += 1) {
      await appendLive(root, {
        ts: new Date(0).toISOString(),
        type: 'info',
        tool: 'iterate_status',
        target: 'i' + i,
      })
    }
    const live = await readLive(root)
    assert.ok(live.length <= LIVE_MAX_ENTRIES, `capped at ${LIVE_MAX_ENTRIES}, got ${live.length}`)
    // Newest first still holds.
    assert.equal(live[0]?.target, 'i' + (total - 1))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readLive: tolerates a malformed line without throwing', async () => {
  const root = freshRoot()
  try {
    const file = liveFilePath(root)
    await mkdir(join(root, '.iterate'), { recursive: true })
    await writeFile(
      file,
      'not-json\n' + JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'ok.ts' }) + '\n',
      'utf-8',
    )
    const live = await readLive(root)
    assert.equal(live.length, 1)
    assert.equal(live[0]?.target, 'ok.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerLiveCapture: wires the tools/result hook onto the live feed', async () => {
  let captured: unknown = null
  const ctx = {
    on: (_ev: string, fn: (exec: unknown) => void) => {
      captured = fn
      return () => { captured = null }
    },
  }
  registerLiveCapture(ctx as never)
  assert.equal(typeof captured, 'function', 'tools/result handler must be registered')
  const invoke = captured as (exec: { name: string; arguments?: unknown; agent?: unknown }) => void

  const root = freshRoot()
  try {
    invoke({
      name: 'iterate_review',
      arguments: { operation: 'aggregate' },
      agent: { session: { header: { cwd: root } } },
    })
    // Fire-and-forget append — poll until it lands.
    let live: LiveActivityEntry[] = []
    for (let i = 0; i < 100 && live.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
      live = await readLive(root)
    }
    assert.equal(live.length, 1)
    assert.equal(live[0]?.type, 'review')
    assert.equal(live[0]?.target, 'aggregate')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerLiveCapture: tools/result without a resolvable cwd is a no-op', async () => {
  let captured: unknown = null
  const ctx = {
    on: (_ev: string, fn: (exec: unknown) => void) => {
      captured = fn
      return () => { captured = null }
    },
  }
  registerLiveCapture(ctx as never)
  assert.equal(typeof captured, 'function')
  const invoke = captured as (exec: { name: string; arguments?: unknown; agent?: unknown }) => void
  // No session cwd → projectRootOf returns null → nothing appended, no throw.
  invoke({ name: 'iterate_fix', arguments: { file: 'src/a.ts' } })
  assert.ok(true)
})

test('appendLive: observatory.capture false keeps the feed absent', async () => {
  const root = freshRoot()
  try {
    await writeFile(join(root, 'iterate.config.yaml'), 'observatory:\n  capture: false\n', 'utf-8')
    await appendLive(root, { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'a.ts' })
    assert.equal(existsSync(liveFilePath(root)), false, 'capture off must not create the feed')
    // Same for an already-existing feed: bytes must be unchanged.
    await mkdir(join(root, '.iterate'), { recursive: true })
    await writeFile(liveFilePath(root), '{"ts":"x"}\n', 'utf-8')
    await appendLive(root, { ts: '2026-01-01T00:00:00.001Z', type: 'fix', tool: 'iterate_fix', target: 'b.ts' })
    assert.equal(readFileSync(liveFilePath(root), 'utf-8'), '{"ts":"x"}\n', 'capture off must not touch the feed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendLive: observatory.capture true still appends', async () => {
  const root = freshRoot()
  try {
    await writeFile(join(root, 'iterate.config.yaml'), 'observatory:\n  capture: true\n', 'utf-8')
    await appendLive(root, { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'a.ts' })
    const live = await readLive(root)
    assert.equal(live.length, 1)
    assert.equal(live[0]?.target, 'a.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendLive: an unreadable config keeps capture ON (defaults)', async () => {
  const root = freshRoot()
  try {
    // Unparseable YAML → loadConfig returns null → defaults → capture on.
    // Privacy must never silently swallow activity the operator expects.
    await writeFile(join(root, 'iterate.config.yaml'), 'observatory: [unterminated\n', 'utf-8')
    await appendLive(root, { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'a.ts' })
    const live = await readLive(root)
    assert.equal(live.length, 1, 'unreadable config must degrade to capture ON')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendLive: .iterate existing as a regular file resolves without throwing', async () => {
  const root = freshRoot()
  try {
    await writeFile(join(root, '.iterate'), 'not a directory', 'utf-8')
    // Previously the mkdir EEXIST/ENOTDIR path rejected the queue promise,
    // turning `void appendLive(...)` into an unhandled rejection.
    await appendLive(root, { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'a.ts' })
    assert.equal(readFileSync(join(root, '.iterate'), 'utf-8'), 'not a directory', 'the file must be left alone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerLiveCapture: a throwing exec getter never escapes the observer', () => {
  let captured: unknown = null
  const ctx = {
    on: (_ev: string, fn: (exec: unknown) => void) => {
      captured = fn
      return () => { captured = null }
    },
  }
  registerLiveCapture(ctx as never)
  const invoke = captured as (exec: unknown) => void

  // Every property access throws — the hook must degrade to a no-op instead
  // of surfacing an error from a read-only observer.
  const hostile = new Proxy({}, {
    get() { throw new Error('boom') },
  })
  assert.doesNotThrow(() => invoke(hostile), 'the observer must swallow hostile exec accessors')
})