import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

/** Write a `.iterate/decision-log.jsonl` from raw entry objects (no lock file). */
function writeDecisionLog(root: string, entries: Record<string, unknown>[]): void {
  mkdirSync(join(root, '.iterate'), { recursive: true })
  const body = entries.map((e) => JSON.stringify(e) + '\n').join('')
  writeFileSync(join(root, '.iterate', 'decision-log.jsonl'), body, 'utf-8')
}

/** Write the project config file (used by the observatory.capture tests). */
function writeConfig(root: string, yaml: string): void {
  writeFileSync(join(root, 'iterate.config.yaml'), yaml, 'utf-8')
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

describe('iterate_transcript nudge text argument', () => {
  it('accepts the advertised text:null clear (the schema used to reject it)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      // Set a nudge first…
      const set = (await tool({ operation: 'nudge', path: root, text: 'steer left' })) as Record<string, unknown>
      assert.equal((set.transcript as { nudge: { text: string } | null }).nudge?.text, 'steer left')
      // …then clear with the exact payload the docs and the client advertise.
      // Before the fix, dsh's pre-execute argument validation rejected
      // `text: null` against `type: 'string'`, so this call never reached
      // the handler at all.
      const cleared = (await tool({
        operation: 'nudge',
        path: root,
        text: null,
      })) as Record<string, unknown>
      assert.equal(cleared.updated, true)
      assert.equal(cleared.error, undefined)
      assert.equal((cleared.transcript as { nudge: unknown }).nudge, null)
      // The clear must PERSIST, not just appear in the returned snapshot.
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { nudge: unknown }
      assert.equal(onDisk.nudge, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats an empty or whitespace-only string as a clear (handler + docs aligned)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      await tool({ operation: 'nudge', path: root, text: 'steer right' })
      const blank = (await tool({ operation: 'nudge', path: root, text: '   ' })) as Record<string, unknown>
      assert.equal(blank.updated, true)
      assert.equal((blank.transcript as { nudge: unknown }).nudge, null)
      // The persisted nudge is gone too.
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { nudge: unknown }
      assert.equal(onDisk.nudge, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still sets a normal steering string', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      const res = (await tool({ operation: 'nudge', path: root, text: 'focus on auth' })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal((res.transcript as { nudge: { text: string } | null }).nudge?.text, 'focus on auth')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a non-string text at the schema boundary (before execute)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-nudge-'))
    try {
      await assert.rejects(
        tool({ operation: 'nudge', path: root, text: 42 }),
        /invalid arguments/,
      )
      // Nothing was persisted by the rejected call.
      assert.equal(existsSync(join(root, '.iterate', 'transcript.json')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('iterate_transcript read execute', () => {
  /** Assert the structured not-found empty view every failure path promises. */
  function assertEmptyView(res: Record<string, unknown>): void {
    assert.equal(res.found, false)
    assert.ok(Array.isArray(res.live), 'live activity must still be returned')
    const t = res.transcript as {
      version: number
      rounds: unknown[]
      convergence: unknown[]
      timeline: unknown[]
      nudge: unknown
    }
    assert.equal(t.version, TRANSCRIPT_VERSION)
    assert.deepEqual(t.rounds, [])
    assert.deepEqual(t.convergence, [])
    assert.deepEqual(t.timeline, [])
    assert.equal(t.nudge, null)
  }

  it('returns the persisted manifest when the file is well-formed', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-read-'))
    try {
      const b = new ReviewTranscriptBuilder({ project: root, mode: 'dry-run', goal: 'audit', now: fixedClock() })
      b.roundStart(1, 3)
      b.reviewerSnapshot('correctness', [finding()], ['src/a.ts'])
      b.snapshotConvergence(1, 1)
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify(b.serialize()), 'utf-8')

      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.error, undefined)
      const t = res.transcript as { goal: string; rounds: unknown[]; convergence: number[] }
      assert.equal(t.goal, 'audit')
      assert.equal(t.rounds.length, 1)
      assert.deepEqual(t.convergence, [1])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns the structured empty view when no transcript exists', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-read-'))
    try {
      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assertEmptyView(res)
      assert.equal(res.error, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns the structured empty view for corrupt JSON instead of a bare error', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-read-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(join(root, '.iterate', 'transcript.json'), '{not json', 'utf-8')
      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assertEmptyView(res)
      // The diagnostic survives alongside the view.
      assert.match(String(res.error), /Failed to read transcript/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats parseable-but-wrong-shape payloads as not found', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-read-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      // Each of these parses cleanly but carries no manifest — the old code
      // returned them as `found: true` and the panel rendered junk.
      const payloads: unknown[] = [
        null,
        [],
        {},
        { version: TRANSCRIPT_VERSION },
        { version: TRANSCRIPT_VERSION, project: root, active: true, rounds: [null], convergence: [], findings: [], fixes: [], timeline: [] },
        { version: TRANSCRIPT_VERSION, project: root, active: true, rounds: [], convergence: ['x'], findings: [], fixes: [], timeline: [] },
      ]
      for (const payload of payloads) {
        writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify(payload), 'utf-8')
        const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
        assert.equal(res.found, false, `payload ${JSON.stringify(payload)} must not be found`)
        assertEmptyView(res)
        assert.match(String(res.error), /not a valid manifest/)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('iterate_transcript capture hardening', () => {
  it('skips persistence entirely when observatory.capture is false', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-cfg-'))
    try {
      writeConfig(root, 'observatory:\n  capture: false\n')
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        rounds: [{ round: 1, findings: [finding()] }],
        findingsByRound: [1],
      })) as Record<string, unknown>
      assert.equal(res.skipped, true)
      assert.equal(res.reason, 'observatory.capture is disabled')
      assert.equal(res.updated, false)
      assert.equal(res.error, undefined)
      assert.equal(existsSync(join(root, '.iterate', 'transcript.json')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists when observatory.capture is explicitly true', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-cfg-'))
    try {
      writeConfig(root, 'observatory:\n  capture: true\n')
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 0, rounds: [] })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal(res.skipped, undefined)
      assert.equal(existsSync(join(root, '.iterate', 'transcript.json')), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists when the config file is unreadable (fail-safe defaults)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-cfg-'))
    try {
      // Broken YAML → loadConfig returns null → defaults (capture on) apply,
      // so a corrupt config can never silently blind the observatory.
      writeConfig(root, 'observatory: [unterminated\n')
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 0, rounds: [] })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal(existsSync(join(root, '.iterate', 'transcript.json')), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops negative/non-finite findingsByRound entries instead of persisting them', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-capture-'))
    try {
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 3,
        findingsByRound: [-3, 'x', 2],
        rounds: [{ round: 1, findings: [] }, { round: 2, findings: [] }, { round: 3, findings: [] }],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const convergence = (res.transcript as { convergence: number[] }).convergence
      // A hostile `-3` must not survive the round trip (rehydrate already
      // refuses it — capture must not be the asymmetric back door).
      assert.equal(convergence.includes(-3), false)
      // Only -1 placeholders (unknown) or non-negative counts may appear.
      assert.ok(
        convergence.every((n) => n === -1 || n >= 0),
        `unexpected convergence values: ${JSON.stringify(convergence)}`,
      )
      // The valid entry still lands at its position (round 3 → index 2).
      assert.equal(convergence[2], 2)
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { convergence: number[] }
      assert.equal(onDisk.convergence.includes(-3), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('folds the decision log into manifest.timeline on capture', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-timeline-'))
    try {
      writeDecisionLog(root, [
        { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'round_start', data: { round: 1 } },
        { timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision', data: { note: 'keep going' } },
      ])
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 2,
        rounds: [{ round: 1, findings: [] }, { round: 2, findings: [] }],
        findingsByRound: [1, 0],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const timeline = (res.transcript as { timeline: Array<{ type: string; round: number; data: Record<string, unknown> }> }).timeline
      assert.equal(timeline.length, 2)
      assert.equal(timeline[0]!.type, 'round_start')
      assert.equal(timeline[0]!.round, 1)
      assert.equal(timeline[1]!.type, 'decision')
      assert.deepEqual(timeline[1]!.data, { note: 'keep going' })
      // The timeline is PERSISTED, not just returned in the snapshot.
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { timeline: unknown[] }
      assert.equal(onDisk.timeline.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures an empty timeline when no decision log exists', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-timeline-'))
    try {
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 0, rounds: [] })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.deepEqual((res.transcript as { timeline: unknown[] }).timeline, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tolerates a corrupt decision log without failing the capture', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-timeline-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      // One garbage line + one good line: the reader skips the bad line, the
      // capture itself must never throw.
      writeFileSync(
        join(root, '.iterate', 'decision-log.jsonl'),
        '{not json\n' + JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'validation', data: { ok: true } }) + '\n',
        'utf-8',
      )
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 1, rounds: [{ round: 1, findings: [] }] })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal(res.error, undefined)
      const timeline = (res.transcript as { timeline: Array<{ type: string }> }).timeline
      assert.equal(timeline.length, 1)
      assert.equal(timeline[0]!.type, 'validation')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the captured timeline bounded by the builder cap (newest win)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-timeline-'))
    try {
      // 505 entries > MAX_TIMELINE (500): the head must be dropped, the tail kept.
      const entries = Array.from({ length: 505 }, (_, i) => ({
        timestamp: '2026-01-01T00:00:00.000Z',
        round: 1,
        type: 'decision',
        data: { idx: i },
      }))
      writeDecisionLog(root, entries)
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 1, rounds: [{ round: 1, findings: [] }] })) as Record<string, unknown>
      const timeline = (res.transcript as { timeline: Array<{ data: { idx: number } }> }).timeline
      assert.equal(timeline.length, 500)
      assert.equal(timeline[0]!.data.idx, 5) // oldest five evicted
      assert.equal(timeline[timeline.length - 1]!.data.idx, 504) // newest retained
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('validations capture contract (#6)', () => {
  /** A well-formed row of the agreed client/server shape. */
  function validRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { round: 1, command: 'npm test', exitCode: 0, allowed: true, ...over }
  }

  it('validation() keeps well-formed rows of the agreed shape', () => {
    const b = new ReviewTranscriptBuilder({
      project: '/proj',
      mode: 'normal',
      approval: 'ask',
      goal: 'g',
      maxRounds: 3,
      now: fixedClock(),
    })
    b.validation(validRow())
    b.validation(validRow({ round: 2, exitCode: 1, allowed: false, rejectReason: '  not in allow-list  ' }))
    b.validation(validRow({ round: 3, exitCode: null }))
    const m = b.serialize()
    assert.equal(m.validations?.length, 3)
    assert.deepEqual(m.validations![0], { round: 1, command: 'npm test', exitCode: 0, allowed: true })
    // rejectReason is trimmed and only attached when present.
    assert.deepEqual(m.validations![1], {
      round: 2,
      command: 'npm test',
      exitCode: 1,
      allowed: false,
      rejectReason: 'not in allow-list',
    })
    // exitCode null survives (the contract's "never produced a code" case).
    assert.equal(m.validations![2]!.exitCode, null)
  })

  it('validation() drops rows that cannot identify what was run', () => {
    const b = new ReviewTranscriptBuilder({
      project: '/proj',
      mode: 'normal',
      approval: 'ask',
      goal: 'g',
      maxRounds: 3,
      now: fixedClock(),
    })
    // Non-object / missing round / round 0 / negative round / blank command.
    b.validation('npm test')
    b.validation(null)
    b.validation({ command: 'npm test', exitCode: 0, allowed: true })
    b.validation(validRow({ round: 0 }))
    b.validation(validRow({ round: -2 }))
    b.validation(validRow({ round: NaN }))
    b.validation(validRow({ command: '   ' }))
    b.validation(validRow({ command: 42 }))
    const m = b.serialize()
    assert.equal(m.validations?.length, 0)
  })

  it('validation() clamps absurd rounds and normalizes the loose fields', () => {
    const b = new ReviewTranscriptBuilder({
      project: '/proj',
      mode: 'normal',
      approval: 'ask',
      goal: 'g',
      maxRounds: 3,
      now: fixedClock(),
    })
    // Round far above the cap is clamped (the row is real — never dropped).
    b.validation(validRow({ round: 10_000_000 }))
    // exitCode that is not a finite number degrades to null.
    b.validation(validRow({ round: 2, exitCode: 'abort' }))
    b.validation(validRow({ round: 3, exitCode: NaN }))
    // `allowed` is strict boolean: anything that is not `true` reads false
    // (fail closed — a row that cannot prove allow-listing is rejected).
    b.validation(validRow({ round: 4, allowed: 'yes' }))
    b.validation(validRow({ round: 5, allowed: undefined }))
    // Blank rejectReason is omitted, not persisted as ''.
    b.validation(validRow({ round: 6, allowed: false, rejectReason: '   ' }))
    const m = b.serialize()
    const rows = m.validations!
    assert.equal(rows.length, 6)
    assert.equal(rows[0]!.round, 1000) // MAX_ROUNDS clamp
    assert.equal(rows[1]!.exitCode, null)
    assert.equal(rows[2]!.exitCode, null)
    assert.equal(rows[3]!.allowed, false)
    assert.equal(rows[4]!.allowed, false)
    assert.equal('rejectReason' in rows[5]!, false)
  })

  it('validation() bounds the list at 500 rows (newest win)', () => {
    const b = new ReviewTranscriptBuilder({
      project: '/proj',
      mode: 'normal',
      approval: 'ask',
      goal: 'g',
      maxRounds: 3,
      now: fixedClock(),
    })
    for (let i = 0; i < 505; i++) b.validation(validRow({ round: 1, command: `cmd-${i}` }))
    const rows = b.serialize().validations!
    assert.equal(rows.length, 500)
    assert.equal(rows[0]!.command, 'cmd-5') // oldest five evicted
    assert.equal(rows[rows.length - 1]!.command, 'cmd-504') // newest retained
  })

  it('capture persists validations and drops malformed rows on the way', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-validations-'))
    try {
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 2,
        rounds: [{ round: 1, findings: [] }, { round: 2, findings: [] }],
        validations: [
          validRow({ round: 1, command: 'npm test', exitCode: 0, allowed: true }),
          validRow({ round: 2, command: 'npm run lint', exitCode: 2, allowed: false, rejectReason: 'not allow-listed' }),
          { garbage: true }, // dropped: no round/command
          'nope', // dropped: not an object
        ],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal(res.error, undefined)
      const captured = (res.transcript as { validations?: Array<Record<string, unknown>> }).validations
      assert.equal(captured?.length, 2)
      assert.equal(captured![0]!.command, 'npm test')
      assert.equal(captured![1]!.rejectReason, 'not allow-listed')
      // Persisted, not just echoed in the response.
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { validations: unknown[] }
      assert.equal(onDisk.validations.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('capture tolerates a non-array validations argument', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-validations-'))
    try {
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        rounds: [{ round: 1, findings: [] }],
        validations: 'not-an-array',
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      assert.equal(res.error, undefined)
      const captured = (res.transcript as { validations?: unknown[] }).validations
      assert.deepEqual(Array.from(captured ?? []), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rehydrate round-trips validations back through the builder (nudge path)', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-validations-'))
    try {
      await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        rounds: [{ round: 1, findings: [] }],
        validations: [validRow({ round: 1, command: 'npm test', exitCode: 0, allowed: true })],
      })
      // `nudge` rehydrates the persisted manifest before re-persisting —
      // validations must survive that round trip instead of being silently
      // reset (capture itself rebuilds from scratch by design).
      const res = (await tool({
        operation: 'nudge',
        path: root,
        text: 'keep going',
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const rows = (res.transcript as { validations?: unknown[] }).validations
      assert.equal(rows?.length, 1)
      assert.deepEqual(Array.from(rows!), [
        { round: 1, command: 'npm test', exitCode: 0, allowed: true },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
// ─── Audit hardening: rehydration fidelity, thread overflow, feed bounds ─────

describe('rehydrate fidelity (M5)', () => {
  it('keeps every over-cap thread with its OWN dimension and message ARRAY through a nudge', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-rehydrate-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      // 14 threads in one round — above MAX_THREADS_PER_ROUND (12). The old
      // replay path went through `reviewerStart` (silently dropped past the
      // live cap and mis-merged the tail into the previous dimension's
      // thread) plus `reviewerMessage((messages ?? []).join('\n'))` (collapsed
      // the message array, degrading every nudge round trip).
      const threads = Array.from({ length: 14 }, (_, i) => ({
        dimension: `dim-${i}`,
        attempt: 1,
        messages: [`first ${i}`, `second ${i}`],
        readFiles: [`src/${i}.ts`],
        findings: [finding({ dimension: `dim-${i}`, file: `src/${i}.ts`, summary: `f${i}` })],
      }))
      writeFileSync(
        join(root, '.iterate', 'transcript.json'),
        JSON.stringify({
          version: 1,
          project: root,
          updatedAt: '2026-01-01T00:00:00.000Z',
          active: true,
          mode: 'normal',
          goal: 'g',
          phases: [],
          round: 1,
          maxRounds: 3,
          rounds: [{ round: 1, threads }],
          convergence: [1],
          findings: [],
          fixes: [],
          checkpoint: null,
          timeline: [],
          nudge: null,
          approval: { active: true, policy: 'ask' },
        }),
        'utf-8',
      )

      const res = (await tool({ operation: 'nudge', path: root, text: 'steer' })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const out = res.transcript as {
        rounds: Array<{ threads: Array<{ dimension: string; messages: string[]; findings: Array<{ file: string }> }> }>
      }
      const restored = out.rounds[0]!.threads
      // Restored 1:1 (bounded only by the hostile-manifest cap 2*12+1), never
      // by the live per-round cap of 12.
      assert.equal(restored.length, 14)
      assert.deepEqual(
        restored.map((t) => t.dimension),
        threads.map((t) => t.dimension),
        'each thread keeps its own dimension — no merge into the previous one',
      )
      for (let i = 0; i < threads.length; i += 1) {
        assert.deepEqual(restored[i]!.messages, [`first ${i}`, `second ${i}`], `thread ${i} message boundaries`)
        assert.equal(restored[i]!.findings[0]!.file, `src/${i}.ts`, `thread ${i} findings stay attributed`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('thread cap overflow (minor 5)', () => {
  it('routes over-cap reviewer threads into ONE shared "other" thread (never mis-attributed)', () => {
    const b = new ReviewTranscriptBuilder({ project: '/proj', now: fixedClock() })
    b.roundStart(1, 3)
    for (let i = 0; i < 13; i += 1) b.reviewerStart(`dim-${i}`)
    // The 13th distinct dimension exceeds MAX_THREADS_PER_ROUND (12).
    b.reviewerFindings([finding({ dimension: 'dim-12', file: 'src/x.ts', summary: 'overflow finding' })])

    let threads = b.serialize().rounds[0]!.threads
    assert.equal(threads.length, 13, '12 live threads + at most ONE overflow thread')
    assert.equal(threads[12]!.dimension, 'other')
    assert.equal(threads[12]!.findings.length, 1, 'over-cap findings land in the overflow thread')
    assert.equal(threads[11]!.findings.length, 0, 'never merged into the previous dimension thread')

    // Further over-cap starts reuse the SAME overflow thread (still 13).
    b.reviewerStart('dim-99')
    b.reviewerSnapshot('dim-99', [finding({ file: 'src/y.ts', summary: 'second overflow' })])
    threads = b.serialize().rounds[0]!.threads
    assert.equal(threads.length, 13)
    assert.equal(threads[12]!.findings.length, 2)
    assert.equal(threads[11]!.findings.length, 0)
  })
})

describe('convergence feed bounds (minor 6)', () => {
  it('capture truncates findingsByRound at MAX_ROUNDS instead of folding the tail into slot 1000', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-convergence-'))
    try {
      const series = Array.from({ length: 1002 }, (_, i) => i)
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        rounds: [],
        findingsByRound: series,
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const conv = (res.transcript as { convergence: number[] }).convergence
      assert.equal(conv.length, 1000)
      // Without feed-side truncation rounds 1001/1002 would OVERWRITE slot
      // 1000 (the clamp), so conv[999] would be 1001 instead of 999.
      assert.equal(conv[999], 999)
      const onDisk = JSON.parse(
        readFileSync(join(root, '.iterate', 'transcript.json'), 'utf-8'),
      ) as { convergence: number[] }
      assert.equal(onDisk.convergence.length, 1000)
      assert.equal(onDisk.convergence[999], 999)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rehydrate applies the same truncation on the nudge path', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-convergence-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(
        join(root, '.iterate', 'transcript.json'),
        JSON.stringify({
          version: 1,
          project: root,
          updatedAt: '2026-01-01T00:00:00.000Z',
          active: true,
          mode: 'normal',
          goal: 'g',
          phases: [],
          round: 1,
          maxRounds: 0,
          rounds: [],
          convergence: Array.from({ length: 1005 }, (_, i) => i),
          findings: [],
          fixes: [],
          checkpoint: null,
          timeline: [],
          nudge: null,
          approval: { active: true, policy: 'ask' },
        }),
        'utf-8',
      )
      const res = (await tool({ operation: 'nudge', path: root, text: 'steer' })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const conv = (res.transcript as { convergence: number[] }).convergence
      assert.equal(conv.length, 1000)
      assert.equal(conv[999], 999, 'extra rounds must be dropped, not folded into the last slot')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('read-side defensive normalization (minor 7)', () => {
  it('bounds and sanitizes a hostile manifest instead of passing it through raw', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-normalize-'))
    try {
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(
        join(root, '.iterate', 'transcript.json'),
        JSON.stringify({
          version: 1,
          project: root,
          updatedAt: '2026-01-01T00:00:00.000Z',
          active: true,
          mode: 'normal',
          goal: 'g',
          phases: ['plan', 5, '   ', 'report'],
          round: 1e9,
          maxRounds: -4,
          rounds: [
            {
              round: 1,
              threads: Array.from({ length: 30 }, (_, i) => ({
                dimension: `d${i}`,
                attempt: 1,
                messages: Array.from({ length: 60 }, (_, j) => `m${j}`),
                readFiles: ['a.ts', 'a.ts'],
                findings: [{ dimension: 'x', file: 'f.ts', line: 0.5, summary: 'frac' }, 'junk'],
              })),
            },
          ],
          convergence: Array.from({ length: 1500 }, () => 3),
          findings: Array.from({ length: 2500 }, (_, i) => ({
            dimension: 'correctness',
            file: 'f.ts',
            line: i,
            severity: 'high',
            summary: `s${i}`,
          })),
          fixes: Array.from({ length: 400 }, (_, i) => ({ id: `f${i}` })),
          checkpoint: { mode: 'weird', round: 'x' },
          timeline: Array.from({ length: 900 }, (_, i) => ({ round: i, type: 'decision' })),
          nudge: { text: '   ' },
          validations: Array.from({ length: 900 }, (_, i) => ({
            round: i + 1,
            command: 'npm test',
            exitCode: 0,
            allowed: true,
          })),
          approval: { active: 'yes', policy: 'root' },
        }),
        'utf-8',
      )

      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assert.equal(res.found, true, 'root shape is valid, so the row-level bounds decide the payload')
      const t = res.transcript as Record<string, any>

      assert.equal(t.rounds.length, 1)
      assert.equal(t.rounds[0].threads.length, 25, 'threads capped at MAX_THREADS_RESTORED (2*12+1)')
      assert.equal(t.rounds[0].threads[0].messages.length, 40, 'messages capped at MAX_MESSAGES_PER_THREAD')
      assert.deepEqual(t.rounds[0].threads[0].readFiles, ['a.ts'])
      assert.equal(t.rounds[0].threads[0].findings.length, 1)
      assert.equal(t.rounds[0].threads[0].findings[0].line, 0, 'a fractional line is not a real anchor')
      assert.equal(t.convergence.length, 1000)
      assert.equal(t.findings.length, 2000)
      assert.equal(t.fixes.length, 0, 'fix rows without id+file are dropped')
      assert.equal(t.checkpoint, null, 'a checkpoint with a non-numeric round is not a checkpoint')
      assert.equal(t.timeline.length, 500)
      assert.equal(t.timeline[0].type, 'decision')
      assert.deepEqual(t.timeline[0].data, {})
      assert.equal(t.nudge, null, 'a whitespace-only nudge is cleared')
      assert.equal(t.validations.length, 500)
      assert.deepEqual(t.phases, ['plan', 'report'], 'non-string/blank phases dropped')
      assert.ok(t.round <= 1000, 'round marker clamped to MAX_ROUNDS')
      assert.equal(t.maxRounds, 0, 'negative counters degrade to 0')
      assert.deepEqual(t.approval, { active: true, policy: 'ask' }, 'invalid policy falls back to ask')
      assert.equal(t.round, 1000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('capture round marker (minor 8)', () => {
  it('advances the marker past captured rounds WITHOUT fabricating phantom empty rounds', async () => {
    const tool = captureTranscriptTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-transcript-marker-'))
    try {
      // Resumed-style capture: 3 rounds executed, findings captured for round 1
      // only. The marker must still report 3, but rounds 2/3 must NOT appear as
      // empty rows nobody produced.
      const res = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 3,
        findingsByRound: [1],
        rounds: [{ round: 1, findings: [finding()] }],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const m = res.transcript as { round: number; rounds: unknown[]; active: boolean; stoppedReason: string | null }
      assert.equal(m.round, 3, 'the marker still reports how far the run got')
      assert.equal(m.rounds.length, 1, 'no phantom empty rows for the uncaptured rounds')
      assert.equal(m.active, false)
      assert.equal(m.stoppedReason, 'max_rounds_reached')

      // A stale/smaller roundsExecuted must never REWIND past captured rows.
      const rew = (await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        findingsByRound: [1, 1],
        rounds: [{ round: 1, findings: [] }, { round: 2, findings: [] }],
      })) as Record<string, unknown>
      const m2 = rew.transcript as { round: number; rounds: unknown[] }
      assert.equal(m2.round, 2)
      assert.equal(m2.rounds.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
