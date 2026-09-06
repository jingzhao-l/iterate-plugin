import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertExperience, writeExperienceBank } from '../src/tools/experience-store.ts'
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