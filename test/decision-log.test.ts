/**
 * test/decision-log.test.ts — the ledger's write path is the kernel's hash chain.
 *
 * Every guard here is written to be ABLE TO FAIL: the chain is re-computed from the
 * file's own bytes with `node:crypto` (not with the kernel helper that produced them),
 * the refusals assert the bytes on disk did not change, and the migration asserts the
 * backup's mode and content. A test that only re-reads what the writer claimed would
 * prove nothing, so the hash of the previous LINE is the oracle.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  acquireLogLock,
  acquireLogLockChecked,
  registerDecisionLogTool,
  appendDecisionEntry,
  invalidateLogCountCache,
  readDecisionEntries,
  readDecisionLogDetailed,
  recountEntries,
  LOG_COUNT_CACHE_CAP,
  logCountCacheSize,
  DECISION_KIND_PATTERN,
  DECISION_LOG_ERROR_CODES,
  isDecisionKind,
  classifyDecisionLine,
  projectDecisionRecord,
  contestedLedgerLine,
  decisionLogContestedLine,
  archiveContestedDecisionLog,
  decisionLogPath,
  timestampMs,
  verifyDecisionLedger,
} from '../src/tools/decision-log.ts'
import { DECISION_KIND_PATTERN as KERNEL_PATTERN } from 'iterate-kernel/decision-log-entry'
import {
  buildDecisionLogEntry,
  newDecisionEntryId,
  serializeDecisionLogEntry,
} from 'iterate-kernel/decision-log'
import { writeTextAtomic } from '../src/atomic-fs.ts'

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-decision-log-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The ledger file for a temp project (created by the first append). */
const logOf = (dir: string): string => join(dir, '.iterate', 'decision-log.jsonl')

/** Non-empty lines of a ledger, exactly as written. */
const linesOf = (dir: string): string[] =>
  readFileSync(logOf(dir), 'utf-8').split('\n').filter((l) => l.trim().length > 0)

function captureDecisionLogTool(): { execute: (args: unknown) => Promise<Record<string, unknown>> } {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerDecisionLogTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_decision_log was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: async (args) => (await def!.execute(args, exec as never)) as Record<string, unknown>,
  }
}

/** A legacy record line — the pre-flip shape: {timestamp, round, type, data}. */
function legacyLine(ts: string, round: number, type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts, round, type, data })
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex')

// ─── The write path: kernel chain, ledger-supplied ───────────────────────────

