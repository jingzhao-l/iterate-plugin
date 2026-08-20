import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  readCheckpoint,
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

  it('handles an empty state without throwing', () => {
    const status = computeStatus({ checkpoint: null, decisionEntries: [], fixRegistry: { rounds: [] } })
    assert.equal(status.currentRound, 0)
    assert.equal(status.totalRounds, 0)
    assert.equal(status.fixedCount, 0)
    assert.equal(status.lastUpdated, null)
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
      assert.equal(res.checkpoint, undefined)
    } finally {
      cleanup()
    }
  })
})
