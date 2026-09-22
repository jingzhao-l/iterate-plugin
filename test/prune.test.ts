import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  clampRetainDays,
  cutoffTimestamp,
  inspectPrune,
  executePrune,
  isPrunableTemp,
  registerPruneTool,
  sweepExperienceBank,
  sweepDefenseEvents,
  MAX_EXPERIENCE_ENTRIES,
} from '../src/tools/prune.ts'
import { appendDecisionEntry, readDecisionEntries } from '../src/tools/decision-log.ts'
import { emptyRegistry, upsertRecord } from '../src/tools/fix.ts'
import { readExperienceBank, writeExperienceBank } from '../src/tools/experience-store.ts'
import { readDefenseEvents, writeDefenseEvents } from '../src/tools/defense-store.ts'
import { fixRegistryPath, checkpointPath, fixesDir, iterateDir } from '../src/paths.ts'
import type { DecisionLogEntry, DefenseEvent, ExperienceBank, FixRecord, ReviewFinding } from '../src/types.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
  } | null = null
  registerPruneTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_prune was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
  }
}

function tempProject(files: Record<string, string> = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-prune-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function entry(over: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    round: 1,
    type: 'decision',
    data: {},
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
    timestamp: new Date().toISOString(),
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

/** Days ago as an ISO timestamp string. */
function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ─── clampRetainDays / cutoffTimestamp ───────────────────────────────────────

describe('clampRetainDays', () => {
  it('defaults when absent or invalid', () => {
    assert.equal(clampRetainDays(undefined), 30)
    assert.equal(clampRetainDays(0), 30)
    assert.equal(clampRetainDays(-4), 30)
    assert.equal(clampRetainDays(2.5), 30)
    assert.equal(clampRetainDays(NaN), 30)
  })

  it('clamps to the min/max range', () => {
    assert.equal(clampRetainDays(1), 1)
    assert.equal(clampRetainDays(0.5), 30) // non-integer → default
    assert.equal(clampRetainDays(365), 365)
    assert.equal(clampRetainDays(9999), 365)
  })

  it('keeps a valid in-range value', () => {
    assert.equal(clampRetainDays(14), 14)
  })
})

describe('cutoffTimestamp', () => {
  it('produces a valid ISO string earlier than now', () => {
    const cutoff = cutoffTimestamp(30)
    assert.ok(!Number.isNaN(Date.parse(cutoff)))
    assert.ok(cutoff < new Date().toISOString())
  })
})

// ─── inspectPrune ────────────────────────────────────────────────────────────

describe('inspectPrune', () => {
  it('reports old log entries based on retainDays', () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(1), type: 'decision', data: {} }))

    const report = inspectPrune(dir, 30)
    assert.equal(report.totalLogEntries, 2)
    assert.equal(report.oldLogEntries, 1)
    assert.equal(report.hasCheckpoint, false)
    assert.equal(report.staleBackups.length, 0)
    assert.deepEqual(report.emptyRounds, [])
    cleanup()
  })

  it('detects a checkpoint and empty rounds', () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(iterateDir(dir), { recursive: true })
    writeFileSync(checkpointPath(dir), '{}', 'utf-8')
    mkdirSync(fixesDir(dir), { recursive: true })
    const registry = emptyRegistry()
    const withRec = upsertRecord(registry, record({ id: 'fix-x' }))
    // A second empty round exists only after removeRecord; construct directly.
    writeFileSync(fixRegistryPath(dir), JSON.stringify(withRec, null, 2), 'utf-8')

    const report = inspectPrune(dir, 30)
    assert.equal(report.hasCheckpoint, true)
    assert.equal(report.staleBackups.length, 0)
    cleanup()
  })

  it('flags stale backups whose fix-id is not in the registry', () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(fixesDir(dir), { recursive: true })
    // Backup for a fix id NOT in the registry.
    writeFileSync(join(fixesDir(dir), 'fix-dead_2026-08-17T00-00-00-000Z.bak'), 'x', 'utf-8')
    const registry = upsertRecord(emptyRegistry(), record({ id: 'fix-live' }))
    // Backup for the LIVE fix id — not stale.
    writeFileSync(join(fixesDir(dir), 'fix-live_2026-08-17T00-00-00-000Z.bak'), 'y', 'utf-8')
    writeFileSync(fixRegistryPath(dir), JSON.stringify(registry, null, 2), 'utf-8')

    const report = inspectPrune(dir, 30)
    assert.equal(report.staleBackups.length, 1)
    assert.match(report.staleBackups[0]!, /fix-dead/)
    cleanup()
  })

  it('degrades gracefully when the fixes / .iterate paths are not listable directories', () => {
    const { dir, cleanup } = tempProject()
    try {
      // `fixes` exists as a plain FILE — `existsSync` is true but readdirSync
      // throws ENOTDIR; inspectPrune must report "nothing" instead of throwing.
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'fixes'), '', 'utf-8')
      // `.iterate` itself is a plain FILE for the temp-file sweep — the second
      // readdirSync path previously threw too.
      const { dir: dir2, cleanup: cleanup2 } = tempProject()
      try {
        writeFileSync(join(dir2, '.iterate'), '', 'utf-8')
        const report2 = inspectPrune(dir2, 30)
        assert.equal(report2.staleTemps.length, 0)
        assert.equal(report2.staleBackups.length, 0)
      } finally {
        cleanup2()
      }
      const report = inspectPrune(dir, 30)
      assert.equal(report.staleBackups.length, 0)
      assert.equal(report.staleTemps.length, 0)
      assert.deepEqual(report.emptyRounds, [])
    } finally {
      cleanup()
    }
  })
})