describe('appendDecisionEntry writes the kernel hash chain', () => {
  it('makes each line its own canonical form and chains it to the PREVIOUS LINE\'S BYTES', () => {
    const { dir, cleanup } = tempProject()
    try {
      const first = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { note: 'one' },
      })
      assert.equal(first.error, undefined, String(first.error))
      assert.equal(first.count, 1)
      const second = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'validation', data: { ok: true },
      })
      assert.equal(second.error, undefined, String(second.error))
      assert.equal(second.count, 2)

      const lines = linesOf(dir)
      assert.equal(lines.length, 2)
      const e1 = JSON.parse(lines[0]!) as Record<string, unknown>
      const e2 = JSON.parse(lines[1]!) as Record<string, unknown>

      // Genesis: empty prev hash, sequence 0.
      assert.equal(e1['prevEntryHash'], '', 'the genesis entry carries an EMPTY prevEntryHash')
      assert.equal(e1['sequence'], 0)
      assert.equal(e2['sequence'], 1, 'sequence is ledger-owned and strictly +1')

      // THE ORACLE, recomputed here and not from the writer: line 2's prevEntryHash is
      // sha256 over line 1's bytes as they sit on disk. If the writer had emitted
      // non-canonical bytes (or hashed something else), this is where it shows.
      assert.equal(e2['prevEntryHash'], sha256Hex(lines[0]!))

      // The line's bytes ARE the entry's canonical form: re-serializing the parsed line
      // reproduces it exactly. That is the only proof that does not trust the writer —
      // it means `sha256(line)` is what the NEXT line must carry, recomputable by anybody.
      assert.equal(
        serializeDecisionLogEntry(JSON.parse(lines[0]!) as never),
        lines[0],
        'line 1 is its own canonical form',
      )
      assert.equal(
        serializeDecisionLogEntry(JSON.parse(lines[1]!) as never),
        lines[1],
        're-serializing the stored line reproduces its bytes (so its digest is re-computable)',
      )
      assert.deepEqual(
        Object.keys(e1),
        [...Object.keys(e1)].sort(),
        'canonical JSON sorts its keys',
      )

      // Field mapping: type→kind, data→payload in full, timestamp→createdAt.
      assert.equal(e2['kind'], 'validation')
      assert.deepEqual(e2['payload'], { ok: true })
      assert.equal(e2['createdAt'], '2026-01-01T00:00:01.000Z')
      // outcome is READ from the record, never invented from tone: `{ok:true}` says
      // nothing the kernel recognises, so it is `inconclusive` and NOT a silent pass.
      assert.equal(e2['outcome'], 'inconclusive')
      assert.equal(e1['outcome'], 'inconclusive')
      // summary is the record's label when it carries no sentence of its own.
      assert.equal(e2['summary'], 'validation (round 2)')
      // entryId is ULID-shaped and TIME-ORDERED from the record's own timestamp.
      assert.match(String(e1['entryId']), /^dl_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.ok(String(e1['entryId']) < String(e2['entryId']), 'ids sort with their instants')
      assert.equal(verifyDecisionLedger(dir).ok, true)
    } finally {
      cleanup()
    }
  })

  it('reads a verdict the record actually states (outcome is read, not inferred)', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'validation', data: { passed: true } })
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:01.000Z', round: 1, type: 'validation', data: { status: 'blocked' } })
      const [a, b] = linesOf(dir).map((l) => JSON.parse(l) as Record<string, unknown>)
      assert.equal(a!['outcome'], 'pass', 'data.passed === true is a recorded verdict')
      assert.equal(b!['outcome'], 'blocked', 'data.status carries an outcome verbatim')
      assert.equal(verifyDecisionLedger(dir).ok, true)
    } finally {
      cleanup()
    }
  })

  it('writes an OPTIONAL field ABSENT from the bytes, never as null', () => {
    // Rule 7/8 of the kernel transcription, proven on THIS write path: a field the record
    // does not state must not appear in the canonical line at all. A `"dimension":null`
    // would change the line's bytes — hence its digest — for the same decision, so the two
    // ecosystems would migrate one history two different ways.
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { note: ' unstated ' },
      })
      const opId = `op_${'A'.repeat(26)}`
      appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision',
        data: { dimension: 'security', operationId: opId },
      })
      // A payload `dimension` that is not a kernel dimension id stays ABSENT at entry level.
      appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:02.000Z', round: 3, type: 'decision', data: { dimension: 'Not a dimension id' },
      })
      const lines = linesOf(dir)
      const [bare, stated, refused] = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      assert.equal(Object.hasOwn(bare!, 'dimension'), false, 'dimension is absent, not null')
      assert.equal(Object.hasOwn(bare!, 'operationId'), false, 'operationId is absent, not null')
      assert.equal(lines[0]!.includes('null'), false, 'no null literal in the genesis line')
      assert.equal(stated!['dimension'], 'security', 'a stated dimension is carried verbatim')
      assert.equal(stated!['operationId'], opId)
      assert.equal(Object.hasOwn(refused!, 'dimension'), false, 'rule 7: a non-dimension id is absent, not guessed')
      assert.deepEqual(refused!['payload'], { dimension: 'Not a dimension id' }, 'payload still keeps it in full')
      assert.equal(verifyDecisionLedger(dir).ok, true)
    } finally {
      cleanup()
    }
  })

  it('lets the LEDGER own the chain fields: a caller cannot choose them', () => {
    const { dir, cleanup } = tempProject()
    try {
      const release = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {},
      })
      assert.equal(release.error, undefined)
      const line = JSON.parse(linesOf(dir)[0]!) as Record<string, unknown>
      assert.equal(line['sequence'], 0, 'the ledger assigned sequence; the caller never could')
      assert.equal(Object.hasOwn(line, 'prevEntryHash'), true)

      // PROOF it is not merely unused: a draft that TRIES to bring its own chain fields is
      // refused by the kernel's strict draft schema, so no caller of this API can forge a
      // sequence number or a link even if it wanted to.
      assert.throws(
        () => buildDecisionLogEntry({
          entryId: newDecisionEntryId(1), summary: 's', outcome: 'pass',
          createdAt: '2026-01-01T00:00:00.000Z', kind: 'decision', payload: {},
          sequence: 99, prevEntryHash: 'a'.repeat(64),
        } as never, { sequence: 0, prevEntryHash: '' }),
        (err: unknown) => /sequence|prevEntryHash|must not be sent|Unrecognized/i.test(String(err)),
      )
    } finally {
      cleanup()
    }
  })

  it('reports a damaged tail instead of building on it (interleaving detection)', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} })
      // A perfectly well-formed entry that does NOT link — exactly what a second
      // writer interleaving into the same file produces.
      const forged = buildDecisionLogEntry(
        {
          entryId: newDecisionEntryId(Date.parse('2026-01-01T00:00:01.000Z')),
          summary: 'not contiguous',
          outcome: 'inconclusive',
          createdAt: '2026-01-01T00:00:01.000Z',
          kind: 'decision',
          payload: {},
        },
        { sequence: 1, prevEntryHash: 'f'.repeat(64) },
      )
      appendFileSync(logOf(dir), `${serializeDecisionLogEntry(forged)}\n`, 'utf-8')
      const before = readFileSync(logOf(dir), 'utf-8')

      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:02.000Z', round: 2, type: 'decision', data: {},
      })
      assert.equal(res.count, 0)
      assert.equal(res.code, 'KERNEL_E_DECISION_LOG_CHAIN')
      assert.match(String(res.error), /line 2/)
      assert.match(String(res.remedy), /preserve/i)
      assert.equal(readFileSync(logOf(dir), 'utf-8'), before, 'a refusal appends NOTHING')
    } finally {
      cleanup()
    }
  })
})

// ─── Readers: the projection ────────────────────────────────────────────────

