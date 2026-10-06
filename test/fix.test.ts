import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
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
  normalizeProjectPath,
  resolveBackupPath,
  globMatch,
  registerFixTool,
  registerDiffTool,
  registerRollbackTool,
  MAX_FIX_CONTENT_CHARS,
} from '../src/tools/fix.ts'
import { acquireProjectLock } from '../src/file-lock.ts'
import { fixBackupPath, fixesDir } from '../src/paths.ts'
import { readDecisionEntries, readDecisionLogDetailed } from '../src/tools/decision-log.ts'
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

  it('splits a two-spot change into two hunks with exact counts', () => {
    // Regression: the old single-hunk diff reported the WHOLE span between the
    // two spots ({added:100, removed:100} here), which false-rejected the fix
    // at the atomic gate and persisted wrong line counts.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    const before = lines.join('\n')
    const mutated = [...lines]
    mutated[0] = 'CHANGED line 1'
    mutated[99] = 'CHANGED line 100'
    const after = mutated.join('\n')
    assert.deepEqual(countChangedLines(before, after), { added: 2, removed: 2 })
    const hunks = diffLines(before, after)
    assert.equal(hunks.length, 2)
    assert.deepEqual(
      hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newLines: h.newLines })),
      [
        { oldStart: 1, oldLines: 1, newLines: 1 },
        { oldStart: 100, oldLines: 1, newLines: 1 },
      ],
    )
    assert.equal(buildDiffSummary(hunks), '+2/-2 lines (2 hunks)')
  })

  it('reports pure insertions and deletions as single exact hunks', () => {
    const before = 'a\nb\nc\n'
    const inserted = 'a\nb\nx\ny\nc\n'
    const insHunks = diffLines(before, inserted)
    assert.equal(insHunks.length, 1)
    assert.equal(insHunks[0]!.oldLines, 0)
    assert.equal(insHunks[0]!.newLines, 2)
    assert.deepEqual(countChangedLines(before, inserted), { added: 2, removed: 0 })

    const delHunks = diffLines(inserted, before)
    assert.equal(delHunks.length, 1)
    assert.equal(delHunks[0]!.oldLines, 2)
    assert.equal(delHunks[0]!.newLines, 0)
    assert.deepEqual(countChangedLines(inserted, before), { added: 0, removed: 2 })
  })

  it('reports a single-line edit as one hunk with aligned coordinates', () => {
    const hunks = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0]!.oldStart, 2)
    assert.equal(hunks[0]!.newStart, 2)
    assert.equal(hunks[0]!.oldLines, 1)
    assert.equal(hunks[0]!.newLines, 1)
    assert.deepEqual(countChangedLines('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 })
  })

  it('falls back to one hunk for over-budget regions instead of hanging', () => {
    const mk = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
    const mutateEnds = (n: number): string => {
      const lines = mk(n).split('\n')
      lines[0] = 'CHANGED first'
      lines[n - 1] = 'CHANGED last'
      return lines.join('\n')
    }
    const t0 = Date.now()
    // 300x300 = 90k cells exceeds the DP budget → bounded single-hunk fallback.
    const small = diffLines(mk(300), mutateEnds(300))
    assert.equal(small.length, 1)
    // 6000 lines per side exceeds the per-side guard → same fallback.
    const big = diffLines(mk(6000), mutateEnds(6000))
    assert.equal(big.length, 1)
    assert.ok(big[0]!.oldLines > 0 && big[0]!.newLines > 0, 'fallback still reports both sides')
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 5000, `bounded fallback must not hang (took ${elapsed}ms)`)
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

  it('readRegistry normalizes malformed rounds/records instead of crashing readers', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate', 'fixes'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'fixes', 'registry.json'), JSON.stringify({
        rounds: [
          // Round with a bad `records` member kind — dropped wholesale.
          { round: 1, fixedCount: 1, failedCount: 0, records: 'nope' },
          // Records lacking id or finding object — dropped individually.
          { round: 2, fixedCount: 1, failedCount: 0, records: [
            { id: 'fix-ok', timestamp: 't', round: 2, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true },
            { id: null, timestamp: 't', round: 2, finding: finding() },
            { timestamp: 't', round: 2, finding: finding() },
            { id: 'fix-no-finding', timestamp: 't', round: 2 },
          ] },
        ],
      }), 'utf-8')
      const registry = readRegistry(dir)
      assert.equal(registry.rounds.length, 1) // round 1 dropped (records not an array)
      assert.equal(registry.rounds[0]!.records.length, 1) // only fix-ok survives
      assert.equal(registry.rounds[0]!.records[0]!.id, 'fix-ok')
      // Consumers never throw on the normalized registry.
      assert.equal(findFixRecord(registry, 'fix-ok')?.id, 'fix-ok')
      assert.equal(findFixRecord(registry, 'fix-no-finding'), undefined)
      assert.deepEqual(recordsForFile(registry, 'src/app.ts').map((r) => r.id), ['fix-ok'])
    } finally {
      cleanup()
    }
  })

  it('floors hand-edited float counters to integers (status schema is integer)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate', 'fixes'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'fixes', 'registry.json'), JSON.stringify({
        rounds: [
          {
            round: 1.9,
            fixedCount: 1.5,
            failedCount: 2.5,
            records: [
              { id: 'fix-ok', timestamp: 't', round: 1, finding: finding(), backupPath: '/b', diffSummary: 'x', linesAdded: 1, linesRemoved: 0, success: true },
            ],
          },
        ],
      }), 'utf-8')
      const registry = readRegistry(dir)
      const round = registry.rounds[0]!
      assert.equal(round.round, 1)
      assert.equal(round.fixedCount, 1)
      assert.equal(round.failedCount, 2)
      assert.equal(Number.isInteger(round.fixedCount), true)
      assert.equal(Number.isInteger(round.failedCount), true)
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

  it('rejects a symlinked file pointing outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'iterate-fix-outside-'))
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf-8')
      mkdirSync(join(dir, 'src'), { recursive: true })
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'src', 'app.ts'))
      const r = resolveProjectFile(dir, 'src/app.ts')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.reason, /symlink escape/)
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a NEW file whose parent is a symlink pointing outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'iterate-fix-outside-'))
    const { dir, cleanup } = tempProject()
    try {
      // `src` does not exist yet as a real dir; it is a symlink to a dir
      // OUTSIDE the project. Writing src/new-file.ts must be rejected even
      // though src/new-file.ts itself does not exist.
      symlinkSync(outside, join(dir, 'src'))
      const r = resolveProjectFile(dir, 'src/new-file.ts')
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.reason, /symlink escape/)
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts a NEW file whose parent chain is a plain nonexistent path inside the project', () => {
    const { dir, cleanup } = tempProject()
    try {
      const r = resolveProjectFile(dir, 'a/b/c/new-file.ts')
      assert.equal(r.ok, true)
    } finally {
      cleanup()
    }
  })

  it('rejects empty, absolute, and traversing paths', () => {
    assert.equal(resolveProjectFile('/proj', '').ok, false)
    assert.equal(resolveProjectFile('/proj', '/etc/passwd').ok, false)
    assert.equal(resolveProjectFile('/proj', 'C:\\x').ok, false)
    assert.equal(resolveProjectFile('/proj', '../escape.ts').ok, false)
    assert.equal(resolveProjectFile('/proj', 'src/../../escape.ts').ok, false)
  })
})