// ─── executePrune ────────────────────────────────────────────────────────────

describe('executePrune', () => {
  it('deletes old log entries, checkpoint, stale backups', () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(1), type: 'decision', data: {} }))
    mkdirSync(iterateDir(dir), { recursive: true })
    writeFileSync(checkpointPath(dir), '{}', 'utf-8')
    mkdirSync(fixesDir(dir), { recursive: true })
    writeFileSync(join(fixesDir(dir), 'fix-dead_2026-08-17T00-00-00-000Z.bak'), 'x', 'utf-8')
    const registry = upsertRecord(emptyRegistry(), record({ id: 'fix-live' }))
    writeFileSync(join(fixesDir(dir), 'fix-live_2026-08-17T00-00-00-000Z.bak'), 'y', 'utf-8')
    writeFileSync(fixRegistryPath(dir), JSON.stringify(registry, null, 2), 'utf-8')

    const report = inspectPrune(dir, 30)
    const result = executePrune(dir, 30, report)

    assert.equal(result.deletedLogEntries, 1)
    assert.equal(result.deletedCheckpoint, true)
    assert.deepEqual(result.deletedBackups, ['fix-dead_2026-08-17T00-00-00-000Z.bak'])
    assert.deepEqual(result.errors, [])

    // Live backup survives, dead one is gone (registry.json also lives here).
    const remaining = readdirSync(fixesDir(dir)).filter((f) => f.endsWith('.bak'))
    assert.equal(remaining.length, 1)
    assert.match(remaining[0]!, /fix-live/)
    assert.equal(existsSync(checkpointPath(dir)), false)
    cleanup()
  })

  it('collects errors instead of swallowing them', () => {
    const { dir, cleanup } = tempProject()
    // Make the fixes directory un-deletable by pointing a stale backup at a
    // path whose parent does not exist.
    const report = {
      oldLogEntries: 0,
      hasCheckpoint: false,
      staleBackups: ['nope/fix-dead_2026-08-17T00-00-00-000Z.bak'],
      staleTemps: [] as string[],
      emptyRounds: [] as number[],
      totalLogEntries: 0,
      registryRounds: 0,
      totalExperiences: 0,
      experienceOversize: 0,
      totalDefenseEvents: 0,
      staleDefenseEvents: 0,
    }
    const result = executePrune(dir, 30, report)
    assert.equal(result.deletedBackups.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!, /fix-dead/)
    cleanup()
  })
})

