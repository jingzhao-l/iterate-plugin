import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  readCheckpoint,
  readTranscriptTaskMode,
  validateCheckpoint,
  computeStatus,
  registerCheckpointTool,
  registerStatusTool,
} from '../src/tools/checkpoint.ts'
import type { IterationCheckpoint } from '../src/types.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

type ToolDef = { execute: (a: unknown, e: unknown) => Promise<unknown> }
type Tool = (args: unknown) => Promise<unknown>

function captureTools(
  registrars: Array<(ctx: { tools: { register: (d: unknown) => void } }) => void>,
): Array<Tool> {
  const defs: ToolDef[] = []
  for (const reg of registrars) {
    reg({ tools: { register: (d: unknown) => { defs.push(d as ToolDef) } } })
  }
  const exec = { signal: new AbortController().signal }
  return defs.map((def) => (args: unknown) => def.execute(args, exec as never) as Promise<unknown>)
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-checkpoint-test-'))
  // Pre-create the runtime state dir so direct writes to checkpoint.json work.
  mkdirSync(join(dir, '.iterate'), { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const checkpoint = (over: Partial<IterationCheckpoint> = {}): IterationCheckpoint => ({
  mode: 'normal',
  round: 3,
  maxRounds: 5,
  fixedCount: 7,
  architecturalCount: 2,
  resumeCount: 0,
  findings: [],
  startedAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T01:00:00.000Z',
  ...over,
})

// ─── validateCheckpoint ──────────────────────────────────────────────────────

describe('validateCheckpoint', () => {
  it('accepts a valid save payload', () => {
    assert.equal(validateCheckpoint({ mode: 'normal', round: 2, maxRounds: 5, fixedCount: 3, architecturalCount: 1 }), null)
  })

  it('rejects bad mode / rounds / counts', () => {
    assert.match(validateCheckpoint({ mode: 'bogus', round: 1, maxRounds: 5, fixedCount: 0, architecturalCount: 0 }) ?? '', /mode/)
    assert.match(validateCheckpoint({ mode: 'normal', round: -1, maxRounds: 5, fixedCount: 0, architecturalCount: 0 }) ?? '', /round/)
    assert.match(validateCheckpoint({ mode: 'normal', round: 1.5, maxRounds: 5, fixedCount: 0, architecturalCount: 0 }) ?? '', /round/)
    assert.match(validateCheckpoint({ mode: 'normal', round: 1, maxRounds: 0, fixedCount: 0, architecturalCount: 0 }) ?? '', /maxRounds/)
    assert.match(validateCheckpoint({ mode: 'normal', round: 1, maxRounds: 5, fixedCount: -1, architecturalCount: 0 }) ?? '', /fixedCount/)
    assert.match(validateCheckpoint({ mode: 'normal', round: 1, maxRounds: 5, fixedCount: 0, architecturalCount: 2.5 }) ?? '', /architecturalCount/)
  })

  it('rejects a round past the configured cap (round > maxRounds)', () => {
    assert.match(
      validateCheckpoint({ mode: 'normal', round: 6, maxRounds: 5, fixedCount: 0, architecturalCount: 0 }) ?? '',
      /maxRounds/,
    )
    // At the cap (equal) is still valid.
    assert.equal(validateCheckpoint({ mode: 'normal', round: 5, maxRounds: 5, fixedCount: 0, architecturalCount: 0 }), null)
  })
})

// ─── readCheckpoint ──────────────────────────────────────────────────────────

describe('readCheckpoint', () => {
  it('returns null when the file is missing or corrupt', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.equal(readCheckpoint(dir), null)
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), '{ not json', 'utf-8')
      assert.equal(readCheckpoint(dir), null)
    } finally {
      cleanup()
    }
  })

  it('reads a previously saved checkpoint', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), JSON.stringify(checkpoint()), 'utf-8')
      const loaded = readCheckpoint(dir)
      assert.equal(loaded?.round, 3)
      assert.equal(loaded?.fixedCount, 7)
    } finally {
      cleanup()
    }
  })

  it('rejects a hand-edited checkpoint with a non-numeric round', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), JSON.stringify({ ...checkpoint(), round: 'bogus' }), 'utf-8')
      assert.equal(readCheckpoint(dir), null)
      // NaN round (e.g. from a corrupt write) must also be rejected — `NaN <= 0`
      // is false, so a bare `typeof` + `<= 0` gate would have let it through.
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), JSON.stringify({ ...checkpoint(), round: NaN }), 'utf-8')
      assert.equal(readCheckpoint(dir), null)
    } finally {
      cleanup()
    }
  })

  it('normalizes a hand-edited checkpoint so no non-numeric field leaks out', () => {
    const { dir, cleanup } = tempProject()
    try {
      // maxRounds / fixedCount as strings, missing findings array — readCheckpoint
      // must coerce them instead of letting strings flow into the status.
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), JSON.stringify({
        mode: 'normal',
        round: 2,
        maxRounds: '5',
        fixedCount: '3',
        architecturalCount: null,
        resumeCount: undefined,
        startedAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T01:00:00.000Z',
      }), 'utf-8')
      const loaded = readCheckpoint(dir)
      assert.ok(loaded)
      assert.equal(loaded.round, 2)
      assert.equal(loaded.maxRounds, 2) // string maxRounds falls back to round
      assert.equal(loaded.fixedCount, 0)
      assert.equal(loaded.architecturalCount, 0)
      assert.equal(loaded.resumeCount, 0)
      assert.deepEqual(loaded.findings, [])
    } finally {
      cleanup()
    }
  })
})