// ─── normalizeProjectPath / resolveBackupPath ───────────────────────────────

describe('normalizeProjectPath', () => {
  it('strips ./, collapses separators, and resolves . / .. segments', () => {
    assert.equal(normalizeProjectPath('./README.md'), 'README.md')
    assert.equal(normalizeProjectPath('src/../README.md'), 'README.md')
    assert.equal(normalizeProjectPath('src//deep/./a.ts'), 'src/deep/a.ts')
    assert.equal(normalizeProjectPath('README.md'), 'README.md')
    // Escapes survive normalization — resolveProjectFile rejects them later.
    assert.equal(normalizeProjectPath('../escape.ts'), '../escape.ts')
    assert.equal(normalizeProjectPath(''), '')
    assert.equal(normalizeProjectPath(undefined as unknown as string), '')
  })
})

describe('resolveBackupPath', () => {
  it('accepts a backup inside the project fixes dir (absolute and relative)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(fixesDir(dir), { recursive: true })
      const inside = join(fixesDir(dir), 'fix-abc_x.bak')
      writeFileSync(inside, 'orig', 'utf-8')
      const abs = resolveBackupPath(dir, inside)
      assert.equal(abs.ok, true)
      // A legacy relative entry anchored at the project root also resolves.
      const rel = resolveBackupPath(dir, '.iterate/fixes/fix-abc_x.bak')
      assert.equal(rel.ok, true)
      if (rel.ok) assert.equal(readFileSync(rel.resolved, 'utf-8'), 'orig')
    } finally {
      cleanup()
    }
  })

  it('rejects escapes (relative and absolute) and missing paths', () => {
    assert.equal(resolveBackupPath('/proj', '../../etc/passwd').ok, false)
    assert.equal(resolveBackupPath('/proj', '/etc/passwd').ok, false)
    assert.equal(resolveBackupPath('/proj', '').ok, false)
  })

  it('rejects a symlink inside the fixes dir pointing outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'iterate-fix-outside-'))
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf-8')
      mkdirSync(fixesDir(dir), { recursive: true })
      symlinkSync(join(outside, 'secret.txt'), join(fixesDir(dir), 'fix-abc_x.bak'))
      const r = resolveBackupPath(dir, join(fixesDir(dir), 'fix-abc_x.bak'))
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.reason, /symlink/)
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ─── fixBackupPath ──────────────────────────────────────────────────────────