describe('readDecisionLogDetailed projects both shapes', () => {
  it('reads a legacy log with EXACTLY the pre-flip expectations', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(
        logOf(dir),
        [
          legacyLine('2026-01-01T00:00:00.000Z', 1, 'round_start', { goal: 'x' }),
          legacyLine('2026-01-01T00:00:01.000Z', 2, 'review_result', { findings: [{ file: 'a.ts' }] }),
          '',
        ].join('\n'),
        'utf-8',
      )
      const read = readDecisionLogDetailed(dir)
      assert.equal(read.invalidLines, 0)
      assert.deepEqual(read.entries, [
        { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'round_start', data: { goal: 'x' } },
        { timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'review_result', data: { findings: [{ file: 'a.ts' }] } },
      ])
    } finally {
      cleanup()
    }
  })

  it('projects a canonical line back to the record view the flip wrote it from', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 3, type: 'report', data: { findings: [{ file: 'b.ts', severity: 'high' }] },
      })
      const read = readDecisionLogDetailed(dir)
      assert.equal(read.invalidLines, 0)
      assert.deepEqual(read.entries, [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          round: 3,
          type: 'report',
          // payload is `data` copied IN FULL (rule 3), so a report reads the same list
          // it read before the flip.
          data: { findings: [{ file: 'b.ts', severity: 'high' }] },
        },
      ])
      assert.notEqual(readFileSync(logOf(dir), 'utf-8').includes('"data"'), true, 'the disk shape changed, the read shape did not')
    } finally {
      cleanup()
    }
  })

  it('skips a corrupt line and counts it — never fatal, never silent', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(
        logOf(dir),
        [
          legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', {}),
          '{"half":"writ',
          '{"unrecognised":"shape"}',
          'null',
          '',
        ].join('\n'),
        'utf-8',
      )
      const read = readDecisionLogDetailed(dir)
      assert.equal(read.entries.length, 1)
      assert.equal(read.invalidLines, 3, 'every skipped line is counted')
      assert.equal(readDecisionEntries(dir).length, 1)
    } finally {
      cleanup()
    }
  })

  it('reads a legacy record that follows the chain (the reader is tolerant; the writer is not)', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { a: 1 } })
      appendFileSync(logOf(dir), `${legacyLine('2026-01-01T00:00:01.000Z', 2, 'resume', { b: 2 })}\n`, 'utf-8')
      const read = readDecisionLogDetailed(dir)
      assert.equal(read.invalidLines, 0, 'a legacy record is a readable shape, not corruption')
      assert.deepEqual(read.entries.map((e) => e.type), ['decision', 'resume'])
    } finally {
      cleanup()
    }
  })
})

// ─── Classification helpers ─────────────────────────────────────────────────