// ─── isPrunableTemp (temp-file naming conventions) ──────────────────────────

describe('isPrunableTemp', () => {
  it('recognizes every temp convention written by the plugin', () => {
    // Current atomic-fs convention: .<basename>.tmp-<pid>-<rand>
    assert.equal(isPrunableTemp('.experience.json.tmp-501-abc'), true)
    assert.equal(isPrunableTemp('.decision-log.jsonl.tmp-1-x'), true)
    assert.equal(isPrunableTemp('.registry.json.tmp-12345-zz9'), true)
    // Legacy dot-prefix convention: .tmp-<pid>-<rand>
    assert.equal(isPrunableTemp('.tmp-501-abc'), true)
    // Legacy bare-suffix convention (transcript.ts / live.ts): <name>.tmp
    assert.equal(isPrunableTemp('transcript.json.tmp'), true)
    assert.equal(isPrunableTemp('live.json.trim.tmp'), true)
  })

  it('rejects real state files and non-temp names', () => {
    assert.equal(isPrunableTemp('decision-log.jsonl'), false)
    assert.equal(isPrunableTemp('experience.json'), false)
    assert.equal(isPrunableTemp('checkpoint.json'), false)
    assert.equal(isPrunableTemp('registry.json'), false)
    assert.equal(isPrunableTemp('transcript.json'), false)
    assert.equal(isPrunableTemp('quality-gate.json'), false)
    assert.equal(isPrunableTemp(''), false)
    assert.equal(isPrunableTemp('.'), false)
    assert.equal(isPrunableTemp('..'), false)
    assert.equal(isPrunableTemp('tmp'), false)
    assert.equal(isPrunableTemp('.foo.tmpx'), false)
    assert.equal(isPrunableTemp('backups'), false)
  })

  it('never sweeps the decision-log lock file (it may guard a live append in flight)', () => {
    assert.equal(isPrunableTemp('.decision-log.lock'), false)
  })
})

// ─── stray temp file sweep (inspect + execute) ──────────────────────────────

describe('stray temp file sweep', () => {
  it('inspectPrune detects every temp convention and ignores state files', () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(iterateDir(dir), { recursive: true })
    writeFileSync(join(iterateDir(dir), 'decision-log.jsonl'), '', 'utf-8')
    writeFileSync(join(iterateDir(dir), '.experience.json.tmp-501-abc'), 'partial', 'utf-8')
    writeFileSync(join(iterateDir(dir), '.tmp-502-xyz'), 'partial', 'utf-8')
    writeFileSync(join(iterateDir(dir), 'transcript.json.tmp'), 'partial', 'utf-8')
    writeFileSync(join(iterateDir(dir), 'experience.json'), '{}', 'utf-8')

    const report = inspectPrune(dir, 30)
    assert.deepEqual(report.staleTemps, [
      '.experience.json.tmp-501-abc',
      '.tmp-502-xyz',
      'transcript.json.tmp',
    ])
    cleanup()
  })

  it('dry-run leaves temps in place; execute deletes them and reports the names', async () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(iterateDir(dir), { recursive: true })
    const tmp = join(iterateDir(dir), '.experience.json.tmp-501-abc')
    writeFileSync(tmp, 'partial', 'utf-8')
    writeFileSync(join(iterateDir(dir), 'experience.json'), '{"entries":[]}', 'utf-8')

    const tool = captureTool()
    await tool.execute({ path: dir })
    assert.equal(existsSync(tmp), true, 'dry-run must not delete temp files')

    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const result = out.result as { deletedTemps: string[] }
    assert.deepEqual(result.deletedTemps, ['.experience.json.tmp-501-abc'])
    assert.equal(existsSync(tmp), false)
    // Real state files are never swept.
    assert.equal(existsSync(join(iterateDir(dir), 'experience.json')), true)
    cleanup()
  })
})

