import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertExperience, removeExperience, writeExperienceBank, readExperienceBank, searchExperienceEntries } from '../src/tools/experience-store.ts'
import type { ExperienceEntryInput } from '../src/tools/experience-store.ts'
import type { ExperienceBank } from '../src/types.ts'

const emptyBank = (): ExperienceBank => ({
  entries: [],
  lastUpdated: '2026-01-01T00:00:00.000Z',
  totalHits: 0,
})

const input = (over: Record<string, unknown> = {}): ExperienceEntryInput => ({
  pattern: 'missing null check',
  dimension: 'correctness',
  description: 'guard the value before use',
  verifiedFix: 'add an early null guard',
  files: ['src/a.ts'],
  tags: ['null'],
  findingSummary: 'Nullable dereference',
  severity: 'high',
  ...over,
})

describe('upsertExperience', () => {
  it('adds a fresh entry with hitCount 1 and a created timestamp', () => {
    const { bank, added, entryId } = upsertExperience(emptyBank(), input())
    assert.equal(added, true)
    assert.equal(bank.entries.length, 1)
    assert.equal(bank.totalHits, 1)
    const entry = bank.entries[0]!
    assert.equal(entry.id, entryId)
    assert.equal(entry.hitCount, 1)
    assert.ok(entry.timestamp)
    assert.ok(entry.lastHitAt)
  })

  it('re-adding the same pattern+dimension is a HIT, not a duplicate', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const firstId = bank.entries[0]!.id

    const second = upsertExperience(bank, input({ description: 'a newer description' }))
    assert.equal(second.added, false)
    assert.equal(second.bank.entries.length, 1)
    assert.equal(second.bank.totalHits, 2)
    assert.equal(second.bank.entries[0]!.id, firstId)
    assert.equal(second.bank.entries[0]!.hitCount, 2)
    // A hit refreshes hit metadata only — it does not overwrite the stored entry.
    assert.equal(second.bank.entries[0]!.description, 'guard the value before use')
  })

  it('same pattern but a different dimension creates a separate entry', () => {
    const { bank } = upsertExperience(emptyBank(), input({ dimension: 'correctness' }))
    const second = upsertExperience(bank, input({ dimension: 'security' }))
    assert.equal(second.added, true)
    assert.equal(second.bank.entries.length, 2)
  })

  it('updates a specific entry by explicit id', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const id = bank.entries[0]!.id
    const hit = upsertExperience(bank, { ...input(), id })
    assert.equal(hit.added, false)
    assert.equal(hit.bank.entries.length, 1)
    assert.equal(hit.bank.totalHits, 2)
  })

  it('an explicit-id update replaces the editable fields (documented contract)', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const id = bank.entries[0]!.id
    const updated = upsertExperience(bank, {
      ...input({ description: 'a newer, better description', verifiedFix: 'a deeper fix', severity: 'critical' }),
      id,
    })
    assert.equal(updated.added, false)
    const entry = updated.bank.entries[0]!
    assert.equal(entry.id, id)
    assert.equal(entry.description, 'a newer, better description')
    assert.equal(entry.verifiedFix, 'a deeper fix')
    assert.equal(entry.severity, 'critical')
    assert.equal(entry.hitCount, 2) // update also counts as a hit
  })

  it('forged hit metadata never wins on a fresh add', () => {
    const { bank, added } = upsertExperience(emptyBank(), {
      ...input({ id: 'fresh', timestamp: '2000-01-01T00:00:00.000Z', hitCount: 999, lastHitAt: '2000-01-01T00:00:00.000Z' }),
    } as never)
    // A caller-supplied id on a brand-new entry is the documented
    // "update a specific entry via add" contract and is honored — but the
    // store-owned hit metadata always wins.
    assert.equal(added, true)
    const entry = bank.entries[0]!
    assert.equal(entry.id, 'fresh')
    assert.notEqual(entry.timestamp, '2000-01-01T00:00:00.000Z')
    assert.equal(entry.hitCount, 1)
    assert.notEqual(entry.lastHitAt, '2000-01-01T00:00:00.000Z')
  })

  it('never mutates the input bank', () => {
    const bank = emptyBank()
    const before = JSON.stringify(bank)
    const first = upsertExperience(bank, input())
    assert.equal(JSON.stringify(bank), before)
    upsertExperience(first.bank, input())
    assert.equal(JSON.stringify(bank), before)
  })

  it('guards against malformed totals (undefined hitCount / totalHits)', () => {
    const bank = {
      entries: [{
        id: 'e1',
        timestamp: 't',
        dimension: 'd',
        pattern: 'p',
        description: 'd',
        verifiedFix: 'f',
        files: [],
        tags: [],
        findingSummary: 's',
        severity: 'low',
      }] as never,
      totalHits: undefined as never,
      lastUpdated: 'x',
    }
    const { bank: next, added } = upsertExperience(bank, { ...input(), id: 'e1' })
    assert.equal(added, false)
    assert.equal(next.entries[0]!.hitCount, 1)
    assert.equal(next.totalHits, 1)
  })
})