describe('classifyDecisionLine', () => {
  it('separates legacy, canonical and neither by SHAPE', () => {
    assert.equal(classifyDecisionLine(JSON.parse(legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', {}))), 'legacy')
    const canonical = JSON.parse(
      serializeDecisionLogEntry(buildDecisionLogEntry({
        entryId: newDecisionEntryId(1), summary: 's', outcome: 'pass',
        createdAt: '2026-01-01T00:00:00.000Z', kind: 'decision', payload: {},
      }, { sequence: 0, prevEntryHash: '' })),
    )
    assert.equal(classifyDecisionLine(canonical), 'canonical')
    assert.equal(classifyDecisionLine({ something: 'else' }), 'unknown')
    assert.equal(classifyDecisionLine(null), 'unknown')
    assert.equal(classifyDecisionLine([]), 'unknown')
    assert.equal(classifyDecisionLine({}), 'unknown')
    // A canonical entry that also carries a timestamp is NOT mistaken for a record.
    assert.equal(classifyDecisionLine({ ...canonical, timestamp: 'x' }), 'canonical')
  })

  it('projects null for an unknown shape and copies payload/data by value', () => {
    assert.equal(projectDecisionRecord({ nope: 1 }), null)
    const legacy = JSON.parse(legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', { nested: { n: 1 } }))
    const view = projectDecisionRecord(legacy)
    assert.deepEqual(view?.data, { nested: { n: 1 } })
    assert.notEqual(projectDecisionRecord(legacy)?.data, legacy.data, 'the projection does not alias the parsed line')
  })
})

// ─── Migration ──────────────────────────────────────────────────────────────

describe('a pre-flip legacy log migrates on the next write', () => {
  it('keeps each record\'s OWN timestamp, verifies before swapping, leaves a 0600 backup', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const original = [
        legacyLine('2025-11-02T09:00:00.000Z', 1, 'round_start', { goal: 'ship' }),
        legacyLine('2025-12-31T23:59:59.500+02:00', 2, 'review_result', { findings: [{ file: 'c.ts' }] }),
        legacyLine('2026-01-05T00:00:00.000Z', 3, 'report', { summary: 'clean' }),
        '',
      ].join('\n')
      writeFileSync(logOf(dir), original, 'utf-8')
      const beforeBytes = readFileSync(logOf(dir))

      const res = appendDecisionEntry(dir, {
        timestamp: '2026-02-01T00:00:00.000Z', round: 4, type: 'decision', data: { after: 'migration' },
      })
      assert.equal(res.error, undefined, String(res.error))
      assert.equal(res.count, 4, 'three migrated records + this append')

      const lines = linesOf(dir)
      assert.equal(lines.length, 4)
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      // EVERY line is canonical now, and the chain recomputes from the bytes.
      assert.equal(entries[0]!['prevEntryHash'], '')
      for (let i = 1; i < entries.length; i++) {
        assert.equal(entries[i]!['sequence'], i)
        assert.equal(entries[i]!['prevEntryHash'], sha256Hex(lines[i - 1]!))
      }
      // Each migrated entry keeps the RECORD'S OWN instant — not the migration's clock.
      assert.equal(entries[0]!['createdAt'], '2025-11-02T09:00:00.000Z')
      assert.equal(entries[0]!['kind'], 'round_start')
      assert.deepEqual((entries[1]!['payload'] as Record<string, unknown>)['findings'], [{ file: 'c.ts' }])
      // …normalised to UTC milliseconds, so the two shells date it identically.
      assert.equal(entries[1]!['createdAt'], '2025-12-31T21:59:59.500Z')
      assert.equal(entries[3]!['createdAt'], '2026-02-01T00:00:00.000Z')

      // The backup holds the ORIGINAL BYTES, at 0600, and is named for what it is.
      const backups = readdirSync(join(dir, '.iterate')).filter((n) => n.includes('.pre-ledger-'))
      assert.equal(backups.length, 1, 'exactly one backup of the pre-flip file')
      const backupPath = join(dir, '.iterate', backups[0]!)
      assert.equal(backups[0]!.endsWith('.jsonl.bak'), true)
      assert.equal(readFileSync(backupPath, 'utf-8'), original)
      assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'the backup is owner-only')
      assert.equal(beforeBytes.equals(readFileSync(backupPath)), true, 'the backup IS the file as it was')
      assert.equal(verifyDecisionLedger(dir).ok, true, 'the swapped-in chain verifies')
      // No migrating temp survived the swap.
      assert.equal(readdirSync(join(dir, '.iterate')).some((n) => n.includes('.migrating-')), false)
    } finally {
      cleanup()
    }
  })

  it('refuses an undatable record with ZERO bytes changed and no backup', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const original = [
        legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', {}),
        legacyLine('not-a-timestamp', 2, 'decision', {}),
        '',
      ].join('\n')
      writeFileSync(logOf(dir), original, 'utf-8')
      const before = readFileSync(logOf(dir), 'utf-8')

      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-02T00:00:00.000Z', round: 3, type: 'decision', data: {},
      })
      assert.equal(res.count, 0)
      assert.equal(res.code, DECISION_LOG_ERROR_CODES.migration)
      assert.match(String(res.error), /line 2/)
      assert.match(String(res.remedy), /explicit zone|ISO-8601/)
      assert.equal(readFileSync(logOf(dir), 'utf-8'), before, 'the refuse path changed NO bytes')
      assert.equal(
        readdirSync(join(dir, '.iterate')).some((n) => n.includes('.pre-ledger-')),
        false,
        'an unverified migration does not even reach the backup step',
      )
      // The legacy file is still readable by the readers: nothing was lost.
      assert.equal(readDecisionEntries(dir).length, 2)
    } finally {
      cleanup()
    }
  })

  it('refuses to migrate a log holding a line that is NEITHER shape (a gap is not silence)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const original = [
        legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', {}),
        // An unknown EXTRA key: not a legacy record (rule 1) and not a canonical entry,
        // so the file is not "all legacy" — the ledger refuses to start on top of a line
        // it cannot read rather than skipping it into invisibility.
        JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision', data: {}, extra: 1 }),
        '',
      ].join('\n')
      writeFileSync(logOf(dir), original, 'utf-8')
      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-02T00:00:00.000Z', round: 3, type: 'decision', data: {},
      })
      assert.equal(res.count, 0)
      assert.equal(res.code, 'KERNEL_E_DECISION_LOG_CORRUPT')
      assert.match(String(res.error), /line 1/)
      assert.equal(readFileSync(logOf(dir), 'utf-8'), original, 'the unreadable file is kept byte-for-byte')
      // A record that IS legacy-shaped but too big to carry is refused BY THE MIGRATION.
      const big = legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', { blob: 'x'.repeat(9000) })
      writeFileSync(logOf(dir), `${big}\n`, 'utf-8')
      const refused = appendDecisionEntry(dir, {
        timestamp: '2026-01-02T00:00:00.000Z', round: 2, type: 'decision', data: {},
      })
      assert.equal(refused.count, 0)
      assert.equal(refused.code, DECISION_LOG_ERROR_CODES.migration)
      assert.match(String(refused.error), /PAYLOAD|payload|cannot be transcribed/)
      assert.equal(readFileSync(logOf(dir), 'utf-8'), `${big}\n`, 'zero bytes changed on the oversize refusal')
      assert.equal(
        readdirSync(join(dir, '.iterate')).some((n) => n.includes('.pre-ledger-')),
        false,
        'a refused migration leaves no backup and no new file',
      )
    } finally {
      cleanup()
    }
  })

  it('migrating the same history twice builds the same chain (ids come from the records)', () => {
    const a = tempProject()
    const b = tempProject()
    try {
      const body = [legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', { n: 1 }), ''].join('\n')
      for (const project of [a, b]) {
        mkdirSync(join(project.dir, '.iterate'), { recursive: true })
        writeFileSync(logOf(project.dir), body, 'utf-8')
        assert.equal(
          appendDecisionEntry(project.dir, {
            timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision', data: { n: 2 },
          }).error,
          undefined,
        )
      }
      const strip = (lines: string[]): string[] =>
        lines.map((l) => (JSON.parse(l) as { entryId: string }).entryId.slice(0, 10))
      // The 48-bit timestamp half of each ULID is identical for the same instant; only the
      // random tail differs. That is what makes the migration reproducible.
      assert.deepEqual(strip(linesOf(a.dir)), strip(linesOf(b.dir)))
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('timestampMs is the shared ISO rule, not a runtime guess', () => {
    assert.equal(timestampMs('2026-01-01T00:00:00.000Z'), Date.UTC(2026, 0, 1))
    assert.equal(timestampMs('2025-12-31T23:59:59.500+02:00'), Date.UTC(2025, 11, 31, 21, 59, 59, 500))
    // A spelling JS would happily guess at and Python refuses: refused here too.
    assert.equal(timestampMs('11/10/2026 02:28'), null)
    assert.equal(timestampMs('2026-01-01T00:00:00'), null, 'no zone ⇒ no date')
    assert.equal(timestampMs(1735689600000), null)
  })
})

// ─── Contested state ────────────────────────────────────────────────────────

describe('a legacy record AFTER the chain is contested, not repaired', () => {
  it('refuses the write and names the line and the legal moves', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} })
      const before = readFileSync(logOf(dir), 'utf-8')
      appendFileSync(logOf(dir), `${legacyLine('2026-01-01T00:00:01.000Z', 2, 'round_start', {})}\n`, 'utf-8')

      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:02.000Z', round: 3, type: 'decision', data: {},
      })
      assert.equal(res.count, 0)
      assert.equal(res.code, DECISION_LOG_ERROR_CODES.interleaved)
      assert.match(String(res.error), /line 2/)
      assert.match(String(res.error), /legacy record appended after the chain began/)
      assert.match(String(res.remedy), /archive/)
      assert.match(String(res.remedy), /cannot be repaired in place|forges/)
      assert.equal(readFileSync(logOf(dir), 'utf-8'), `${before}${legacyLine('2026-01-01T00:00:01.000Z', 2, 'round_start', {})}\n`)
      assert.equal(decisionLogContestedLine(dir), 2)
    } finally {
      cleanup()
    }
  })

  it('archive-and-restart moves the contested ledger aside losslessly at 0600', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} })
      const contested = `${readFileSync(logOf(dir), 'utf-8')}${legacyLine('2026-01-01T00:00:01.000Z', 2, 'round_start', {})}\n`
      writeFileSync(logOf(dir), contested, 'utf-8')
      // Make the archive assertion ABLE TO FAIL: a ledger that a foreign writer left
      // group/other-readable must come out of `archive` at 0600, so the chmod is the thing
      // under test — not a no-op on a file that already had the mode.
      chmodSync(logOf(dir), 0o644)

      const archive = archiveContestedDecisionLog(dir)
      assert.match(archive, /decision-log\.contested-\d{8}T\d{9}Z\.jsonl$/)
      assert.equal(existsSync(logOf(dir)), false, 'the ledger path is free again')
      assert.equal(readFileSync(archive, 'utf-8'), contested, 'not a byte lost')
      assert.equal(statSync(archive).mode & 0o777, 0o600, 'the archive is owner-only')
      assert.equal(
        readdirSync(join(dir, '.iterate')).filter((n) => n === 'decision-log.jsonl').length,
        0,
        'the contested file was MOVED, not copied',
      )

      // …and the next append starts a fresh, verifiable chain.
      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:02.000Z', round: 3, type: 'decision', data: { after: 'restart' },
      })
      assert.equal(res.error, undefined, String(res.error))
      assert.equal(res.count, 1)
      const genesis = JSON.parse(linesOf(dir)[0]!) as Record<string, unknown>
      assert.equal(genesis['sequence'], 0, 'archive-and-restart restarts CONTINUITY, chosen by a human')
      assert.equal(genesis['prevEntryHash'], '')
      assert.equal(verifyDecisionLedger(dir).ok, true)
    } finally {
      cleanup()
    }
  })

  it('refuses to archive a HEALTHY ledger (continuity is not ours to erase)', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} })
      const before = readFileSync(logOf(dir), 'utf-8')
      assert.throws(
        () => archiveContestedDecisionLog(dir),
        (err: unknown) => {
          const e = err as { code?: string; message?: string; remedy?: string }
          return e.code === DECISION_LOG_ERROR_CODES.interleaved &&
            /not a contested ledger/.test(String(e.message)) &&
            /healthy ledger would lose its continuity/.test(String(e.remedy))
        },
      )
      assert.equal(readFileSync(logOf(dir), 'utf-8'), before, 'the refusal is inert')
      assert.equal(contestedLedgerLine(logOf(dir)), null)
    } finally {
      cleanup()
    }
  })

  it('refuses to archive an ALL-LEGACY ledger (nothing has to be settled)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const original = `${legacyLine('2026-01-01T00:00:00.000Z', 1, 'decision', {})}\n`
      writeFileSync(logOf(dir), original, 'utf-8')
      assert.throws(
        () => archiveContestedDecisionLog(dir),
        (err: unknown) => {
          const e = err as { code?: string; remedy?: string }
          return e.code === DECISION_LOG_ERROR_CODES.interleaved &&
            /ALL legacy records|migrates onto the chain/.test(String(e.remedy))
        },
      )
      assert.equal(readFileSync(logOf(dir), 'utf-8'), original)
    } finally {
      cleanup()
    }
  })

  it('a missing ledger is an empty chain, not a contested one', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.equal(decisionLogContestedLine(dir), null)
      const empty = verifyDecisionLedger(dir)
      assert.equal(empty.ok, true, 'a missing ledger is an EMPTY chain, not an error')
      assert.equal(empty.entries, 0)
      assert.equal(readDecisionLogDetailed(dir).entries.length, 0)
    } finally {
      cleanup()
    }
  })
})