// ─── computeStatus (pure) ────────────────────────────────────────────────────

describe('computeStatus', () => {
  it('reflects the checkpoint when one exists', () => {
    const status = computeStatus({
      checkpoint: checkpoint({ findings: [{ dimension: 'x', file: 'a.ts', severity: 'low', summary: 's', failure_scenario: 'f', suggested_fix: 'g', is_atomic: false }] }),
      decisionEntries: [],
      fixRegistry: { rounds: [] },
    })
    assert.equal(status.mode, 'normal')
    assert.equal(status.currentRound, 3)
    assert.equal(status.totalRounds, 5)
    assert.equal(status.fixedCount, 7)
    assert.equal(status.architecturalCount, 2)
    assert.equal(status.findingsCount, 1)
    assert.equal(status.hasCheckpoint, true)
    assert.equal(status.interrupted, true)
    assert.equal(status.resumeCount, 0)
  })

  it('reports interrupted=false and resumeCount=0 when no checkpoint exists', () => {
    const status = computeStatus({ checkpoint: null, decisionEntries: [], fixRegistry: { rounds: [] } })
    assert.equal(status.interrupted, false)
    assert.equal(status.resumeCount, 0)
  })

  it('carries the checkpoint resumeCount through to the status', () => {
    const status = computeStatus({
      checkpoint: checkpoint({ resumeCount: 2 }),
      decisionEntries: [],
      fixRegistry: { rounds: [] },
    })
    assert.equal(status.interrupted, true)
    assert.equal(status.resumeCount, 2)
  })

  it('derives the round from decision entries when no checkpoint exists', () => {
    const status = computeStatus({
      checkpoint: null,
      decisionEntries: [
        { timestamp: 't1', type: 'review_result', round: 1 },
        { timestamp: 't2', type: 'review_result', round: 2 },
      ],
      fixRegistry: { rounds: [] },
    })
    assert.equal(status.currentRound, 2)
    assert.equal(status.hasCheckpoint, false)
    assert.equal(status.totalDecisionLogEntries, 2)
  })

  it('sums fixed/failed counts from the fix registry', () => {
    const status = computeStatus({
      checkpoint: null,
      decisionEntries: [],
      fixRegistry: {
        rounds: [
          { round: 1, fixedCount: 2, failedCount: 1 },
          { round: 2, fixedCount: 3, failedCount: 0 },
        ],
      },
    })
    assert.equal(status.fixedCount, 5)
  })

  it('coerces NaN registry counts instead of propagating NaN', () => {
    const status = computeStatus({
      checkpoint: null,
      decisionEntries: [],
      fixRegistry: {
        rounds: [
          { round: 1, fixedCount: 2, failedCount: 1 },
          // Hand-edited round missing its count fields.
          { round: 2, fixedCount: undefined, failedCount: undefined } as unknown as {
            round: number; fixedCount: number; failedCount: number
          },
        ],
      },
    })
    assert.equal(status.fixedCount, 2) // one valid + 0 from the malformed round
    assert.equal(Number.isFinite(status.fixedCount), true)
  })

  it('handles an empty state without throwing', () => {
    const status = computeStatus({ checkpoint: null, decisionEntries: [], fixRegistry: { rounds: [] } })
    assert.equal(status.currentRound, 0)
    assert.equal(status.totalRounds, 0)
    assert.equal(status.fixedCount, 0)
    assert.equal(status.lastUpdated, null)
  })

  it('carries the harness taskMode through to the status (null when absent)', () => {
    const withMode = computeStatus({
      checkpoint: checkpoint(),
      taskMode: 'iterate',
      decisionEntries: [],
      fixRegistry: { rounds: [] },
    })
    assert.equal(withMode.taskMode, 'iterate')
    const code = computeStatus({
      checkpoint: checkpoint(),
      taskMode: 'code',
      decisionEntries: [],
      fixRegistry: { rounds: [] },
    })
    assert.equal(code.taskMode, 'code')
    // Not provided at all -> null (never throws).
    const none = computeStatus({ checkpoint: null, decisionEntries: [], fixRegistry: { rounds: [] } })
    assert.equal(none.taskMode, null)
  })

  it('surfaces the quality command-center snapshots when supplied', () => {
    const status = computeStatus({
      checkpoint: null,
      decisionEntries: [],
      fixRegistry: { rounds: [] },
      qualityGate: {
        timestamp: 't', overallStatus: 'pass', overallScore: 90, dimensions: [],
        verificationPassRate: 100, totalChecks: 1, passedChecks: 1, failedChecks: 0,
        totalFindings: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      },
      experienceBank: { totalEntries: 3, totalHits: 7 },
      defenseEvents: {
        totalEvents: 2,
        counts: { precondition_failed: 1, rollback: 1, invariant_violated: 0, assumption_falsified: 0 },
      },
    })
    assert.equal(status.qualityGate?.overallStatus, 'pass')
    assert.equal(status.qualityGate?.overallScore, 90)
    assert.deepEqual(status.experienceBank, { totalEntries: 3, totalHits: 7 })
    assert.equal(status.defenseEvents?.totalEvents, 2)
    assert.equal(status.defenseEvents?.counts.rollback, 1)
  })

  it('omits the snapshots when not supplied (never fabricates)', () => {
    const status = computeStatus({ checkpoint: null, decisionEntries: [], fixRegistry: { rounds: [] } })
    assert.equal(status.qualityGate, undefined)
    assert.equal(status.experienceBank, undefined)
    assert.equal(status.defenseEvents, undefined)
  })
})

