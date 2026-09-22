import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReviewTranscriptBuilder,
  TRANSCRIPT_VERSION,
} from '../src/transcript.ts'
import { markFixRolledBackInTranscript, registerTranscriptTool } from '../src/tools/transcript.ts'
import type { TranscriptEntry } from '../src/types.ts'

/** Capture the iterate_transcript tool's execute so tests can drive it. */
function captureTranscriptTool(): (args: unknown) => Promise<unknown> {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerTranscriptTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_transcript was not registered')
  const exec = { signal: new AbortController().signal }
  return (args: unknown) => def!.execute(args, exec as never) as Promise<unknown>
}

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

  it('caps per-thread findings at 100, keeping the NEWEST (drop the oldest)', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.begin()
    b.roundStart(1)
    b.reviewerStart('correctness')
    for (let i = 0; i < 120; i += 1) {
      b.reviewerFindings([finding({ summary: `finding-${i}` })])
    }
    const thread = b.serialize().rounds[0]!.threads[0]!
    assert.equal(thread.findings.length, 100)
    // Newest 100 survive: i = 20..119.
    assert.equal(thread.findings[0]!.summary, 'finding-20')
    assert.equal(thread.findings[thread.findings.length - 1]!.summary, 'finding-119')
  })

  it('global findings dedupe by key and evict the OLDEST past the 2000 cap (newest wins)', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.begin()
    b.roundStart(1)
    b.reviewerStart('correctness')
    for (let i = 0; i < 2005; i += 1) {
      b.reviewerFindings([finding({ file: `src/f-${i}.ts`, line: 3, summary: `sum-${i}` })])
    }
    const findings = b.serialize().findings
    assert.equal(findings.length, 2000)
    // The newest findings are retained; the oldest (f-0..f-4) were evicted.
    assert.equal(findings[0]!.file, 'src/f-5.ts')
    assert.equal(findings[findings.length - 1]!.file, 'src/f-2004.ts')
    // Duplicate inserts across threads collapse into one global entry.
    const b2 = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b2.begin()
    b2.roundStart(1)
    b2.reviewerStart('correctness')
    b2.reviewerFindings([finding({ summary: 'dup' })])
    b2.reviewerStart('security')
    b2.reviewerFindings([finding({ summary: 'dup' })]) // same key as above
    assert.equal(b2.serialize().findings.length, 1)
  })

  it('decision() snapshots a copy of the data so later caller mutation cannot alias', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    const payload = { action: 'prune', deleted: 1, nested: { a: 1 } }
    b.decision({ type: 'decision', round: 1, data: payload })
    payload.deleted = 999
    ;(payload.nested as { a: number }).a = 42
    const timelineData = b.serialize().timeline[0]!.data as Record<string, unknown>
    assert.equal(timelineData.deleted, 1)
    assert.deepEqual(timelineData.nested, { a: 1 })
  })

  it('uses -1 placeholders when convergence rounds are filled out of order', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.snapshotConvergence(3, 7)
    assert.deepEqual(b.serialize().convergence, [-1, -1, 7])
    b.snapshotConvergence(1, 0)
    assert.deepEqual(b.serialize().convergence, [0, -1, 7])
  })

  it('clamps an absurd model-controlled round number so preallocation cannot OOM', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    // A hostile/malformed round like 1e9 would previously drive
    // `while (this.rounds.length < round)` into a 1e9-slot allocation.
    b.roundStart(1_000_000_000)
    const m = b.serialize()
    assert.ok(m.rounds.length <= 1000, `expected rounds capped, got ${m.rounds.length}`)
    // The builder still records real rounds below the cap.
    const b2 = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b2.snapshotConvergence(1_000_000_000, 3)
    assert.ok(b2.serialize().convergence.length <= 1000, 'convergence preallocation must be capped')
    b2.snapshotConvergence(2, 1)
    assert.deepEqual(b2.serialize().convergence[1], 1)
  })

  it('ignores NaN round values instead of collapsing them into round 1', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.roundStart(NaN)
    assert.equal(b.serialize().round, 1) // coerced to the safe default, not exploded
    b.snapshotConvergence(NaN, 5)
    assert.deepEqual(b.serialize().convergence, [5])
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

  it('fix() bounds the fixes list so a long run cannot grow it unboundedly', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    // Drive past the internal cap; the newest records must win.
    for (let i = 0; i < 500; i += 1) {
      b.fix({ id: `f${i}`, file: 'src/a.ts', round: 1, summary: `fix ${i}` })
    }
    const fixes = b.serialize().fixes
    assert.equal(fixes.length, 200)
    // The OLDEST records were dropped, the newest retained.
    assert.equal(fixes[0]!.id, 'f300')
    assert.equal(fixes[fixes.length - 1]!.id, 'f499')
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

  it('serializes taskMode: explicit value wins, otherwise derives from mode', () => {
    const explicitIterate = new ReviewTranscriptBuilder({ project: '/p', mode: 'normal', taskMode: 'iterate', now: fixedClock() }).serialize()
    assert.equal(explicitIterate.taskMode, 'iterate')

    const explicitCode = new ReviewTranscriptBuilder({ project: '/p', mode: 'dry-run', taskMode: 'code', now: fixedClock() }).serialize()
    assert.equal(explicitCode.taskMode, 'code')

    // A review-loop run without an explicit taskMode defaults to "iterate".
    const derived = new ReviewTranscriptBuilder({ project: '/p', mode: 'normal', now: fixedClock() }).serialize()
    assert.equal(derived.taskMode, 'iterate')

    // No mode and no taskMode -> null (e.g. an empty/pre-capture read).
    const none = new ReviewTranscriptBuilder({ project: '/p', now: fixedClock() }).serialize()
    assert.equal(none.taskMode, null)

    // An invalid explicit value is ignored; the mode-derived default applies.
    const junk = new ReviewTranscriptBuilder({
      project: '/p',
      mode: 'normal',
      taskMode: 'review-session' as 'code',
      now: fixedClock(),
    }).serialize()
    assert.equal(junk.taskMode, 'iterate')
  })

  it('finish(reason) records stoppedReason and leaves the run finished', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', mode: 'normal', now: fixedClock() })
    b.roundStart(1, 3)
    b.snapshotConvergence(1, 2)
    b.finish('max_rounds_reached')
    const m = b.serialize()
    assert.equal(m.active, false)
    assert.equal(m.stoppedReason, 'max_rounds_reached')

    // A plain finish() carries no reason; stoppedReason stays null.
    const b2 = new ReviewTranscriptBuilder({ project: '/proj', mode: 'normal', now: fixedClock() })
    b2.finish()
    assert.equal(b2.serialize().active, false)
    assert.equal(b2.serialize().stoppedReason, null)
  })

  it('rehydrateBuilder preserves stoppedReason when re-persisted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-reason-'))
    try {
      const run = captureTranscriptTool()
      const b = new ReviewTranscriptBuilder({ project: root, mode: 'normal', now: fixedClock() })
      b.roundStart(1, 2)
      b.snapshotConvergence(1, 3)
      b.finish('aborted_by_validation')
      const dir = join(root, '.iterate')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'transcript.json'), JSON.stringify(b.serialize()), 'utf-8')

      // A nudge rehydrates the persisted manifest and must not drop the reason.
      const res = await run({
        operation: 'nudge',
        path: root,
        text: 'keep going',
      })
      const persisted = res && typeof res === 'object'
        ? (res as Record<string, unknown>).transcript as Record<string, unknown>
        : null
      assert.ok(persisted)
      assert.equal(persisted.active, false)
      assert.equal(persisted.stoppedReason, 'aborted_by_validation')
      assert.equal(
        (persisted.nudge as { text?: string } | null)?.text,
        'keep going',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('markFixRolledBackInTranscript', () => {
  function persistManifest(root: string, manifest: unknown): void {
    mkdirSync(join(root, '.iterate'), { recursive: true })
    writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify(manifest), 'utf-8')
  }

  it('flags a fix as rolled back in the persisted transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-mark-'))
    try {
      const b = new ReviewTranscriptBuilder({ project: root, now: fixedClock() })
      b.fix({ id: 'f1', file: 'src/a.ts', round: 1, summary: 'add guard' })
      b.fix({ id: 'f2', file: 'src/b.ts', round: 1, summary: 'other fix' })
      persistManifest(root, b.serialize())

      const updated = await markFixRolledBackInTranscript(root, 'f1')
      assert.equal(updated, true)

      const after = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      )
      const f1 = after.fixes.find((f: { id: string }) => f.id === 'f1')
      const f2 = after.fixes.find((f: { id: string }) => f.id === 'f2')
      assert.equal(f1.success, false)
      assert.equal(f2.success, true) // siblings keep their success flag
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns false (no-op) when no transcript exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-mark-'))
    try {
      const updated = await markFixRolledBackInTranscript(root, 'f1')
      assert.equal(updated, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is fail-safe against a corrupt transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-mark-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(join(root, '.iterate', 'transcript.json'), '{not json', 'utf-8')
      const updated = await markFixRolledBackInTranscript(root, 'f1')
      assert.equal(updated, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('iterate_transcript nudge execute', () => {
  it('nudge survives a malformed persisted manifest instead of crashing', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      // Valid JSON, wrong shape (rounds: [null]) — previously rehydrateBuilder
      // threw inside nudge and rejected the whole call.
      writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify({
        version: 1,
        rounds: [null],
        convergence: [1],
        fixes: [{ id: 'f1', round: null }],
      }), 'utf-8')
      const res = (await tool({ operation: 'nudge', path: root, text: 'focus on auth' })) as Record<string, unknown>
      assert.equal(res.operation, 'nudge')
      assert.equal(res.updated, true)
      assert.equal(res.error, undefined)
      const manifest = res.transcript as { nudge: { text: string } }
      assert.equal(manifest.nudge.text, 'focus on auth')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('nudge fallback keeps the ORIGINAL run identity (mode/taskMode/goal/maxRounds)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      // A dry-run/code run whose manifest is too malformed to rehydrate must NOT
      // degrade into a `normal` run — the fallback preserves the identity.
      writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify({
        version: 1,
        mode: 'dry-run',
        taskMode: 'code',
        goal: 'audit auth paths',
        maxRounds: 2,
        rounds: [null],
        convergence: [1],
        fixes: [],
      }), 'utf-8')
      const res = (await tool({ operation: 'nudge', path: root, text: 'focus on auth' })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const manifest = res.transcript as {
        mode: 'dry-run' | 'normal'
        taskMode: 'code' | 'iterate'
        goal: string
        maxRounds: number
      }
      assert.equal(manifest.mode, 'dry-run')
      assert.equal(manifest.taskMode, 'code')
      assert.equal(manifest.goal, 'audit auth paths')
      assert.equal(manifest.maxRounds, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a missing manifest nudge defaults to a fresh normal-mode run', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      const res = (await tool({ operation: 'nudge', path: root, text: 'go' })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const manifest = res.transcript as { mode: 'dry-run' | 'normal' }
      assert.equal(manifest.mode, 'normal')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('nudge surfaces a persistence failure as a structured error', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      // `.iterate` exists as a plain FILE — the atomic write below it must fail.
      writeFileSync(join(root, '.iterate'), '', 'utf-8')
      const res = (await tool({ operation: 'nudge', path: root, text: 'x' })) as Record<string, unknown>
      assert.equal(res.updated, false)
      assert.match(res.error as string, /persist transcript/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('capture records an explicit stoppedReason and closes the run', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-capture-'))
    try {
      const res = (await tool({
        operation: 'capture',
        path: root,
        mode: 'normal',
        goal: 'fix it',
        maxRounds: 3,
        roundsExecuted: 2,
        stoppedReason: 'aborted_by_validation',
        findingsByRound: [2, 1],
        rounds: [
          { round: 1, findings: [finding({ file: 'src/a.ts', summary: 'x' })] },
          { round: 2, findings: [] },
        ],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const manifest = res.transcript as { active: boolean; stoppedReason: string | null }
      assert.equal(manifest.active, false)
      assert.equal(manifest.stoppedReason, 'aborted_by_validation')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('capture derives converged / max_rounds_reached when no explicit reason is given', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-capture-'))
    try {
      // Trailing 0 → converged.
      const converged = (await tool({
        operation: 'capture',
        path: root,
        mode: 'dry-run',
        roundsExecuted: 2,
        findingsByRound: [2, 0],
        rounds: [
          { round: 1, findings: [finding({ file: 'src/a.ts', summary: 'x' })] },
          { round: 2, findings: [] },
        ],
      })) as { transcript: { active: boolean; stoppedReason: string | null } }
      assert.equal(converged.transcript.active, false)
      assert.equal(converged.transcript.stoppedReason, 'converged')

      // Work done but never trended to 0 → max_rounds_reached.
      const capped = (await tool({
        operation: 'capture',
        path: root,
        mode: 'normal',
        roundsExecuted: 3,
        findingsByRound: [2, 1, 3],
        rounds: [
          { round: 1, findings: [finding({ file: 'src/a.ts', summary: 'x' })] },
        ],
      })) as { transcript: { active: boolean; stoppedReason: string | null } }
      assert.equal(capped.transcript.active, false)
      assert.equal(capped.transcript.stoppedReason, 'max_rounds_reached')

      // No rounds recorded → still active, no reason.
      const fresh = (await tool({
        operation: 'capture',
        path: root,
        mode: 'dry-run',
        roundsExecuted: 0,
        findingsByRound: [],
        rounds: [],
      })) as { transcript: { active: boolean; stoppedReason: string | null } }
      assert.equal(fresh.transcript.active, true)
      assert.equal(fresh.transcript.stoppedReason, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})