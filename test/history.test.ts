import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  clampHistoryLimit,
  filterDecisionEntries,
  summarizeFixRegistry,
  registerHistoryTool,
} from '../src/tools/history.ts'
import { appendDecisionEntry } from '../src/tools/decision-log.ts'
import { readRegistry, emptyRegistry, upsertRecord } from '../src/tools/fix.ts'
import { fixRegistryPath } from '../src/paths.ts'
import type { DecisionLogEntry, FixRegistry, FixRecord, ReviewFinding } from '../src/types.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
  } | null = null
  registerHistoryTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_history was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
  }
}

function tempProject(files: Record<string, string> = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-history-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function entry(over: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    timestamp: '2026-08-17T00:00:00.000Z',
    round: 1,
    type: 'decision',
    data: { note: 'hello' },
    ...over,
  }
}

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  dimension: 'correctness',
  file: 'src/a.ts',
  line: 1,
  severity: 'high',
  summary: 'Guard input',
  failure_scenario: 'crash',
  suggested_fix: 'guard',
  is_atomic: true,
  ...over,
})

function record(over: Partial<FixRecord> = {}): FixRecord {
  return {
    id: 'fix-abc',
    timestamp: '2026-08-17T00:00:00.000Z',
    round: 1,
    finding: finding(),
    backupPath: 'unused',
    diffSummary: '+1/-1',
    linesAdded: 1,
    linesRemoved: 1,
    success: true,
    ...over,
  }
}

// ─── clampHistoryLimit ───────────────────────────────────────────────────────

describe('clampHistoryLimit', () => {
  it('defaults when limit is absent or invalid', () => {
    assert.equal(clampHistoryLimit(undefined), 50)
    assert.equal(clampHistoryLimit(0), 50)
    assert.equal(clampHistoryLimit(-5), 50)
    assert.equal(clampHistoryLimit(3.5), 50)
    assert.equal(clampHistoryLimit(NaN), 50)
    assert.equal(clampHistoryLimit('50' as unknown as number), 50)
  })

  it('caps at MAX_LIMIT', () => {
    assert.equal(clampHistoryLimit(200), 200)
    assert.equal(clampHistoryLimit(5000), 200)
  })

  it('keeps a valid in-range limit', () => {
    assert.equal(clampHistoryLimit(10), 10)
  })
})

// ─── filterDecisionEntries ───────────────────────────────────────────────────

describe('filterDecisionEntries', () => {
  const entries: DecisionLogEntry[] = [
    entry({ timestamp: '2026-08-01T00:00:00.000Z', round: 1, type: 'round_start', data: {} }),
    entry({ timestamp: '2026-08-02T00:00:00.000Z', round: 2, type: 'review_result', data: {} }),
    entry({ timestamp: '2026-08-03T00:00:00.000Z', round: 3, type: 'decision', data: {} }),
  ]

  it('returns newest matching entries with a count before the cap', () => {
    const r = filterDecisionEntries(entries, { limit: 2 })
    assert.equal(r.limit, 2)
    assert.equal(r.filteredCount, 3)
    assert.deepEqual(r.entries.map((e) => e.round), [2, 3])
  })

  it('filters by entry type', () => {
    const r = filterDecisionEntries(entries, { type: 'review_result' })
    assert.deepEqual(r.entries.map((e) => e.round), [2])
    assert.equal(r.filteredCount, 1)
  })

  it('filters by since timestamp (strictly after)', () => {
    const r = filterDecisionEntries(entries, { since: '2026-08-02T00:00:00.000Z' })
    assert.deepEqual(r.entries.map((e) => e.round), [3])
  })

  it('ignores invalid type / since inputs', () => {
    const r = filterDecisionEntries(entries, { type: 42, since: 7 })
    assert.equal(r.filteredCount, 3)
  })

  it('handles a non-array entries input as empty', () => {
    const r = filterDecisionEntries(undefined as unknown as DecisionLogEntry[], {})
    assert.equal(r.filteredCount, 0)
    assert.deepEqual(r.entries, [])
  })
})

// ─── summarizeFixRegistry ────────────────────────────────────────────────────