// ─── The kind grammar (this ends the 8-vs-10 divergence) ─────────────────────

describe('the kind gate is the kernel GRAMMAR, not a fixed list', () => {
  it('imports the pattern from the kernel instead of restating it', () => {
    assert.equal(DECISION_KIND_PATTERN, KERNEL_PATTERN, 'this module uses the kernel\'s own RegExp')
    // Pinned to the contract string BOTH shells were coded from (kernel
    // decision-log-entry.ts and harness kernel_decision_record.py).
    assert.equal(DECISION_KIND_PATTERN.source, '^[a-z][a-z0-9_]{0,31}$')
  })

  it('accepts the kinds the Python list refused — the divergence is over', () => {
    // These two are exactly what the harness's own 8-kind list rejected and this
    // plugin's 10-kind list accepted. Both now pass for the same reason: shape.
    for (const kind of ['round_failed', 'resume', 'review_result', 'architectural_fix']) {
      assert.equal(isDecisionKind(kind), true, `${kind} is a well-formed kind`)
    }
    // A kind NEITHER shell has ever emitted: accepted, because adding a kind must not
    // require a kernel release or a list edit in two repositories.
    const { dir, cleanup } = tempProject()
    try {
      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'dimension_context_added', data: { n: 1 },
      })
      assert.equal(res.error, undefined, `unknown-but-well-formed kind refused: ${String(res.error)}`)
      assert.equal(res.count, 1)
      assert.equal(readDecisionEntries(dir)[0]!.type, 'dimension_context_added')
      assert.equal((JSON.parse(linesOf(dir)[0]!) as Record<string, unknown>)['kind'], 'dimension_context_added')
    } finally {
      cleanup()
    }
  })

  it('refuses a 33-character or uppercase kind without touching disk', () => {
    const cases: Array<[string, string]> = [
      ['a'.repeat(33), 'over the 32-character bound'],
      ['Decision', 'uppercase'],
      ['has-dash', 'a dash is not snake_case'],
      ['1starts_with_digit', 'a kind starts with a letter'],
      ['', 'the empty string'],
      ['kind with a space', 'a space is not a kind'],
    ]
    for (const [kind, why] of cases) {
      assert.equal(isDecisionKind(kind), false, `${kind} (${why}) must not be a kind`)
    }
    assert.equal(isDecisionKind('a'.repeat(32)), true, 'exactly 32 is inside the grammar')
    assert.equal(isDecisionKind('round_failed'), true)
    assert.equal(isDecisionKind('UPPER_case'), false)
    assert.equal(isDecisionKind('trailing_'), true, 'the grammar allows a trailing underscore — only SHAPE is checked')
    assert.equal(isDecisionKind(7), false, 'a non-string is not a kind either')

    // And the refusal is inert on disk — no state directory, no ledger, structured error.
    const { dir, cleanup } = tempProject()
    try {
      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'Review_Result', data: {},
      })
      assert.equal(res.count, 0)
      assert.equal(res.code, 'KERNEL_E_DECISION_KIND')
      assert.match(String(res.remedy), /snake_case/)
      assert.equal(existsSync(join(dir, '.iterate')), false, 'a kind refusal must not leave a state dir behind')
    } finally {
      cleanup()
    }
  })
})

