import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  hashString,
  fixId,
  diffLines,
  countChangedLines,
  buildDiffSummary,
  emptyRegistry,
  readRegistry,
  findFixRecord,
  recordsForFile,
  upsertRecord,
  removeRecord,
  resolveProjectFile,
  registerFixTool,
  registerDiffTool,
  registerRollbackTool,
} from '../src/tools/fix.ts'
import { readDecisionEntries } from '../src/tools/decision-log.ts'
import type { FixRegistry, ReviewFinding } from '../src/types.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

type ToolDef = { execute: (a: unknown, e: unknown) => Promise<unknown> }
type Tool = (args: unknown) => Promise<unknown>

/** Register several tools and capture their execute functions in order. */
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

/** Create a temp project dir with optional files (nested paths supported). */
function tempProject(files: Record<string, string> = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-fix-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  dimension: 'correctness',
  file: 'src/app.ts',
  line: 2,
  severity: 'high',
  summary: 'Handle null input',
  failure_scenario: 'undefined input crashes',
  suggested_fix: 'Guard the input',
  is_atomic: true,
  ...over,
})

const ORIGINAL = 'function greet(name) {\n  return name.toUpperCase()\n}\n'
const FIXED = 'function greet(name) {\n  if (!name) return "ANON"\n  return name.toUpperCase()\n}\n'

// ─── hashString / fixId ──────────────────────────────────────────────────────

describe('hashString / fixId', () => {
  it('produces a deterministic short hash', () => {
    assert.equal(hashString('abc'), hashString('abc'))
    assert.notEqual(hashString('abc'), hashString('abd'))
    assert.match(hashString('abc'), /^[a-z0-9]+$/)
  })

  it('fixId is stable for the same finding and differs across findings', () => {
    assert.equal(fixId(finding()), fixId(finding()))
    assert.notEqual(fixId(finding()), fixId(finding({ summary: 'Other issue' })))
    assert.notEqual(fixId(finding()), fixId(finding({ file: 'src/b.ts' })))
    assert.match(fixId(finding()), /^fix-[a-z0-9]+$/)
  })
})

// ─── diffLines / countChangedLines / buildDiffSummary ───────────────────────

describe('diff helpers', () => {
  it('returns [] when the texts are identical', () => {
    assert.deepEqual(diffLines(ORIGINAL, ORIGINAL), [])
    assert.equal(buildDiffSummary([]), 'no changes')
  })

  it('detects an insertion hunk with correct line counts', () => {
    const hunks = diffLines(ORIGINAL, FIXED)
    assert.equal(hunks.length, 1)
    const h = hunks[0]!
    assert.equal(h.newLines, 1)
    assert.equal(h.oldLines, 0)
    assert.match(h.content, /\+\s+if \(!name\) return "ANON"/)
    assert.deepEqual(countChangedLines(ORIGINAL, FIXED), { added: 1, removed: 0 })
  })

  it('detects a removal hunk', () => {
    const hunks = diffLines(FIXED, ORIGINAL)
    assert.equal(hunks.length, 1)
    assert.deepEqual(countChangedLines(FIXED, ORIGINAL), { added: 0, removed: 1 })
  })

  it('summarizes added/removed counts', () => {
    assert.equal(buildDiffSummary(diffLines(ORIGINAL, FIXED)), '+1/-0 lines (1 hunk)')
  })
})

// ─── Registry pure helpers ───────────────────────────────────────────────────