// ─── iterate_prune tool (end-to-end) ────────────────────────────────────────

describe('iterate_prune tool', () => {
  it('dry-run default reports without deleting', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    const tool = captureTool()
    const out = (await tool.execute({ path: dir })) as Record<string, unknown>
    assert.equal(out.ok, true)
    assert.equal(out.dryRun, true)
    assert.equal((out.report as { oldLogEntries: number }).oldLogEntries, 1)
    // Nothing deleted in dry-run.
    const content = readFileSync(join(iterateDir(dir), 'decision-log.jsonl'), 'utf-8')
    assert.ok(content.trim().length > 0)
    cleanup()
  })

  it('dryRun:false actually prunes and logs', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    const tool = captureTool()
    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    assert.equal(out.dryRun, false)
    assert.equal((out.result as { deletedLogEntries: number }).deletedLogEntries, 1)
    const content = readFileSync(join(iterateDir(dir), 'decision-log.jsonl'), 'utf-8')
    assert.ok(!content.includes(daysAgoISO(60)))
    cleanup()
  })

  it('the decision-log rewrite preserves concurrent FRESH entries (bounded retry guard)', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    // A fresh audit line lands "during" the prune — it must survive the
    // read-before-rewrite window, never be silently dropped by the rewrite.
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(0), type: 'decision', data: { fresh: true } }))
    const tool = captureTool()
    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const result = out.result as { deletedLogEntries: number; errors: string[] }
    assert.equal(result.deletedLogEntries, 1)
    assert.deepEqual(result.errors, [])
    const content = readFileSync(join(iterateDir(dir), 'decision-log.jsonl'), 'utf-8')
    assert.ok(!content.includes(daysAgoISO(60)), 'stale entry removed')
    assert.ok(content.includes('"fresh":true'), 'fresh entry survives the rewrite')
    cleanup()
  })

  it('pruning a log with nothing to remove is a clean no-op', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(1), type: 'decision', data: {} }))
    const tool = captureTool()
    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const result = out.result as { deletedLogEntries: number; errors: string[] }
    assert.equal(result.deletedLogEntries, 0)
    assert.deepEqual(result.errors, [])
    cleanup()
  })

  it('concurrent-appender lock is stolen when its holder is dead, so prune still runs', async () => {
    const { dir, cleanup } = tempProject()
    appendDecisionEntry(dir, entry({ timestamp: daysAgoISO(60), type: 'decision', data: {} }))
    // Simulate a crashed second process that left its lock behind (dead pid).
    writeFileSync(join(iterateDir(dir), '.decision-log.lock'), '99999999', 'utf-8')
    const tool = captureTool()
    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const result = out.result as { deletedLogEntries: number; errors: string[] }
    assert.equal(result.deletedLogEntries, 1)
    assert.deepEqual(result.errors, [])
    // The lock is gone (released by the rewrite) and no stale lock is left sweeping.
    assert.equal(existsSync(join(iterateDir(dir), '.decision-log.lock')), false)
    cleanup()
  })

  it('surfaces a failed prune decision-log append in result.errors (F2)', async () => {
    const { dir, cleanup } = tempProject()
    try {
      // decision-log.jsonl is a DIRECTORY → appending the prune audit entry
      // fails with EISDIR. The deletions still happen, but the audit miss must
      // be reported, never silently swallowed.
      mkdirSync(join(dir, '.iterate', 'decision-log.jsonl'), { recursive: true })
      writeFileSync(checkpointPath(dir), '{}', 'utf-8')
      const tool = captureTool()
      const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
      assert.equal(out.ok, true)
      const result = out.result as { deletedCheckpoint: boolean; errors: string[] }
      assert.equal(result.deletedCheckpoint, true)
      assert.ok(
        result.errors.some((e) => e.includes('failed to append decision log')),
        `expected an append error in ${JSON.stringify(result.errors)}`,
      )
    } finally {
      cleanup()
    }
  })

  it('render shows dry-run guidance', async () => {
    const { dir, cleanup } = tempProject()
    const tool = captureTool()
    const out = (await tool.execute({ path: dir })) as Record<string, unknown>
    const text = tool.render({}, out).map((m) => m.text).join('\n')
    assert.match(text, /dry-run/)
    assert.match(text, /retainDays=30/)
    cleanup()
  })

  it('reports an error for an invalid path', async () => {
    const tool = captureTool()
    const out = (await tool.execute({ path: '/' })) as Record<string, unknown>
    assert.equal(out.ok, false)
    assert.equal(typeof out.error, 'string')
  })
})

