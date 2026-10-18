/**
 * test/session-record.test.ts — dsh session-linked run records.
 *
 * Covers the pure payload builder/validator, the fail-safe API loader, and the
 * append/read round-trip against BOTH an injected fake API and the REAL
 * `@deepseek-ai/dsh-session` package (so the dynamic-import integration the
 * plugin relies on on a live host is actually exercised, not assumed).
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ITERATE_RUN_RECORD_TYPE,
  ITERATE_RUN_RECORD_VERSION,
  buildRunRecord,
  normalizeRunRecord,
  appendRunRecord,
  readRunRecords,
  sessionOf,
  setSessionRecordApiForTests,
  type SessionRecordApi,
} from '../src/session-record.ts'

/** A valid record payload used across tests. */
function sampleRecord() {
  return buildRunRecord({
    project: '/proj',
    goal: 'make it green',
    mode: 'normal',
    taskMode: 'iterate',
    round: 2,
    maxRounds: 5,
    active: false,
    stoppedReason: 'converged',
    convergence: [3, 0],
    counts: { total: 3, critical: 1, high: 1, medium: 1, low: 0 },
    fixedCount: 2,
    qualityStatus: 'pass',
    now: '2026-10-18T00:00:00.000Z',
  })
}

/** A fake session exposing arbitrary events through `ownEvents()`. */
function fakeSession(events: readonly unknown[]) {
  return { ownEvents: () => events }
}

/** Capture append calls; returns the injected API and the call log. */
function fakeApi(): { api: SessionRecordApi; calls: Array<{ type: string; data: unknown }>; nextSeq: () => number } {
  const calls: Array<{ type: string; data: unknown }> = []
  let seq = 0
  const api: SessionRecordApi = {
    appendPluginRecord(_session, type, data) {
      calls.push({ type, data })
      return seq++
    },
    pluginRecordOf(event) {
      const e = event as { pluginRecord?: { type: string; seq: number; time: number; data: unknown } } | null
      return e?.pluginRecord
    },
  }
  return { api, calls, nextSeq: () => seq }
}

describe('buildRunRecord / normalizeRunRecord', () => {
  it('normalizes a full input and stamps the current version', () => {
    const r = sampleRecord()
    assert.equal(r.version, ITERATE_RUN_RECORD_VERSION)
    assert.equal(r.project, '/proj')
    assert.equal(r.mode, 'normal')
    assert.equal(r.taskMode, 'iterate')
    assert.equal(r.round, 2)
    assert.equal(r.active, false)
    assert.equal(r.stoppedReason, 'converged')
    assert.deepEqual(r.convergence, [3, 0])
    assert.deepEqual(r.findings, { total: 3, critical: 1, high: 1, medium: 1, low: 0 })
    assert.equal(r.qualityStatus, 'pass')
    assert.equal(r.updatedAt, '2026-10-18T00:00:00.000Z')
  })

  it('coerces junk fields instead of throwing', () => {
    const r = buildRunRecord({
      project: 42 as unknown as string,
      mode: 'weird' as unknown as string,
      round: -3,
      maxRounds: Number.NaN,
      active: 'yes' as unknown as boolean,
      convergence: [1, 'x', -2, Number.POSITIVE_INFINITY, 4] as unknown as number[],
      counts: { total: 2.7, critical: -1 },
      fixedCount: null,
    })
    assert.equal(r.project, '')
    assert.equal(r.mode, null)
    assert.equal(r.round, 0)
    assert.equal(r.maxRounds, 0)
    assert.equal(r.active, true)
    assert.deepEqual(r.convergence, [1, 4])
    assert.deepEqual(r.findings, { total: 2, critical: 0, high: 0, medium: 0, low: 0 })
    assert.equal(r.fixedCount, 0)
  })

  it('rejects a payload with the wrong version (forward compatibility gate)', () => {
    assert.equal(normalizeRunRecord({ ...sampleRecord(), version: 999 }), null)
    assert.equal(normalizeRunRecord({ ...sampleRecord(), version: '1' }), null)
  })

  it('rejects non-object payloads', () => {
    assert.equal(normalizeRunRecord(null), null)
    assert.equal(normalizeRunRecord([]), null)
    assert.equal(normalizeRunRecord('nope'), null)
    assert.equal(normalizeRunRecord(7), null)
  })

  it('round-trips a valid record through normalize', () => {
    const r = sampleRecord()
    const back = normalizeRunRecord(JSON.parse(JSON.stringify(r)))
    assert.deepEqual(back, r)
  })

  it('caps an absurdly long convergence series', () => {
    const series = Array.from({ length: 5000 }, () => 1)
    const r = buildRunRecord({ project: '/p', convergence: series })
    assert.equal(r.convergence.length, 1000)
  })
})

describe('sessionOf', () => {
  it('extracts a session exposing ownEvents', () => {
    const s = fakeSession([])
    assert.equal(sessionOf({ agent: { session: s } }), s)
  })

  it('extracts a session exposing only snapshotEvents', () => {
    const s = { snapshotEvents: () => [] }
    assert.equal(sessionOf({ agent: { session: s } }), s)
  })

  it('returns undefined for a bare execution (no agent/session)', () => {
    assert.equal(sessionOf({ signal: {} }), undefined)
    assert.equal(sessionOf(undefined), undefined)
    assert.equal(sessionOf({ agent: {} }), undefined)
    assert.equal(sessionOf({ agent: { session: { notASession: true } } }), undefined)
  })

  it('never throws on a hostile execution object', () => {
    const hostile: unknown = { get agent(): unknown { throw new Error('boom') } }
    assert.equal(sessionOf(hostile), undefined)
  })
})

