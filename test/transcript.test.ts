import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ReviewTranscriptBuilder,
  TRANSCRIPT_VERSION,
} from '../src/transcript.ts'
import type { TranscriptEntry } from '../src/types.ts'

/** Monotonic clock so serialize() timestamps are deterministic and ordered. */
function fixedClock(): () => string {
  let t = 0
  return () => `2026-08-16T00:00:${String(t++).padStart(2, '0')}.000Z`
}

/** A valid finding-shaped record used across tests. */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: 'correctness',
    file: 'src/a.ts',
    line: 3,
    severity: 'high',
    summary: 'Guard the input',
    ...over,
  }
}

describe('ReviewTranscriptBuilder', () => {
  it('captures a full run lifecycle end to end', () => {
    const b = new ReviewTranscriptBuilder({
      project: '/proj',
      mode: 'normal',
      approval: 'deny',
      goal: 'g0',
      maxRounds: 3,
      now: fixedClock(),
    })

    b.begin('Improve quality', 5)
    b.phase('plan')
    b.roundStart(1, 5)

    // Thread 1 (correctness).
    b.reviewerStart('correctness')
    b.reviewerMessage('checking entry points')
    b.reviewerRead(['src/a.ts', 'src/a.ts', 'src/b.ts'])
    b.reviewerFindings([
      finding({ file: 'src/a.ts', line: 3, summary: 'guard' }),
      { dimension: 'correctness' }, // malformed → dropped
    ])

    // Thread 2 (security, attempt 2).
    b.reviewerStart('security', 2)
    b.reviewerMessage('scanning auth')
    b.reviewerFindings([finding({ dimension: 'security', file: 'src/b.ts', summary: 'weak hash' })])

    b.roundStart(2, 5)
    b.reviewerStart('architecture')
    b.reviewerMessage('round two review')
    b.phase('report')

    b.snapshotConvergence(1, 2)
    b.snapshotConvergence(2, 0)
    b.fix({ id: 'f1', file: 'src/a.ts', round: 1, summary: 'add guard', linesAdded: 1, linesRemoved: 0 })
    b.recordCheckpoint({ mode: 'normal', round: 1, maxRounds: 5, fixedCount: 1, resumeCount: 0, updatedAt: 'c' })
    b.decision({ type: 'round_start', round: 1, data: { round: 1 } })
    b.setNudge('focus on write paths')
    b.finish()

    const m = b.serialize()
    assert.equal(m.version, TRANSCRIPT_VERSION)
    assert.equal(m.project, '/proj')
    assert.equal(m.mode, 'normal')
    assert.equal(m.goal, 'Improve quality')
    assert.equal(m.maxRounds, 5)
    assert.equal(m.round, 2)
    assert.equal(m.active, false)
    assert.deepEqual(m.phases, ['plan', 'report'])

    assert.equal(m.rounds.length, 2)
    const r1 = m.rounds[1 - 1]!
    assert.equal(r1.threads.length, 2)
    const t0 = r1.threads[0]!
    assert.equal(t0.dimension, 'correctness')
    assert.equal(t0.attempt, 1)
    assert.deepEqual(t0.messages, ['checking entry points'])
    assert.deepEqual(t0.readFiles, ['src/a.ts', 'src/b.ts']) // deduped, order preserved
    assert.equal(t0.findings.length, 1)
    assert.equal(t0.findings[0]!.file, 'src/a.ts')
    assert.equal(t0.findings[0]!.severity, 'high')
    const t1 = r1.threads[1]!
    assert.equal(t1.dimension, 'security')
    assert.equal(t1.attempt, 2)
    assert.equal(t1.findings[0]!.summary, 'weak hash')
    assert.equal(m.rounds[2 - 1]!.threads[0]!.dimension, 'architecture')

    assert.deepEqual(m.convergence, [2, 0])
    assert.equal(m.fixes.length, 1)
    assert.equal(m.fixes[0]!.id, 'f1')
    assert.equal(m.checkpoint?.round, 1)
    assert.equal(m.timeline.length, 1)
    assert.equal(m.timeline[0]!.type, 'round_start')
    assert.equal(m.nudge?.text, 'focus on write paths')
    assert.equal(m.approval.policy, 'deny')
    assert.equal(m.approval.active, true)
  })

  it('keeps thread messages bounded (newest wins)', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.begin()
    b.roundStart(1)
    b.reviewerStart('correctness')
    for (let i = 0; i < 100; i += 1) b.reviewerMessage(`msg-${i}`)
    const m = b.serialize()
    const thread = m.rounds[0]!.threads[0]!
    assert.ok(thread.messages.length <= 40, `expected ≤ 40, got ${thread.messages.length}`)
    // The newest message is retained.
    assert.equal(thread.messages[thread.messages.length - 1], 'msg-99')
  })

  it('uses -1 placeholders when convergence rounds are filled out of order', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.snapshotConvergence(3, 7)
    assert.deepEqual(b.serialize().convergence, [-1, -1, 7])
    b.snapshotConvergence(1, 0)
    assert.deepEqual(b.serialize().convergence, [0, -1, 7])
  })

  it('fix() drops bad records and markFixRolledBack flips success', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.fix(null as unknown as Partial<never>)
    b.fix({ summary: 'no id or file' })
    b.fix({ id: 'a', summary: 'no file' })
    b.fix({ file: 'x.ts', summary: 'no id' })
    b.fix({ id: 'f1', file: 'src/a.ts', success: true })
    assert.equal(b.serialize().fixes.length, 1)
    assert.equal(b.serialize().fixes[0]!.success, true)
    b.markFixRolledBack('f1')
    assert.equal(b.serialize().fixes[0]!.success, false)
    // Idempotent / no-op on missing id.
    assert.doesNotThrow(() => b.markFixRolledBack('missing'))
  })

  it('recordCheckpoint(null) clears the checkpoint', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.recordCheckpoint({ mode: 'normal', round: 2, maxRounds: 5, fixedCount: 1, resumeCount: 0, updatedAt: 'c' })
    assert.ok(b.serialize().checkpoint)
    b.recordCheckpoint(null)
    assert.equal(b.serialize().checkpoint, null)
  })

  it('setNudge(null) and setNudge("") clear the nudge; text is trimmed', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.setNudge('hello')
    assert.equal(b.serialize().nudge?.text, 'hello')
    b.setNudge('')
    assert.equal(b.serialize().nudge, null)
    b.setNudge('world')
    b.setNudge(null)
    assert.equal(b.serialize().nudge, null)
    b.setNudge('   padded   ')
    assert.equal(b.serialize().nudge?.text, 'padded')
  })

  it('tolerates malformed inputs without throwing', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.begin()
    b.roundStart(1)
    b.reviewerStart('correctness')
    assert.doesNotThrow(() =>
      b.reviewerFindings('nope' as unknown as ReadonlyArray<unknown>),
    )
    assert.doesNotThrow(() => b.reviewerRead('nope' as unknown as ReadonlyArray<unknown>))
    assert.doesNotThrow(() =>
      b.decision('nope' as unknown as Partial<TranscriptEntry>),
    )
    assert.doesNotThrow(() => b.decision(null as unknown as Partial<TranscriptEntry>))
    assert.doesNotThrow(() => b.snapshotConvergence(2, 'nope' as unknown as number))
    // A valid snapshot after the noise still serializes cleanly.
    assert.doesNotThrow(() => b.serialize())
    assert.equal(b.serialize().convergence.length >= 1, true)
  })
})