describe('removeExperience', () => {
  it('removes a matching entry by id and updates lastUpdated', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const id = bank.entries[0]!.id
    const stale = { ...bank, lastUpdated: '2026-01-01T00:00:00.000Z' }
    const result = removeExperience(stale, id)
    assert.equal(result.removed, true)
    assert.equal(result.bank.entries.length, 0)
    assert.equal(result.bank.totalHits, 1) // hit count is retained history
    assert.notEqual(result.bank.lastUpdated, stale.lastUpdated)
  })

  it('is a no-op for an unknown id, keeping the bank untouched', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const before = JSON.stringify(bank)
    const result = removeExperience(bank, 'does-not-exist')
    assert.equal(result.removed, false)
    assert.equal(JSON.stringify(result.bank), before)
  })

  it('removes only the targeted entry, leaving siblings intact', () => {
    const { bank } = upsertExperience(emptyBank(), input({ dimension: 'correctness' }))
    const second = upsertExperience(bank, input({ dimension: 'security' }))
    const keep = second.bank.entries[1]!
    const result = removeExperience(second.bank, second.bank.entries[0]!.id)
    assert.equal(result.removed, true)
    assert.equal(result.bank.entries.length, 1)
    assert.equal(result.bank.entries[0]!.id, keep.id)
  })

  it('never mutates the input bank', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const before = JSON.stringify(bank)
    removeExperience(bank, bank.entries[0]!.id)
    assert.equal(JSON.stringify(bank), before)
  })

  it('rejects empty or non-string ids as a no-op', () => {
    const { bank } = upsertExperience(emptyBank(), input())
    const before = JSON.stringify(bank)
    assert.equal(removeExperience(bank, '').removed, false)
    assert.equal(removeExperience(bank, (undefined as unknown) as string).removed, false)
    assert.equal(JSON.stringify(bank), before)
  })
})