describe('appendRunRecord / readRunRecords (injected API)', () => {
  beforeEach(() => setSessionRecordApiForTests(undefined))

  it('appends a record through the API and reports the sequence', async () => {
    const { api, calls } = fakeApi()
    setSessionRecordApiForTests(api)
    const res = await appendRunRecord(fakeSession([]), sampleRecord())
    assert.equal(res.ok, true)
    assert.equal(res.supported, true)
    if (res.ok) assert.equal(res.seq, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.type, ITERATE_RUN_RECORD_TYPE)
  })

  it('reports unsupported when the API is absent', async () => {
    setSessionRecordApiForTests(null)
    const res = await appendRunRecord(fakeSession([]), sampleRecord())
    assert.equal(res.ok, false)
    assert.equal(res.supported, false)
  })

  it('reports a structured failure when the append throws', async () => {
    setSessionRecordApiForTests({
      appendPluginRecord() { throw new Error('private field access denied') },
      pluginRecordOf() { return undefined },
    })
    const res = await appendRunRecord(fakeSession([]), sampleRecord())
    assert.equal(res.ok, false)
    assert.equal(res.supported, true)
    if (!res.ok) assert.match(res.error, /private field access denied/)
  })

  it('reports "no session in scope" when exec carries no session', async () => {
    const { api } = fakeApi()
    setSessionRecordApiForTests(api)
    const res = await appendRunRecord(undefined, sampleRecord())
    assert.equal(res.ok, false)
    assert.equal(res.supported, true)
    if (!res.ok) assert.match(res.error, /no session/)
  })

  it('reports unsupported for reads when the API is absent', async () => {
    setSessionRecordApiForTests(null)
    const res = await readRunRecords(fakeSession([]))
    assert.equal(res.supported, false)
    assert.deepEqual(res.records, [])
  })

  it('reads only iterate records, skipping foreign + malformed ones', async () => {
    const good = sampleRecord()
    setSessionRecordApiForTests({
      appendPluginRecord() { return 0 },
      pluginRecordOf(event) {
        return (event as { rec?: { type: string; seq: number; time: number; data: unknown } }).rec
      },
    })
    const events = [
      { rec: { type: ITERATE_RUN_RECORD_TYPE, seq: 1, time: 11, data: good } },
      { rec: { type: 'plugin:other/thing', seq: 2, time: 12, data: { x: 1 } } },
      { rec: { type: ITERATE_RUN_RECORD_TYPE, seq: 3, time: 13, data: { bogus: true } } },
      { notARecord: true },
    ]
    const res = await readRunRecords(fakeSession(events))
    assert.equal(res.supported, true)
    assert.equal(res.records.length, 1)
    assert.equal(res.records[0]!.seq, 1)
    assert.equal(res.records[0]!.time, 11)
    assert.equal(res.records[0]!.project, '/proj')
  })

  it('returns oldest → newest and an empty list for a session with no records', async () => {
    const good = sampleRecord()
    setSessionRecordApiForTests({
      appendPluginRecord() { return 0 },
      pluginRecordOf(event) {
        return (event as { rec?: { type: string; seq: number; time: number; data: unknown } }).rec
      },
    })
    const older = { rec: { type: ITERATE_RUN_RECORD_TYPE, seq: 1, time: 1, data: { ...good, round: 1 } } }
    const newer = { rec: { type: ITERATE_RUN_RECORD_TYPE, seq: 2, time: 2, data: { ...good, round: 2 } } }
    const res = await readRunRecords(fakeSession([older, newer]))
    assert.deepEqual(res.records.map((r) => r.round), [1, 2])
  })
})

describe('appendRunRecord / readRunRecords (REAL @deepseek-ai/dsh-session)', () => {
  beforeEach(() => setSessionRecordApiForTests(undefined))
  afterEach(() => setSessionRecordApiForTests(undefined))

  it('round-trips a record through a real Session log', async () => {
    const session = Session.create(SessionId('ses_sessionrecord0000000'))
    const record = buildRunRecord({
      project: '/real',
      goal: 'g',
      mode: 'dry-run',
      round: 3,
      maxRounds: 4,
      active: false,
      stoppedReason: 'max_rounds_reached',
      convergence: [4, 2, 0],
      counts: { total: 1, critical: 0, high: 1, medium: 0, low: 0 },
      fixedCount: 1,
      now: '2026-10-18T02:00:00.000Z',
    })
    const appended = await appendRunRecord(session, record)
    assert.equal(appended.ok, true, appended.ok ? '' : appended.error)

    const read = await readRunRecords(session)
    assert.equal(read.supported, true)
    assert.equal(read.records.length, 1)
    const back = read.records[0]!
    assert.equal(back.project, '/real')
    assert.equal(back.mode, 'dry-run')
    assert.equal(back.round, 3)
    assert.equal(back.stoppedReason, 'max_rounds_reached')
    assert.deepEqual(back.convergence, [4, 2, 0])
    assert.equal(back.qualityStatus, null)
    assert.equal(typeof back.seq, 'number')
  })

  it('keeps the newest record last across repeated appends', async () => {
    const session = Session.create(SessionId('ses_sessionrecord1111111'))
    await appendRunRecord(session, buildRunRecord({ project: '/p', round: 1 }))
    await appendRunRecord(session, buildRunRecord({ project: '/p', round: 2 }))
    const read = await readRunRecords(session)
    assert.deepEqual(read.records.map((r) => r.round), [1, 2])
  })
})