// ─── decision-log cross-process lock (F19) ──────────────────────────────────

describe('decision-log lock', () => {
  it('appendDecisionEntry steals a stale lock left by a dead holder', () => {
    const { dir, cleanup } = tempProject()
    mkdirSync(iterateDir(dir), { recursive: true })
    // A crashed process's lock: pid 99999999 does not exist, so it is stale
    // and must be stolen rather than wedging future appends for 5s.
    writeFileSync(join(iterateDir(dir), '.decision-log.lock'), '99999999', 'utf-8')
    const res = appendDecisionEntry(dir, entry({ type: 'decision', data: { ok: true } }))
    assert.equal(res.error, undefined)
    assert.equal(res.count, 1)
    assert.equal(readDecisionEntries(dir).length, 1)
    // The lock was released cleanly after the append.
    assert.equal(existsSync(join(iterateDir(dir), '.decision-log.lock')), false)
    cleanup()
  })
})

// ─── experience bank sweep ──────────────────────────────────────────────────

describe('sweepExperienceBank', () => {
  const mkEntry = (id: string, iso: string): ExperienceBank['entries'][number] => ({
    id,
    timestamp: iso,
    dimension: 'correctness',
    pattern: `pattern-${id}`,
    description: 'd',
    verifiedFix: 'f',
    files: [],
    tags: [],
    findingSummary: 's',
    severity: 'high',
    hitCount: 1,
  })

  it('keeps only the newest MAX_EXPERIENCE_ENTRIES by timestamp', () => {
    const bank: ExperienceBank = {
      lastUpdated: 't',
      totalHits: 100,
      entries: Array.from({ length: MAX_EXPERIENCE_ENTRIES + 25 }, (_, i) =>
        mkEntry(`e${i}`, daysAgoISO(100 - i)), // newest = last
      ),
    }
    const { removed, bank: next } = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES)
    assert.equal(removed, 25)
    assert.equal(next.entries.length, MAX_EXPERIENCE_ENTRIES)
    // The 25 oldest are gone; the newest survive in insertion order.
    assert.equal(next.entries[0]!.id, 'e25')
    assert.equal(next.entries[next.entries.length - 1]!.id, `e${MAX_EXPERIENCE_ENTRIES + 24}`)
  })

  it('is a no-op when the bank is under the cap and preserves order', () => {
    const bank: ExperienceBank = {
      lastUpdated: 't',
      totalHits: 3,
      entries: [mkEntry('early', daysAgoISO(90)), mkEntry('mid', daysAgoISO(30)), mkEntry('new', daysAgoISO(1))],
    }
    const { removed, bank: next } = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES)
    assert.equal(removed, 0)
    assert.deepEqual(next.entries.map((e) => e.id), bank.entries.map((e) => e.id))
  })
})

// ─── defense event sweep ────────────────────────────────────────────────────