// ─── Cross-process log mutex (unchanged contract) ───────────────────────────

describe('acquireLogLock', () => {
  it('releases cleanly and never leaves a lock file behind', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const release = acquireLogLock(dir)
      release()
      assert.equal(existsSync(join(dir, '.iterate', '.decision-log.lock')), false)
    } finally {
      cleanup()
    }
  })

  it('steals a lock owned by a dead pid immediately (no wait budget burned)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', '.decision-log.lock'), '99999999', 'utf-8')
      const started = Date.now()
      const { acquired } = acquireLogLockChecked(dir, { waitMs: 5000 })
      assert.equal(acquired, true)
      assert.ok(Date.now() - started < 1000, 'a dead owner is stolen, not waited out')
    } finally {
      cleanup()
    }
  })

  it('times out fast against a LIVE holder and degrades to a no-op release', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const held = acquireLogLockChecked(dir)
      assert.equal(held.acquired, true)
      const started = Date.now()
      const second = acquireLogLockChecked(dir, { waitMs: 60 })
      assert.equal(second.acquired, false)
      assert.ok(Date.now() - started < 3000)
      second.release() // a no-op: it never owned the lock
      held.release()
    } finally {
      cleanup()
    }
  })
})

// ─── appendDecisionEntry never throws on a broken filesystem layout (F8) ─────

describe('appendDecisionEntry never throws on a broken filesystem layout (F8)', () => {
  const sample = {
    timestamp: '2026-01-01T00:00:00.000Z',
    round: 1,
    type: 'decision',
    data: { note: 'x' },
  }

  it('reports a structured error when .iterate exists as a REGULAR FILE', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const res = appendDecisionEntry(dir, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.equal(res.count, 0)
      assert.equal(typeof res.code, 'string', 'a disk failure carries a code too')
    } finally {
      cleanup()
    }
  })

  it('reports a structured error when the PROJECT ROOT itself is a regular file (mkdir ENOTDIR)', () => {
    const { dir, cleanup } = tempProject()
    try {
      const rootAsFile = join(dir, 'root.json')
      writeFileSync(rootAsFile, '', 'utf-8')
      const res = appendDecisionEntry(rootAsFile, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.match(res.error!, /ENOTDIR/)
      assert.equal(res.count, 0)
    } finally {
      cleanup()
    }
  })

  it('reports a structured error when the log path is a DIRECTORY (EISDIR)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate', 'decision-log.jsonl'), { recursive: true })
      const res = appendDecisionEntry(dir, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.match(res.error!, /EISDIR/)
      assert.equal(res.count, 0)
      assert.match(String(res.remedy), /repair|preserve/i)
    } finally {
      cleanup()
    }
  })

  it('surfaces the failure through the tool instead of rejecting the call', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const tool = captureDecisionLogTool()
      const out = await tool.execute({
        operation: 'append', type: 'decision', round: 1, data: {}, path: dir,
      })
      assert.equal(out.success, false)
      assert.match(String(out.error), /failed to append decision log/)
      assert.equal(typeof out.code, 'string')
      assert.equal(typeof out.remedy, 'string')
    } finally {
      cleanup()
    }
  })

  it('creates the ledger directory owner-only, because the chain lives there', () => {
    const { dir, cleanup } = tempProject()
    try {
      appendDecisionEntry(dir, sample)
      assert.equal(statSync(join(dir, '.iterate')).mode & 0o777, 0o700)
      assert.equal(statSync(logOf(dir)).mode & 0o777, 0o600)
    } finally {
      cleanup()
    }
  })
})