describe('fixBackupPath', () => {
  it('produces <fixId>_<collapsed-timestamp>.bak under .iterate/fixes', () => {
    const { dir, cleanup } = tempProject()
    try {
      const path = fixBackupPath(dir, 'fix-abc', '2026-08-16T12:34:56.789Z')
      assert.equal(path, join(dir, '.iterate', 'fixes', 'fix-abc_2026-08-16T12-34-56-789Z.bak'))
    } finally {
      cleanup()
    }
  })

  it('sanitizes unsafe id characters and leaves dots out of the timestamp', () => {
    const path = fixBackupPath('/proj', 'fix a/b', 'T00:00:00.000Z')
    assert.equal(path, join('/proj', '.iterate', 'fixes', 'fix_a_b_T00-00-00-000Z.bak'))
    assert.equal(path.includes(':'), false)
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

  it('rejects a fix whose registry write fails and restores the original atomically', async () => {
    // Cover the compensating-restore path: registry write fails → the source
    // file must be restored from backup via the ATOMIC writer (never a raw
    // copy that could leave a truncated file on crash). Sabotage: make the
    // registry path a DIRECTORY so the atomic rename cannot replace it.
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      mkdirSync(join(dir, '.iterate', 'fixes', 'registry.json'), { recursive: true })
      const res = (await fix({
        file: 'src/app.ts',
        content: FIXED,
        finding: finding(),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /failed to write fix registry/)
      // Original content restored.
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), ORIGINAL)
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

  it('rejects content beyond MAX_FIX_CONTENT_CHARS before touching disk', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      const oversize = 'x'.repeat(MAX_FIX_CONTENT_CHARS + 1)
      const res = (await fix({
        file: 'src/app.ts',
        content: oversize,
        finding: finding(),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /character limit/)
      // Nothing was written: no registry, no decision-log entry, file intact.
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), ORIGINAL)
      assert.deepEqual(readRegistry(dir), { rounds: [] })
      assert.equal(readDecisionEntries(dir).filter((e) => e.type === 'atomic_fix').length, 0)
    } finally {
      cleanup()
    }
  })

  it('enforces the atomic max_adjacent_methods threshold unless force is set', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const twoMethod = 'function first() {\n  return 1\n}\nfunction second() {\n  return 2\n}\n'
    const fixedBoth = 'function first() {\n  return 10\n}\nfunction second() {\n  return 20\n}\n'
    const { dir, cleanup } = tempProject({
      'iterate.config.yaml': 'goal: test\natomic:\n  max_lines: 20\n  max_adjacent_methods: 1\n',
      'src/two.ts': twoMethod,
    })
    try {
      const res = (await fix({
        file: 'src/two.ts',
        content: fixedBoth,
        finding: finding({ file: 'src/two.ts' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /exceeds atomic.max_adjacent_methods/)

      // force bypasses the adjacent-methods threshold.
      const forced = (await fix({
        file: 'src/two.ts',
        content: fixedBoth,
        finding: finding({ file: 'src/two.ts' }),
        round: 1,
        force: true,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(forced.ok, true)
    } finally {
      cleanup()
    }
  })

  it('allows a multi-method fix that stays within the default threshold', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const twoMethod = 'function first() {\n  return 1\n}\nfunction second() {\n  return 2\n}\n'
    const fixedBoth = 'function first() {\n  return 10\n}\nfunction second() {\n  return 20\n}\n'
    const { dir, cleanup } = tempProject({ 'src/two.ts': twoMethod })
    try {
      const res = (await fix({
        file: 'src/two.ts',
        content: fixedBoth,
        finding: finding({ file: 'src/two.ts' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
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

  it('rejects a content-identical no-op fix without touching any state', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      // Sending the CURRENT content back must not create a backup, a registry
      // record, a decision-log entry, or rewrite the file — and force:true
      // must NOT let a non-edit masquerade as a fix.
      const res = (await fix({ file: 'src/app.ts', content: ORIGINAL, finding: finding(), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /no changes/)
      const forced = (await fix({ file: 'src/app.ts', content: ORIGINAL, finding: finding(), round: 1, path: dir, force: true })) as Record<string, unknown>
      assert.equal(forced.ok, false)
      assert.match(String(forced.error), /no changes/)
      // Nothing was written: no .iterate artifacts and the file is untouched.
      assert.equal(existsSync(join(dir, '.iterate', 'fixes')), false)
      assert.equal(existsSync(join(dir, '.iterate', 'decision-log.jsonl')), false)
      assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf-8'), ORIGINAL)
    } finally {
      cleanup()
    }
  })

  it('surfaces a decision-log append failure as a warning (fix + rollback)', async () => {
    const [fix, rollback] = captureTools([registerFixTool, registerRollbackTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      // A DIRECTORY at decision-log.jsonl makes every append fail with EISDIR,
      // forcing the F2 path: the mutation still succeeds but the audit miss is
      // surfaced instead of dropped.
      mkdirSync(join(dir, '.iterate', 'decision-log.jsonl'), { recursive: true })
      const fixRes = (await fix({ file: 'src/app.ts', content: FIXED, finding: finding(), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(fixRes.ok, true)
      assert.match(String(fixRes.warning), /failed to append decision log/)
      const rbRes = (await rollback({ id: String(fixRes.id), path: dir })) as Record<string, unknown>
      assert.equal(rbRes.ok, true)
      assert.match(String(rbRes.warning), /failed to append decision log/)
      // The file was still restored even though the audit write failed.
      assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf-8'), ORIGINAL)
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

// ─── Safety-gate / security regressions (atomicity, veto, containment, LIFO) ─

describe('iterate_fix atomic gate with multi-hunk diffs', () => {
  it('passes a two-spot 2-line change at max_lines=10 without force', async () => {
    // Regression: the single-hunk diff reported {added:100, removed:100} for
    // this change, false-rejecting it and pushing the model toward force:true
    // (which bypasses the safety gate entirely).
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    const after = [...lines]
    after[0] = 'CHANGED line 1'
    after[99] = 'CHANGED line 100'
    const { dir, cleanup } = tempProject({
      'iterate.config.yaml': 'goal: test\natomic:\n  max_lines: 10\n  max_adjacent_methods: 3\n',
      'src/big.ts': lines.join('\n'),
    })
    try {
      const res = (await fix({
        file: 'src/big.ts',
        content: after.join('\n'),
        finding: finding({ file: 'src/big.ts' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, true, String(res.error))
      assert.equal(res.linesAdded, 2)
      assert.equal(res.linesRemoved, 2)
      assert.match(String(res.diffSummary), /\+2\/-2 lines \(2 hunks\)/)
      const round = readRegistry(dir).rounds[0]!
      assert.equal(round.records[0]!.linesAdded, 2)
      assert.equal(round.records[0]!.linesRemoved, 2)
    } finally {
      cleanup()
    }
  })
})

describe('iterate_fix protected_paths veto (normalized intake)', () => {
  const config = 'goal: test\npersonalization:\n  protected_paths:\n    - README.md\n'

  it('vetoes ./README.md against the pattern README.md', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({
      'iterate.config.yaml': config,
      'README.md': '# Readme\n',
    })
    try {
      const res = (await fix({
        file: './README.md',
        content: '# Readme v2\n',
        finding: finding({ file: './README.md' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /protected path "README\.md"/)
      // Nothing was modified.
      assert.equal(readFileSync(join(dir, 'README.md'), 'utf-8'), '# Readme\n')
      assert.deepEqual(readRegistry(dir), { rounds: [] })
    } finally {
      cleanup()
    }
  })

  it('vetoes src/../README.md (normalized before matching)', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({
      'iterate.config.yaml': config,
      'README.md': '# Readme\n',
    })
    try {
      const res = (await fix({
        file: 'src/../README.md',
        content: '# Readme v2\n',
        finding: finding({ file: 'src/../README.md' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /protected path "README\.md"/)
      assert.equal(readFileSync(join(dir, 'README.md'), 'utf-8'), '# Readme\n')
    } finally {
      cleanup()
    }
  })

  it('leaves legit paths unaffected and records the normalized path', async () => {
    const [fix, diff] = captureTools([registerFixTool, registerDiffTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject({
      'iterate.config.yaml': config,
      'README.md': '# Readme\n',
      'src/app.ts': ORIGINAL,
    })
    try {
      // A non-protected file still fixes fine under the same config…
      const res = (await fix({
        file: './src/app.ts',
        content: FIXED,
        finding: finding({ file: './src/app.ts' }),
        round: 1,
        path: dir,
      })) as Record<string, unknown>
      assert.equal(res.ok, true, String(res.error))
      assert.equal(res.file, 'src/app.ts')
      // …and the persisted record uses the normalized path, so later lookups
      // with the canonical form find it.
      const record = readRegistry(dir).rounds[0]!.records[0]!
      assert.equal(record.finding.file, 'src/app.ts')
      const diffRes = (await diff({ file: 'src/app.ts', path: dir })) as Record<string, unknown>
      assert.equal(diffRes.ok, true, String(diffRes.error))
    } finally {
      cleanup()
    }
  })
})

describe('iterate_rollback LIFO guard', () => {
  const V2 = 'function greet(name) {\n  if (!name) return "ANON"\n  return String(name).toUpperCase()\n}\n'

  it('refuses to roll back fix #1 while fix #2 on the same file exists, then unwinds in order', async () => {
    const [fix, rollback] = captureTools([registerFixTool, registerRollbackTool]) as [Tool, Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      const f1 = (await fix({ file: 'src/app.ts', content: FIXED, finding: finding({ summary: 'First issue' }), round: 1, path: dir })) as Record<string, unknown>
      const f2 = (await fix({ file: 'src/app.ts', content: V2, finding: finding({ summary: 'Second issue' }), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(f1.ok, true, String(f1.error))
      assert.equal(f2.ok, true, String(f2.error))
      const id1 = String(f1.id)
      const id2 = String(f2.id)

      // Rolling back #1 would destroy #2's write while #2's record stays
      // success:true — refuse and name the clobbered id.
      const refused = (await rollback({ id: id1, path: dir })) as Record<string, unknown>
      assert.equal(refused.ok, false)
      assert.match(String(refused.error), /LIFO/)
      assert.ok(String(refused.error).includes(id2), `error must name clobbered id ${id2}: ${refused.error}`)
      // Nothing changed: file, registry, and both records are intact.
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), V2)
      assert.equal(readRegistry(dir).rounds[0]!.records.length, 2)

      // LIFO: newest first succeeds…
      const rb2 = (await rollback({ id: id2, path: dir })) as Record<string, unknown>
      assert.equal(rb2.ok, true, String(rb2.error))
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), FIXED)
      // …and now the older one is safe to roll back.
      const rb1 = (await rollback({ id: id1, path: dir })) as Record<string, unknown>
      assert.equal(rb1.ok, true, String(rb1.error))
      assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), ORIGINAL)
      assert.deepEqual(readRegistry(dir), { rounds: [] })
    } finally {
      cleanup()
    }
  })
})

describe('backupPath containment (tampered registry)', () => {
  it('iterate_diff refuses backup paths outside the fixes dir (relative + absolute)', async () => {
    const [fix, diff] = captureTools([registerFixTool, registerDiffTool]) as [Tool, Tool]
    const outside = mkdtempSync(join(tmpdir(), 'iterate-fix-outside-'))
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-CONTENTS', 'utf-8')
      const fixed = (await fix({ file: 'src/app.ts', content: FIXED, finding: finding(), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(fixed.ok, true)
      const regPath = join(fixesDir(dir), 'registry.json')

      for (const evil of ['../../etc/passwd', join(outside, 'secret.txt')]) {
        const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
        reg.rounds[0].records[0].backupPath = evil
        writeFileSync(regPath, JSON.stringify(reg), 'utf-8')
        const res = (await diff({ file: 'src/app.ts', path: dir })) as Record<string, unknown>
        assert.equal(res.ok, false, `must refuse ${evil}`)
        assert.match(String(res.error), /escapes the fixes directory/)
        // The outside content was never read into the response.
        assert.ok(!JSON.stringify(res).includes('TOP-SECRET-CONTENTS'))
        assert.equal(res.diff, undefined)
      }
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('iterate_rollback refuses a tampered backupPath and writes nothing', async () => {
    const [fix, rollback] = captureTools([registerFixTool, registerRollbackTool]) as [Tool, Tool]
    const outside = mkdtempSync(join(tmpdir(), 'iterate-fix-outside-'))
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      writeFileSync(join(outside, 'evil.txt'), 'EVIL-PAYLOAD', 'utf-8')
      const fixed = (await fix({ file: 'src/app.ts', content: FIXED, finding: finding(), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(fixed.ok, true)
      const regPath = join(fixesDir(dir), 'registry.json')
      const id = String(fixed.id)

      for (const evil of ['../../etc/passwd', join(outside, 'evil.txt')]) {
        const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
        reg.rounds[0].records[0].backupPath = evil
        writeFileSync(regPath, JSON.stringify(reg), 'utf-8')
        const res = (await rollback({ id, path: dir })) as Record<string, unknown>
        assert.equal(res.ok, false, `must refuse ${evil}`)
        assert.match(String(res.error), /escapes the fixes directory/)
        // The project file still holds the fixed content (no injection) and
        // the outside file is untouched (nothing was consumed/overwritten).
        assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8'), FIXED)
        assert.equal(readFileSync(join(outside, 'evil.txt'), 'utf-8'), 'EVIL-PAYLOAD')
        // The record survives so a legitimate rollback stays possible after repair.
        assert.equal(readRegistry(dir).rounds[0]!.records.length, 1)
      }
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('fix-registry cross-process lock', () => {
  it('uses a valid lock name and leaves no lock file behind after fixes', async () => {
    const [fix] = captureTools([registerFixTool]) as [Tool]
    const { dir, cleanup } = tempProject({ 'src/app.ts': ORIGINAL })
    try {
      // The lock name must satisfy acquireProjectLock's strict validation
      // (an invalid name would throw here).
      const release = acquireProjectLock(dir, 'fix-registry')
      const lockPath = join(dir, '.iterate', '.fix-registry.lock')
      assert.equal(existsSync(lockPath), true)
      assert.equal(readFileSync(lockPath, 'utf-8').trim(), String(process.pid))
      release()
      assert.equal(existsSync(lockPath), false)

      // Sequential behavior is unchanged under the lock: two distinct fixes
      // both persist their records, and the lock is always released.
      const v1 = 'function greet(name) {\n  if (!name) return "ANON"\n  return name.toUpperCase()\n}\n'
      const v2 = 'function greet(name) {\n  if (!name) return "ANON"\n  return String(name).toUpperCase()\n}\n'
      const f1 = (await fix({ file: 'src/app.ts', content: v1, finding: finding({ summary: 'First issue' }), round: 1, path: dir })) as Record<string, unknown>
      const f2 = (await fix({ file: 'src/app.ts', content: v2, finding: finding({ summary: 'Second issue' }), round: 1, path: dir })) as Record<string, unknown>
      assert.equal(f1.ok, true, String(f1.error))
      assert.equal(f2.ok, true, String(f2.error))
      assert.equal(readRegistry(dir).rounds[0]!.records.length, 2)
      assert.equal(existsSync(lockPath), false)
    } finally {
      cleanup()
    }
  })
})

// ─── decision log structural validation ──────────────────────────────────────

describe('readDecisionLogDetailed structural validation', () => {
  it('counts structurally-broken (non-object / missing fields) lines as invalid', () => {
    const { dir, cleanup } = tempProject()
    try {
      const good = JSON.stringify({
        timestamp: '2026-09-13T00:00:00.000Z',
        round: 1,
        type: 'atomic_fix',
        data: { id: 'fix-x' },
      })
      const badShape = JSON.stringify({ foo: 'bar' }) // object but no timestamp/type
      const notObject = JSON.stringify([1, 2, 3]) // valid JSON, not an object
      const broken = '{ not json'
      const logDir = join(dir, '.iterate')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'decision-log.jsonl'), [good, badShape, notObject, broken, ''].join('\n'), 'utf-8')
      const detail = readDecisionLogDetailed(realpathSync(dir))
      assert.equal(detail.entries.length, 1)
      assert.equal(detail.entries[0]!.type, 'atomic_fix')
      // 3 structurally invalid lines: badShape, notObject, broken.
      assert.equal(detail.invalidLines, 3)
      // readDecisionEntries keeps only the well-formed entry.
      assert.equal(readDecisionEntries(realpathSync(dir)).length, 1)
    } finally {
      cleanup()
    }
  })

  it('still accepts legacy entries that only carry timestamp + type', () => {
    const { dir, cleanup } = tempProject()
    try {
      const legacy = JSON.stringify({ timestamp: '2026-09-13T00:00:00.000Z', round: 2, type: 'decision' })
      const logDir = join(dir, '.iterate')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'decision-log.jsonl'), legacy + '\n', 'utf-8')
      const detail = readDecisionLogDetailed(realpathSync(dir))
      assert.equal(detail.entries.length, 1)
      assert.equal(detail.invalidLines, 0)
    } finally {
      cleanup()
    }
  })
})

describe('globMatch', () => {
  it('matches literal paths and * within a segment', () => {
    assert.equal(globMatch('src/a.ts', 'src/a.ts'), true)
    assert.equal(globMatch('src/a.ts', 'src/*.ts'), true)
    assert.equal(globMatch('src/a.ts', 'src/*.js'), false)
    assert.equal(globMatch('src/deep/a.ts', 'src/*.ts'), false)
  })
  it('matches ** across separators', () => {
    assert.equal(globMatch('src/deep/a.ts', 'src/**/*.ts'), true)
    // ** requires at least one segment (standard glob semantics)
    assert.equal(globMatch('src/a.ts', 'src/**/*.ts'), false)
    assert.equal(globMatch('src/deep/a.ts', '**/a.ts'), true)
  })
  it('escapes regex specials literally', () => {
    assert.equal(globMatch('a.b.ts', 'a.b.ts'), true)
    assert.equal(globMatch('a.b.ts', 'aXb.ts'), false)
  })
  it('rejects non-string inputs', () => {
    assert.equal(globMatch('a', 'a'), true)
    assert.equal(globMatch('a', ''), false)
    assert.equal(globMatch(undefined as unknown as string, 'x'), false)
    assert.equal(globMatch('x', undefined as unknown as string), false)
  })
})