describe('registry helpers', () => {
  it('emptyRegistry has no rounds', () => {
    assert.deepEqual(emptyRegistry(), { rounds: [] })
  })

  it('upsertRecord adds a record and recomputes per-round counts', () => {
    const record = {
      id: 'fix-abc',
      timestamp: '2026-08-16T00:00:00.000Z',
      round: 1,
      finding: finding(),
      backupPath: '/tmp/x.bak',
      diffSummary: '+2/-0 lines',
      linesAdded: 2,
      linesRemoved: 0,
      success: true,
    }
    const next = upsertRecord(emptyRegistry(), record)
    assert.equal(next.rounds.length, 1)
    const round = next.rounds[0]!
    assert.equal(round.round, 1)
    assert.equal(round.fixedCount, 1)
    assert.equal(round.failedCount, 0)
    assert.equal(round.records.length, 1)
    assert.equal(round.records[0]!.id, 'fix-abc')
  })

  it('upsertRecord replaces a record with the same id instead of duplicating', () => {
    const base: FixRegistry = {
      rounds: [
        { round: 1, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-x', timestamp: 't', round: 1, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true }] },
      ],
    }
    const next = upsertRecord(base, { id: 'fix-x', timestamp: 't2', round: 1, finding: finding({ summary: 'Updated' }), backupPath: '/b2', diffSummary: 'y', linesAdded: 3, linesRemoved: 0, success: true })
    assert.equal(next.rounds[0]!.records.length, 1)
    assert.equal(next.rounds[0]!.records[0]!.diffSummary, 'y')
  })

  it('findFixRecord finds across rounds and returns undefined otherwise', () => {
    const registry: FixRegistry = {
      rounds: [
        { round: 1, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-a', timestamp: 't', round: 1, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true }] },
        { round: 2, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-b', timestamp: 't', round: 2, finding: finding({ file: 'src/b.ts' }), backupPath: '/b2', diffSummary: 'y', linesAdded: 1, linesRemoved: 0, success: true }] },
      ],
    }
    assert.equal(findFixRecord(registry, 'fix-b')?.finding.file, 'src/b.ts')
    assert.equal(findFixRecord(registry, 'fix-missing'), undefined)
  })

  it('recordsForFile filters successful records for a file', () => {
    const registry: FixRegistry = {
      rounds: [
        { round: 1, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-a', timestamp: 't', round: 1, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true }] },
        { round: 2, fixedCount: 0, failedCount: 1, records: [{ id: 'fix-c', timestamp: 't', round: 2, finding: finding({ summary: 'failed' }), backupPath: '/b3', diffSummary: 'x', linesAdded: 0, linesRemoved: 0, success: false }] },
        { round: 3, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-d', timestamp: 't', round: 3, finding: finding({ file: 'src/other.ts' }), backupPath: '/b4', diffSummary: 'y', linesAdded: 1, linesRemoved: 0, success: true }] },
      ],
    }
    const recs = recordsForFile(registry, 'src/app.ts')
    assert.equal(recs.length, 1)
    assert.equal(recs[0]!.id, 'fix-a')
  })

  it('removeRecord deletes a record and drops empty rounds', () => {
    const registry: FixRegistry = {
      rounds: [
        { round: 1, fixedCount: 1, failedCount: 0, records: [{ id: 'fix-a', timestamp: 't', round: 1, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true }] },
      ],
    }
    const next = removeRecord(registry, 'fix-a')
    assert.deepEqual(next, { rounds: [] })
  })

  it('readRegistry returns empty for a missing or corrupt file', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.deepEqual(readRegistry(dir), { rounds: [] })
      mkdirSync(join(dir, '.iterate', 'fixes'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'fixes', 'registry.json'), '{ not json', 'utf-8')
      assert.deepEqual(readRegistry(dir), { rounds: [] })
    } finally {
      cleanup()
    }
  })
})

// ─── resolveProjectFile (path safety) ────────────────────────────────────────

describe('resolveProjectFile', () => {
  it('accepts a relative path inside the project', () => {
    const r = resolveProjectFile('/proj', 'src/app.ts')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.resolved, join('/proj', 'src', 'app.ts'))
  })

  it('rejects empty, absolute, and traversing paths', () => {
    assert.equal(resolveProjectFile('/proj', '').ok, false)
    assert.equal(resolveProjectFile('/proj', '/etc/passwd').ok, false)
    assert.equal(resolveProjectFile('/proj', 'C:\\x').ok, false)
    assert.equal(resolveProjectFile('/proj', '../escape.ts').ok, false)
    assert.equal(resolveProjectFile('/proj', 'src/../../escape.ts').ok, false)
  })
})

// ─── End-to-end tool execution ───────────────────────────────────────────────

describe('iterate_fix / iterate_diff / iterate_rollback execute', () => {
  it('applies a fix with backup + registry + decision-log entry', async () => {
    const [fix, diff, rollback] = captureTools([registerFixTool, registerDiffTool, registerRollbackTool]) as [Tool, Tool, Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      const res = (await fix({
        file: 'src/app.ts',
        content: FIXED,
        finding: finding(),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.match(String(res.id), /^fix-/)
      assert.equal(res.file, 'src/app.ts')
      assert.equal(res.linesAdded, 1)
      assert.equal(res.linesRemoved, 0)

      // File updated + original backed up.
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), FIXED)
      const registry = readRegistry(dir)
      assert.equal(registry.rounds.length, 1)
      assert.equal(registry.rounds[0]!.fixedCount, 1)
      assert.ok(existsSync(registry.rounds[0]!.records[0]!.backupPath))
      assert.equal(readFileSync(registry.rounds[0]!.records[0]!.backupPath, 'utf-8'), ORIGINAL)

      // Decision log has an atomic_fix entry.
      const entries = readDecisionEntries(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.type, 'atomic_fix')
      assert.equal(entries[0]!.round, 1)

      // Diff reflects the accumulated change.
      const diffRes = (await diff({ file: 'src/app.ts', path: dir })) as Record<string, unknown>
      assert.equal(diffRes.ok, true)
      assert.match(String(diffRes.diffSummary), /\+1\/-0/)

      // Rollback restores the original and clears the registry.
      const rb = (await rollback({ id: res.id, path: dir })) as Record<string, unknown>
      assert.equal(rb.ok, true)
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), ORIGINAL)
      assert.deepEqual(readRegistry(dir), { rounds: [] })
      assert.equal(readDecisionEntries(dir).some((e) => e.type === 'revert'), true)
    } finally {
      cleanup()
    }
  })

  it('enforces the atomic max_lines threshold unless force is set', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/big.ts': 'const x = 1\n' })
    try {
      const bigContent = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}\n`).join('')
      const res = (await fix({
        file: 'src/big.ts',
        content: bigContent,
        finding: finding({ file: 'src/big.ts' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /exceeds the atomic threshold/)

      // force bypasses the threshold.
      const forced = (await fix({
        file: 'src/big.ts',
        content: bigContent,
        finding: finding({ file: 'src/big.ts' }),
        round: 1,
        force: true,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(forced.ok, true)
    } finally {
      cleanup()
    }
  })

  it('rejects a finding that was already fixed this run', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      const args = { file: 'src/app.ts', content: FIXED, finding: finding(), round: 1, path: dir }
      const first = (await fix(args)) as Record<string, unknown>
      assert.equal(first.ok, true)
      const second = (await fix(args)) as Record<string, unknown>
      assert.equal(second.ok, false)
      assert.match(String(second.error), /already fixed this run/)
    } finally {
      cleanup()
    }
  })

  it('validates inputs: missing file / content / round / finding', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      // Fields that pass the schema but are invalid at runtime return { ok: false }.
      assert.equal(((await fix({ file: '', content: FIXED, finding: finding(), round: 1, path: dir })) as { ok: boolean }).ok, false)
      assert.equal(((await fix({ file: 'src/app.ts', content: FIXED, finding: finding(), round: 0, path: dir })) as { ok: boolean }).ok, false)
      // Required fields missing are rejected by the tool schema (ToolArgsError).
      await assert.rejects(() => fix({ file: 'src/app.ts', finding: finding(), round: 1, path: dir }), /content/)
      await assert.rejects(() => fix({ file: 'src/app.ts', content: FIXED, round: 1, path: dir }), /finding/)
    } finally {
      cleanup()
    }
  })

  it('diff returns a per-file summary when no file is given', async () => {
    const [fix, diff] = captureTools([registerFixTool, registerDiffTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      await fix({ file: 'src/app.ts', content: FIXED, finding: finding(), round: 1, path: dir })
      const res = (await diff({ path: dir })) as Record<string, unknown>
      assert.equal(res.ok, true)
      const files = res.files as Array<{ file: string }>
      assert.equal(files.length, 1)
      assert.equal(files[0]!.file, 'src/app.ts')
    } finally {
      cleanup()
    }
  })
})
