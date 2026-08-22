/**
 * test/live.test.ts — unit tests for the live reviewer-activity feed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  classifyTool,
  appendLive,
  readLive,
  liveFilePath,
  LIVE_MAX_ENTRIES,
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