// ─── Entry-count cache ──────────────────────────────────────────────────────

describe('recountEntries failure fallback', () => {
  it('returns the cached count (never a fabricated 1) for a path counted before', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = logOf(dir)
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { a: 1 } })
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.001Z', round: 1, type: 'decision', data: { a: 2 } })
      rmSync(logFile)
      mkdirSync(logFile)
      const res = recountEntries(logFile)
      assert.equal(res.ok, false)
      assert.equal(res.count, 2, 'fallback is the last known count, not a fabricated 1')
    } finally {
      cleanup()
    }
  })

  it('returns 0 / ok:false for a path that was never counted', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.deepEqual(recountEntries(join(dir, 'never-existed.jsonl')), { count: 0, ok: false })
    } finally {
      cleanup()
    }
  })

  it('a ledger it cannot read is refused, and the cache is not poisoned', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = logOf(dir)
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { tag: 'one' } })
      // Unreadable-but-writable: the kernel READS the ledger before it writes, so this
      // append is refused with NOTHING written — the honest flip of the old behaviour.
      chmodSync(logFile, 0o222)
      const sizeBefore = statSync(logFile).size
      const blocked = appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision', data: { tag: 'two' } })
      assert.equal(blocked.count, 0)
      assert.equal(blocked.error !== undefined, true)
      assert.equal(blocked.code, 'KERNEL_E_DECISION_LOG_LOCATION')
      // The kernel READS the ledger before it writes, so an unreadable ledger is refused
      // with nothing appended — checked by byte size, since reading is exactly what fails.
      assert.equal(statSync(logFile).size, sizeBefore, 'the refused append landed no bytes')

      chmodSync(logFile, 0o600)
      const after = appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:02.000Z', round: 3, type: 'decision', data: { tag: 'three' } })
      assert.equal(after.error, undefined, String(after.error))
      assert.equal(after.count, 2, 'the recount is from disk, not from a poisoned cache')
      assert.equal(linesOf(dir).length, 2)
    } finally {
      cleanup()
    }
  })
})

describe('appendDecisionEntry entry-count cache', () => {
  it('refuses a same-size relabelled file instead of trusting the size fast path', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = logOf(dir)
      const first = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { a: 'first' },
      })
      assert.equal(first.error, undefined)
      assert.equal(first.count, 1)
      const sizeAfterFirst = statSync(logFile).size

      // Replace the ledger with ONE line of the EXACT same byte size that is not a valid
      // entry — the "same size ⇒ same count" illusion the cache used to fall for.
      const impostor = `{"d":"${'x'.repeat(Math.max(0, sizeAfterFirst - Buffer.byteLength('{"d":"x"}')))}"}\n`
      assert.equal(Buffer.byteLength(impostor), sizeAfterFirst, 'the impostor is byte-for-byte the same size')
      writeTextAtomic(logFile, impostor)
      invalidateLogCountCache(logFile)

      const res = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:01.000Z', round: 2, type: 'decision', data: { c: 'third' },
      })
      assert.equal(res.count, 0, 'a byte-identical but unverifiable ledger is refused, not counted')
      assert.match(String(res.code), /KERNEL_E_DECISION_LOG_CORRUPT/)
      assert.equal(linesOf(dir).length, 1)
    } finally {
      cleanup()
    }
  })

  it('takes the size fast path when the ledger is untouched, and recounts after invalidation', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = logOf(dir)
      const e = (i: number): typeof sample0 => ({ ...sample0, timestamp: `2026-01-01T00:00:0${i}.000Z`, data: { i } })
      assert.equal(appendDecisionEntry(dir, e(1)).count, 1)
      assert.equal(appendDecisionEntry(dir, e(2)).count, 2)
      const warm = statSync(logFile).size
      invalidateLogCountCache(logFile)
      // Recounted from disk after invalidation — and the chain is still intact, because
      // the reader never had to trust the cache to be right.
      const third = appendDecisionEntry(dir, e(3))
      assert.equal(third.error, undefined)
      assert.equal(third.count, 3)
      assert.ok(warm > 0)
      assert.equal(verifyDecisionLedger(dir).ok, true)
    } finally {
      cleanup()
    }
  })
})

const sample0 = { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} }

