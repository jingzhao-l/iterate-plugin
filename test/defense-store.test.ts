import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDefenseEvent, computeCounts, readDefenseEvents, writeDefenseEvents, clearDefenseEvents } from '../src/tools/defense-store.ts'
import type { DefenseEvent, DefenseEventStream } from '../src/types.ts'

const emptyStream = (): DefenseEventStream => ({
  events: [],
  lastUpdated: '2026-01-01T00:00:00.000Z',
  counts: {
    precondition_failed: 0,
    rollback: 0,
    invariant_violated: 0,
    assumption_falsified: 0,
  },
})

const event = (over: Partial<DefenseEvent> = {}): DefenseEvent => ({
  id: 'def-1',
  timestamp: '2026-01-02T00:00:00.000Z',
  round: 1,
  type: 'rollback',
  description: 'the change was rejected by validation',
  defense: 'atomic rollback gate',
  outcome: 'file restored from backup',
  severity: 'high',
  ...over,
})

describe('addDefenseEvent', () => {
  it('appends the event and bumps its type count only', () => {
    const next = addDefenseEvent(emptyStream(), {
      round: 1,
      type: 'rollback',
      description: 'd',
      defense: 'def',
      outcome: 'kept the file untouched',
      severity: 'high',
    })
    assert.equal(next.events.length, 1)
    assert.equal(next.counts.rollback, 1)
    assert.equal(next.counts.precondition_failed, 0)
    assert.equal(next.counts.invariant_violated, 0)
    assert.equal(next.counts.assumption_falsified, 0)
    assert.ok(next.events[0]!.id.startsWith('def-'))
    assert.ok(next.events[0]!.timestamp)
  })

  it('accumulates across types without touching unrelated counts', () => {
    let stream = addDefenseEvent(emptyStream(), { round: 1, type: 'rollback', description: 'd', defense: 'def', outcome: 'o', severity: 'high' })
    stream = addDefenseEvent(stream, { round: 2, type: 'rollback', description: 'd', defense: 'def', outcome: 'o', severity: 'medium' })
    stream = addDefenseEvent(stream, { round: 3, type: 'invariant_violated', description: 'd', defense: 'def', outcome: 'o', severity: 'critical' })
    assert.equal(stream.events.length, 3)
    assert.equal(stream.counts.rollback, 2)
    assert.equal(stream.counts.invariant_violated, 1)
    assert.equal(stream.counts.precondition_failed, 0)
  })

  it('ignores unknown event types instead of crashing or polluting counts', () => {
    const next = addDefenseEvent(emptyStream(), {
      round: 1,
      type: 'bogus_event' as DefenseEvent['type'],
      description: 'd',
      defense: 'def',
      outcome: 'o',
      severity: 'low',
    })
    assert.equal(next.events.length, 1)
    assert.deepEqual(next.counts, emptyStream().counts)
  })

  it('never lets a caller-supplied id/timestamp override the stream identity', () => {
    const forged = addDefenseEvent(emptyStream(), {
      id: 'forged-id',
      timestamp: '2000-01-01T00:00:00.000Z',
      round: 1,
      type: 'rollback',
      description: 'd',
      defense: 'def',
      outcome: 'o',
      severity: 'high',
    } as never as DefenseEvent)
    const entry = forged.events[0]!
    assert.notEqual(entry.id, 'forged-id')
    assert.match(entry.id, /^def-/)
    assert.notEqual(entry.timestamp, '2000-01-01T00:00:00.000Z')
  })
})

describe('computeCounts', () => {
  it('rebuilds counts from the events array', () => {
    const events = [
      event({ id: '1', type: 'rollback' }),
      event({ id: '2', type: 'rollback' }),
      event({ id: '3', type: 'assumption_falsified' }),
    ]
    const counts = computeCounts(events)
    assert.equal(counts.rollback, 2)
    assert.equal(counts.assumption_falsified, 1)
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 3)
  })

  it('ignores unknown types found in disk data', () => {
    const events = [
      event({ id: '1', type: 'precondition_failed' }),
      { ...event({ id: '2' }), type: 'not_a_real_type' as never },
    ]
    const counts = computeCounts(events as unknown as DefenseEvent[])
    assert.equal(counts.precondition_failed, 1)
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 1)
  })
})