describe('sweepDefenseEvents', () => {
  const mkEvent = (id: string, type: DefenseEvent['type'], iso: string): DefenseEvent => ({
    id,
    timestamp: iso,
    round: 1,
    type,
    description: 'd',
    defense: 'f',
    outcome: 'o',
    severity: 'high',
  })

  it('drops events older than the cutoff and recomputes counts', () => {
    const stream = {
      lastUpdated: 't',
      counts: { precondition_failed: 0, rollback: 3, invariant_violated: 0, assumption_falsified: 1 },
      events: [
        mkEvent('old-rollback', 'rollback', daysAgoISO(60)),
        mkEvent('old-falsified', 'assumption_falsified', daysAgoISO(120)),
        mkEvent('fresh-rollback', 'rollback', daysAgoISO(1)),
      ],
    }
    const { removed, stream: next } = sweepDefenseEvents(stream, cutoffTimestamp(30))
    assert.equal(removed, 2)
    assert.deepEqual(next.events.map((e) => e.id), ['fresh-rollback'])
    assert.deepEqual(next.counts, { precondition_failed: 0, rollback: 1, invariant_violated: 0, assumption_falsified: 0 })
  })
})

// ─── experience + defense pruning (persisted end-to-end) ────────────────────

describe('ExperienceBank/DefenseEvent pruning (end-to-end)', () => {
  it('prunes persisted oversize experience and stale defense events when dryRun:false', async () => {
    const { dir, cleanup } = tempProject()
    const bank: ExperienceBank = {
      lastUpdated: 't',
      totalHits: MAX_EXPERIENCE_ENTRIES + 3,
      entries: Array.from({ length: MAX_EXPERIENCE_ENTRIES + 3 }, (_, i) => ({
        id: `e${i}`,
        timestamp: daysAgoISO(500 - i),
        dimension: 'correctness',
        pattern: `p${i}`,
        description: 'd',
        verifiedFix: 'f',
        files: [],
        tags: [],
        findingSummary: 's',
        severity: 'high',
        hitCount: 1,
      })),
    }
    writeExperienceBank(dir, bank)
    writeDefenseEvents(dir, {
      lastUpdated: 't',
      counts: { precondition_failed: 0, rollback: 2, invariant_violated: 0, assumption_falsified: 0 },
      events: [
        { id: 'stale', timestamp: daysAgoISO(400), round: 1, type: 'rollback', description: 'd', defense: 'f', outcome: 'o', severity: 'high' },
        { id: 'fresh', timestamp: daysAgoISO(1), round: 2, type: 'rollback', description: 'd', defense: 'f', outcome: 'o', severity: 'high' },
      ],
    })

    const report = inspectPrune(dir, 30)
    assert.equal(report.totalExperiences, MAX_EXPERIENCE_ENTRIES + 3)
    assert.equal(report.experienceOversize, 3)
    assert.equal(report.totalDefenseEvents, 2)
    assert.equal(report.staleDefenseEvents, 1)

    const tool = captureTool()
    const out = (await tool.execute({ path: dir, dryRun: false })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const result = out.result as { deletedExperiences: number; deletedDefenseEvents: number }
    assert.equal(result.deletedExperiences, 3)
    assert.equal(result.deletedDefenseEvents, 1)
    const prunedBank = readExperienceBank(dir)
    assert.equal(prunedBank.entries.length, MAX_EXPERIENCE_ENTRIES)
    const prunedDefense = readDefenseEvents(dir)
    assert.deepEqual(prunedDefense.events.map((e) => e.id), ['fresh'])
    assert.equal(prunedDefense.counts.rollback, 1)
    cleanup()
  })

  it('oversize/stale flags all read zero on a healthy project', async () => {
    const { dir, cleanup } = tempProject()
    const tool = captureTool()
    const out = (await tool.execute({ path: dir })) as Record<string, unknown>
    assert.equal(out.ok, true)
    const report = out.report as {
      totalExperiences: number
      experienceOversize: number
      totalDefenseEvents: number
      staleDefenseEvents: number
    }
    assert.equal(report.totalExperiences, 0)
    assert.equal(report.experienceOversize, 0)
    assert.equal(report.totalDefenseEvents, 0)
    assert.equal(report.staleDefenseEvents, 0)
    cleanup()
  })
})