describe('entry-count cache capacity (minor 3)', () => {
  it('never grows past LOG_COUNT_CACHE_CAP across many project roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'iterate-decision-log-cache-'))
    try {
      const e = { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: {} }
      const roots: string[] = []
      for (let i = 0; i < LOG_COUNT_CACHE_CAP + 8; i += 1) {
        const root = join(base, `p${i}`)
        roots.push(root)
        const res = appendDecisionEntry(root, e)
        assert.equal(res.error, undefined, String(res.error))
        assert.equal(res.count, 1)
      }
      assert.ok(logCountCacheSize() <= LOG_COUNT_CACHE_CAP)
      assert.equal(logCountCacheSize(), LOG_COUNT_CACHE_CAP, 'eviction keeps the cache exactly at its cap')

      const evicted = roots[0]!
      const again = appendDecisionEntry(evicted, {
        timestamp: '2026-01-01T00:00:05.000Z', round: 2, type: 'decision', data: {},
      })
      assert.equal(again.error, undefined, String(again.error))
      assert.equal(again.count, 2, 'an evicted path must recount from disk, not guess')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// ─── The tool boundary ──────────────────────────────────────────────────────

describe('iterate_decision_log execute', () => {
  it('appends and reads an entry back through the tool', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      const appended = await tool.execute({
        operation: 'append', type: 'decision', round: 2, data: { note: 'hello' }, path: dir,
      })
      assert.equal(appended.operation, 'append')
      assert.equal(appended.error, undefined)
      assert.equal(appended.entryCount, 1)

      const entries = readDecisionEntries(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.type, 'decision')
      assert.equal(entries[0]!.round, 2)
      assert.deepEqual(entries[0]!.data, { note: 'hello' })

      const read = await tool.execute({ operation: 'read', path: dir })
      assert.equal(read.operation, 'read')
      assert.equal(read.entryCount, 1)
      const list = read.entries as Array<{ type: string; data: Record<string, unknown> }>
      assert.equal(list[0]!.type, 'decision')
      assert.deepEqual(list[0]!.data, { note: 'hello' })

      const verified = await tool.execute({ operation: 'verify', path: dir })
      assert.equal(verified.success, true)
    } finally {
      cleanup()
    }
  })

  it('answers an unknown-but-well-formed kind with a SUCCESS, not a refusal', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      const out = await tool.execute({ operation: 'append', type: 'made_up_type', round: 1, data: {}, path: dir })
      assert.equal(out.success, true, `well-formed kind refused: ${JSON.stringify(out)}`)
      assert.equal(out.entryCount, 1)
      assert.equal(readDecisionEntries(dir)[0]!.type, 'made_up_type')
    } finally {
      cleanup()
    }
  })

  it('refuses a kind the grammar cannot carry with a code and a remedy', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      const out = await tool.execute({
        operation: 'append', type: 'Made_Up_Type', round: 1, data: {}, path: dir,
      })
      assert.equal(out.success, false)
      assert.equal(out.code, 'KERNEL_E_DECISION_KIND')
      assert.match(String(out.remedy), /snake_case/)
      assert.equal(readDecisionEntries(dir).length, 0)
      assert.equal(existsSync(decisionLogPath(dir)), false)
    } finally {
      cleanup()
    }
  })

  it('refuses a malformed round and a non-object payload with codes', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      const badRound = await tool.execute({ operation: 'append', type: 'decision', round: 0, data: {}, path: dir })
      assert.equal(badRound.success, false)
      assert.match(String(badRound.code), /ROUND/)
      const badData = await tool.execute({ operation: 'append', type: 'decision', round: 1, data: [1, 2], path: dir })
      assert.equal(badData.success, false)
      assert.match(String(badData.code), /KERNEL_E_DECISION_RECORD/)
      assert.equal(existsSync(decisionLogPath(dir)), false)
    } finally {
      cleanup()
    }
  })

  it('reports a contested ledger through the tool and offers archive as the move', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      await tool.execute({ operation: 'append', type: 'decision', round: 1, data: {}, path: dir })
      appendFileSync(logOf(dir), `${legacyLine('2026-01-01T00:00:01.000Z', 2, 'decision', {})}\n`, 'utf-8')

      const refused = await tool.execute({ operation: 'append', type: 'decision', round: 3, data: {}, path: dir })
      assert.equal(refused.success, false)
      assert.equal(refused.code, DECISION_LOG_ERROR_CODES.interleaved)

      const settled = await tool.execute({ operation: 'archive', path: dir })
      assert.equal(settled.success, true, JSON.stringify(settled))
      assert.equal(typeof settled.archivePath, 'string')
      assert.equal(statSync(String(settled.archivePath)).mode & 0o777, 0o600)

      const after = await tool.execute({ operation: 'append', type: 'decision', round: 4, data: {}, path: dir })
      assert.equal(after.success, true, JSON.stringify(after))
      assert.equal(after.entryCount, 1)
    } finally {
      cleanup()
    }
  })

  it('refuses to archive a healthy ledger through the tool', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      await tool.execute({ operation: 'append', type: 'decision', round: 1, data: {}, path: dir })
      const out = await tool.execute({ operation: 'archive', path: dir })
      assert.equal(out.success, false)
      assert.equal(out.code, DECISION_LOG_ERROR_CODES.interleaved)
      assert.equal(linesOf(dir).length, 1, 'the refusal archived nothing')
    } finally {
      cleanup()
    }
  })

  it('rejects an unknown operation at the parameter boundary', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      // The tool's `operation` enum is the gate, so an invented one never reaches execute().
      await assert.rejects(
        () => tool.execute({ operation: 'nuke', path: dir }) as Promise<unknown>,
        (err: unknown) => /nuke|must be one of|operation/i.test(String(err)),
      )
      assert.equal(existsSync(decisionLogPath(dir)), false, 'a rejected operation created nothing')
    } finally {
      cleanup()
    }
  })
})