describe('writeDefenseEvents', () => {
  it('persists a stream and reports ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-store-'))
    try {
      const stream = addDefenseEvent(emptyStream(), {
        round: 1,
        type: 'rollback',
        description: 'd',
        defense: 'def',
        outcome: 'o',
        severity: 'high',
      })
      assert.deepEqual(writeDefenseEvents(dir, stream), { ok: true })
      assert.equal(existsSync(join(dir, '.iterate', 'defense-events.json')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a write failure instead of reporting false success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-store-'))
    try {
      // `.iterate` exists as a plain FILE — the write below it must fail.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = writeDefenseEvents(dir, emptyStream())
      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /defense-events\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readDefenseEvents', () => {
  it('returns an empty stream when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-read-'))
    try {
      const stream = readDefenseEvents(dir)
      assert.equal(stream.events.length, 0)
      assert.deepEqual(stream.counts, emptyStream().counts)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes a hand-edited file with a stale/missing counts object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'defense-events.json'), JSON.stringify({
        events: [
          event({ id: '1', type: 'rollback' }),
          event({ id: '2', type: 'rollback' }),
          event({ id: '3', type: 'assumption_falsified' }),
        ],
        // counts deliberately absent — must be recomputed, never NaN.
      }), 'utf-8')
      const stream = readDefenseEvents(dir)
      assert.equal(stream.counts.rollback, 2)
      assert.equal(stream.counts.assumption_falsified, 1)
      assert.equal(Object.values(stream.counts).every((n) => Number.isFinite(n)), true)

      // Adding an event after such a file must keep counts finite/accurate.
      const next = addDefenseEvent(stream, {
        round: 4, type: 'rollback', description: 'd', defense: 'def', outcome: 'o', severity: 'low',
      })
      assert.equal(next.counts.rollback, 3)
      assert.equal(Object.values(next.counts).every((n) => Number.isFinite(n)), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops malformed events instead of NaN-ing counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'defense-events.json'), JSON.stringify({
        events: [
          event({ id: '1', type: 'precondition_failed' }),
          { id: '2' }, // no type → dropped
          null,
        ],
      }), 'utf-8')
      const stream = readDefenseEvents(dir)
      assert.equal(stream.events.length, 1)
      assert.equal(stream.counts.precondition_failed, 1)
      assert.equal(Object.values(stream.counts).every((n) => Number.isFinite(n)), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives a DETERMINISTIC id for hand-edited events missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const write = (events: unknown[]) =>
        writeFileSync(join(dir, '.iterate', 'defense-events.json'), JSON.stringify({ events }), 'utf-8')
      const raw = [
        { type: 'rollback', round: 1, description: 'd1', defense: 'f1', outcome: 'o1', severity: 'high' },
        { type: 'rollback', round: 2, description: 'd2', defense: 'f2', outcome: 'o2', severity: 'medium' },
      ]
      write(raw)
      const first = readDefenseEvents(dir)
      assert.match(first.events[0]!.id, /^def-/)
      assert.notEqual(first.events[0]!.id, first.events[1]!.id)
      // Second read produces identical ids (no random churn per read).
      const second = readDefenseEvents(dir)
      assert.equal(second.events[0]!.id, first.events[0]!.id)
      assert.equal(second.events[1]!.id, first.events[1]!.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('clearDefenseEvents', () => {
  it('removes a persisted stream and reports existence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-clear-'))
    try {
      const seeded = writeDefenseEvents(dir, {
        events: [event({ id: '1', type: 'rollback' })],
        lastUpdated: 't',
        counts: { precondition_failed: 0, rollback: 1, invariant_violated: 0, assumption_falsified: 0 },
      })
      assert.deepEqual(seeded, { ok: true })
      const result = clearDefenseEvents(dir)
      assert.deepEqual(result, { ok: true, existed: true })
      assert.equal(existsSync(join(dir, '.iterate', 'defense-events.json')), false)
      // The stream is now empty again.
      const stream = readDefenseEvents(dir)
      assert.equal(stream.events.length, 0)
      assert.equal(stream.counts.rollback, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a clean no-op when no stream exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-clear-'))
    try {
      const result = clearDefenseEvents(dir)
      assert.deepEqual(result, { ok: true, existed: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})