describe('summarizeFixRegistry', () => {
  it('aggregates totals and per-round counts', () => {
    const registry: FixRegistry = {
      rounds: [
        {
          round: 1,
          fixedCount: 2,
          failedCount: 1,
          records: [record(), record({ id: 'fix-b' }), record({ id: 'fix-c', success: false })],
        },
        { round: 2, fixedCount: 1, failedCount: 0, records: [record({ id: 'fix-d', round: 2 })] },
      ],
    }
    const s = summarizeFixRegistry(registry)
    assert.equal(s.totalFixed, 3)
    assert.equal(s.totalFailed, 1)
    assert.equal(s.roundCount, 2)
    assert.deepEqual(s.rounds, [
      { round: 1, fixedCount: 2, failedCount: 1 },
      { round: 2, fixedCount: 1, failedCount: 0 },
    ])
  })

  it('handles an empty registry', () => {
    const s = summarizeFixRegistry(emptyRegistry())
    assert.equal(s.totalFixed, 0)
    assert.equal(s.totalFailed, 0)
    assert.equal(s.roundCount, 0)
  })
})

// ─── iterate_history tool (end-to-end) ───────────────────────────────────────

describe('iterate_history tool', () => {
  it('reads decision log + fix registry summary', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ round: 1, type: 'round_start', data: { goal: 'x' } }))
    appendDecisionEntry(dir, entry({ round: 2, type: 'review_result', data: { n: 1 } }))
    mkdirSync(join(dir, '.iterate/fixes'), { recursive: true })
    const registry = upsertRecord(emptyRegistry(), record({ id: 'fix-abc', success: true }))
    writeFileSync(fixRegistryPath(dir), JSON.stringify(registry, null, 2), 'utf-8')

    const tool = captureTool()
    const out = (await tool.execute({ path: dir })) as Record<string, unknown>

    assert.equal(out.ok, true)
    assert.equal(out.count, 2)
    assert.equal(out.filteredCount, 2)
    assert.equal((out.fixes as { totalFixed: number }).totalFixed, 1)
    assert.ok(Array.isArray(out.log))

    // render is non-empty and mentions entries + fixes
    const text = tool.render({}, out).map((m) => m.text).join('\n')
    assert.match(text, /Decision-log entries: 2/)
    assert.match(text, /Fixes: 1 applied/)

    cleanup()
  })

  it('reports an error for an invalid path', async () => {
    const tool = captureTool()
    const out = (await tool.execute({ path: '/' })) as Record<string, unknown>
    assert.equal(out.ok, false)
    assert.equal(typeof out.error, 'string')
    assert.ok((out.error as string).length > 0)
  })

  it('supports type + since filtering through the tool', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ round: 1, type: 'round_start', data: {} }))
    appendDecisionEntry(dir, entry({ round: 2, type: 'atomic_fix', data: {} }))
    const tool = captureTool()
    const out = (await tool.execute({ path: dir, type: 'atomic_fix' })) as Record<string, unknown>
    assert.equal(out.count, 1)
    cleanup()
  })
})

// ─── registry file helpers used by history (sanity) ─────────────────────────

describe('history registry integration', () => {
  it('readRegistry tolerates a missing registry file', () => {
    const { dir, cleanup } = tempProject()
    const reg = readRegistry(dir)
    assert.deepEqual(reg.rounds, [])
    cleanup()
  })

  it('writes and re-reads a registry round-trip', () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(join(dir, '.iterate/fixes'), { recursive: true })
    const withRec = upsertRecord(emptyRegistry(), record({ id: 'fix-x' }))
    writeFileSync(fixRegistryPath(dir), JSON.stringify(withRec, null, 2), 'utf-8')
    const reread = readRegistry(dir)
    assert.equal(reread.rounds.length, 1)
    assert.equal(reread.rounds[0]!.records.length, 1)
    assert.equal(existsSync(fixRegistryPath(dir)), true)
    cleanup()
  })

  it('removes records with removeRecord and recomputes counts', async () => {
    const { removeRecord, recomputeRoundCounts } = await import('../src/tools/fix.ts')
    const reg = upsertRecord(emptyRegistry(), record({ id: 'fix-keep' }))
    const removed = removeRecord(reg, 'fix-keep')
    const recomputed = recomputeRoundCounts(removed)
    assert.equal(recomputed.rounds.length, 0)
    const kept = recomputeRoundCounts(reg)
    assert.equal(kept.rounds[0]!.fixedCount, 1)
  })
})

// ─── registry file helpers used by history (sanity) ─────────────────────────

describe('history registry file layout', () => {
  it('keeps decision-log.jsonl content round-trippable via appendDecisionEntry', () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ data: { a: 1 } }))
    appendDecisionEntry(dir, entry({ data: { b: 2 } }))
    const content = readFileSync(join(dir, '.iterate/decision-log.jsonl'), 'utf-8')
    const lines = content.trim().split('\n')
    assert.equal(lines.length, 2)
    cleanup()
  })
})