// ─── readTranscriptTaskMode ──────────────────────────────────────────────────

describe('readTranscriptTaskMode', () => {
  it('returns null when the transcript is missing or corrupt', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.equal(readTranscriptTaskMode(dir), null)
      writeFileSync(join(dir, '.iterate', 'transcript.json'), 'not json', 'utf-8')
      assert.equal(readTranscriptTaskMode(dir), null)
    } finally {
      cleanup()
    }
  })

  it('reads the taskMode from a persisted transcript', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate', 'transcript.json'), JSON.stringify({ version: 1, mode: 'normal', taskMode: 'iterate' }), 'utf-8')
      assert.equal(readTranscriptTaskMode(dir), 'iterate')
      writeFileSync(join(dir, '.iterate', 'transcript.json'), JSON.stringify({ version: 1, taskMode: 'code' }), 'utf-8')
      assert.equal(readTranscriptTaskMode(dir), 'code')
    } finally {
      cleanup()
    }
  })

  it('degrades unknown/missing taskMode values to null', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate', 'transcript.json'), JSON.stringify({ taskMode: 'review-session' }), 'utf-8')
      assert.equal(readTranscriptTaskMode(dir), null)
      writeFileSync(join(dir, '.iterate', 'transcript.json'), JSON.stringify({ mode: 'normal' }), 'utf-8')
      assert.equal(readTranscriptTaskMode(dir), null)
    } finally {
      cleanup()
    }
  })
})