describe('writeExperienceBank', () => {
  it('persists a bank and reports ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-exp-store-'))
    try {
      const { bank } = upsertExperience(emptyBank(), input())
      assert.deepEqual(writeExperienceBank(dir, bank), { ok: true })
      assert.equal(existsSync(join(dir, '.iterate', 'experience.json')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a write failure instead of reporting false success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-exp-store-'))
    try {
      // `.iterate` exists as a plain FILE — the write below it must fail.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = writeExperienceBank(dir, emptyBank())
      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /experience\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readExperienceBank normalization', () => {
  it('normalizes a hand-edited bank so entries always carry arrays + numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-exp-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'experience.json'), JSON.stringify({
        lastUpdated: 't',
        totalHits: 'bogus',
        entries: [
          // Well-formed entry: survives unchanged (aside from type coercion).
          { id: 'e1', timestamp: 't', dimension: 'security', pattern: 'p1', description: 'd', verifiedFix: 'f', files: ['a.ts'], hitCount: 2, tags: [], findingSummary: 's', severity: 'high' },
          // Missing files/tags/hitCount — previously the render's `.join(', ')`
          // and search's spread would throw a TypeError.
          { id: 'e2', dimension: 'correctness', pattern: 'p2', description: 'd2', verifiedFix: 'f2', findingSummary: 's2', severity: 'bogus' },
          // Non-object junk is dropped.
          42,
        ],
      }), 'utf-8')
      const bank = readExperienceBank(dir)
      assert.equal(bank.entries.length, 2)
      assert.equal(bank.totalHits, 0) // non-numeric totalHits → 0
      for (const e of bank.entries) {
        assert.ok(Array.isArray(e.files))
        assert.ok(Array.isArray(e.tags))
        assert.equal(typeof e.hitCount, 'number')
        assert.equal(Number.isNaN(e.hitCount), false)
      }
      const e2 = bank.entries[1]!
      assert.deepEqual(e2.files, [])
      assert.deepEqual(e2.tags, [])
      assert.equal(e2.severity, 'low') // unknown severity normalizes to low
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('searchExperienceEntries never throws on malformed in-memory entries', () => {
    const entries = [
      { pattern: 'p', dimension: 'd', description: 'desc', verifiedFix: 'f', findingSummary: 's' },
    ] as never
    // No files/tags fields on the entry — spread/search would previously throw.
    const found = searchExperienceEntries(entries, 'desc')
    assert.equal(found.length, 1)
    // A query matching a field still works when the arrays are absent.
    const noMatch = searchExperienceEntries(entries, 'no-such-term')
    assert.equal(noMatch.length, 0)
    // Non-object entries are skipped, not fatal.
    const mixed = searchExperienceEntries([42, null, entries[0]] as never, 'p')
    assert.equal(mixed.length, 1)
    // Tag filter with missing tags array does not throw.
    assert.equal(searchExperienceEntries(entries, '', { tags: ['x'] }).length, 0)
  })

  it('derives a DETERMINISTIC id for hand-edited entries missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-exp-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const write = (entries: unknown[]) =>
        writeFileSync(join(dir, '.iterate', 'experience.json'), JSON.stringify({ entries }), 'utf-8')
      const raw = [
        { dimension: 'correctness', pattern: 'p3', description: 'd3', verifiedFix: 'f3', findingSummary: 's3' },
        { dimension: 'security', pattern: 'p4', description: 'd4', verifiedFix: 'f4', findingSummary: 's4' },
      ]
      write(raw)
      const first = readExperienceBank(dir)
      // Missing ids were derived — deterministic and unique.
      assert.match(first.entries[0]!.id, /^exp-/)
      assert.notEqual(first.entries[0]!.id, first.entries[1]!.id)
      // A second read produces the SAME ids (no random churn on every read).
      const second = readExperienceBank(dir)
      assert.equal(second.entries[0]!.id, first.entries[0]!.id)
      assert.equal(second.entries[1]!.id, first.entries[1]!.id)
      // The in-memory upsert is a pure merge — nothing touched the file yet.
      const { bank, added } = upsertExperience(second, input())
      assert.equal(added, true)
      assert.equal(bank.entries.length, 3) // 2 on disk + 1 new in memory
      writeExperienceBank(dir, bank)
      const fourth = readExperienceBank(dir)
      assert.equal(fourth.entries.length, 3)
      // The originally hand-edited entries keep their derived ids across a
      // persist cycle (and the new entry carries its own stable id).
      const byIdStable = second.entries.every((e, i) => e.id === fourth.entries[i]!.id)
      assert.equal(byIdStable, true)
      assert.match(fourth.entries[2]!.id, /^exp-/)
      assert.notEqual(fourth.entries[2]!.id, second.entries[0]!.id)
      assert.notEqual(fourth.entries[2]!.id, second.entries[1]!.id)
      // Re-reading the persisted bank stays fully deterministic.
      const fifth = readExperienceBank(dir)
      assert.equal(fifth.entries[0]!.id, second.entries[0]!.id)
      assert.equal(fifth.entries[2]!.id, fourth.entries[2]!.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})