// ─── End-to-end tool execution ───────────────────────────────────────────────

describe('iterate_checkpoint / iterate_status execute', () => {
  it('save → load → clear round-trip', async () => {
    const [checkpointTool, statusTool] = captureTools([registerCheckpointTool, registerStatusTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject()
    try {
      const saved = (await checkpointTool({
        operation: 'save',
        mode: 'normal',
        round: 2,
        maxRounds: 5,
        fixedCount: 4,
        architecturalCount: 1,
        findings: [{ dimension: 'security', file: 'src/a.ts', severity: 'high', summary: 's', failure_scenario: 'f', suggested_fix: 'g', is_atomic: false }],
        path: dir,
      })) as Record<string, unknown>
      assert.equal(saved.ok, true)
      assert.equal(existsSync(join(dir, '.iterate', 'checkpoint.json')), true)

      const loaded = (await checkpointTool({ operation: 'load', path: dir })) as Record<string, unknown>
      assert.equal(loaded.ok, true)
      const ck = loaded.checkpoint as IterationCheckpoint
      assert.equal(ck.round, 2)
      assert.equal(ck.fixedCount, 4)
      assert.equal(ck.findings.length, 1)

      const status = (await statusTool({ path: dir })) as Record<string, unknown>
      assert.equal(status.ok, true)
      assert.equal(status.currentRound, 2)
      assert.equal(status.fixedCount, 4)
      assert.equal(status.hasCheckpoint, true)

      const cleared = (await checkpointTool({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(cleared.ok, true)
      assert.equal(cleared.existed, true)
      assert.equal(existsSync(join(dir, '.iterate', 'checkpoint.json')), false)
    } finally {
      cleanup()
    }
  })

  it('rejects an invalid save payload without writing', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await checkpointTool({
        operation: 'save',
        mode: 'normal',
        round: -1,
        maxRounds: 5,
        fixedCount: 0,
        architecturalCount: 0,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /round/)
      assert.equal(existsSync(join(dir, '.iterate', 'checkpoint.json')), false)
    } finally {
      cleanup()
    }
  })

  it('rejects a save whose round exceeds maxRounds', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await checkpointTool({
        operation: 'save',
        mode: 'normal',
        round: 6,
        maxRounds: 5,
        fixedCount: 0,
        architecturalCount: 0,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /maxRounds/)
      assert.equal(existsSync(join(dir, '.iterate', 'checkpoint.json')), false)
    } finally {
      cleanup()
    }
  })

  it('caps the checkpoint findings payload on save', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const findings = Array.from({ length: 1500 }, (_, i) => ({
        dimension: 'security',
        file: `src/a${i}.ts`,
        severity: 'low' as const,
        summary: `s${i}`,
        failure_scenario: 'f',
        suggested_fix: 'g',
        is_atomic: false,
      }))
      const res = (await checkpointTool({
        operation: 'save',
        mode: 'normal',
        round: 1,
        maxRounds: 5,
        fixedCount: 0,
        architecturalCount: 0,
        findings,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      const ck = (res.checkpoint as IterationCheckpoint)
      assert.equal(ck.findings.length, 1000) // capped at MAX_CHECKPOINT_FINDINGS
    } finally {
      cleanup()
    }
  })

  it('clear reports existed=false when no checkpoint exists', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await checkpointTool({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.existed, false)
    } finally {
      cleanup()
    }
  })

  it('load returns a null checkpoint when none exists', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await checkpointTool({ operation: 'load', path: dir })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.checkpoint, null)
    } finally {
      cleanup()
    }
  })

  it('resume bumps resumeCount and persists it back', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const saved = (await checkpointTool({
        operation: 'save',
        mode: 'normal',
        round: 2,
        maxRounds: 5,
        fixedCount: 4,
        architecturalCount: 1,
        resumeCount: 0,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(saved.ok, true)

      const resumed = (await checkpointTool({ operation: 'resume', path: dir })) as Record<string, unknown>
      assert.equal(resumed.ok, true)
      const ck = resumed.checkpoint as IterationCheckpoint
      assert.equal(ck.resumeCount, 1)
      assert.equal(ck.round, 2)
      assert.equal(ck.fixedCount, 4)

      // A second resume keeps counting.
      const resumed2 = (await checkpointTool({ operation: 'resume', path: dir })) as Record<string, unknown>
      assert.equal((resumed2.checkpoint as IterationCheckpoint).resumeCount, 2)

      // The on-disk copy matches.
      const loaded = (await checkpointTool({ operation: 'load', path: dir })) as Record<string, unknown>
      assert.equal((loaded.checkpoint as IterationCheckpoint).resumeCount, 2)
    } finally {
      cleanup()
    }
  })

  it('resume errors when no checkpoint exists', async () => {
    const [checkpointTool] = captureTools([registerCheckpointTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await checkpointTool({ operation: 'resume', path: dir })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /no checkpoint to resume/)
    } finally {
      cleanup()
    }
  })

  it('status surfaces the persisted quality command-center snapshots', async () => {
    const [checkpointTool, statusTool] = captureTools([registerCheckpointTool, registerStatusTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject()
    try {
      // Seed a quality gate + experience bank + defense events on disk.
      writeFileSync(join(dir, '.iterate', 'quality-gate.json'), JSON.stringify({
        timestamp: 't', overallStatus: 'pass', overallScore: 95, dimensions: [
          { dimension: 'security', convergenceRate: 100, findingsCount: 1, fixedCount: 1, score: 95, status: 'pass' },
        ],
        verificationPassRate: 100, totalChecks: 2, passedChecks: 2, failedChecks: 0,
        totalFindings: 1, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 1,
      }), 'utf-8')
      writeFileSync(join(dir, '.iterate', 'experience.json'), JSON.stringify({
        lastUpdated: 't', totalHits: 4,
        entries: [{ id: 'e1', timestamp: 't', dimension: 'security', pattern: 'p', description: 'd', verifiedFix: 'f', files: ['a.ts'], hitCount: 4, tags: [], findingSummary: 's', severity: 'high' }],
      }), 'utf-8')
      writeFileSync(join(dir, '.iterate', 'defense-events.json'), JSON.stringify({
        lastUpdated: 't',
        counts: { precondition_failed: 1, rollback: 0, invariant_violated: 0, assumption_falsified: 0 },
        events: [{ id: 'd1', timestamp: 't', round: 1, type: 'precondition_failed', description: 'x', defense: 'y', outcome: 'z', severity: 'medium' }],
      }), 'utf-8')

      const res = (await statusTool({ path: dir })) as Record<string, unknown>
      assert.equal(res.ok, true)
      const gate = res.qualityGate as Record<string, unknown>
      assert.equal(gate.overallStatus, 'pass')
      assert.equal((gate.dimensions as unknown[]).length, 1)
      const exp = res.experienceBank as Record<string, unknown>
      assert.equal(exp.totalEntries, 1)
      assert.equal(exp.totalHits, 4)
      const def = res.defenseEvents as Record<string, unknown>
      assert.equal(def.totalEvents, 1)
      assert.equal((def.counts as Record<string, number>).precondition_failed, 1)
    } finally {
      cleanup()
    }
  })
})
