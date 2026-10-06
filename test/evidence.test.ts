import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  countLines,
  createEvidenceCache,
  resolveWithin,
  verifyFinding,
  verifyFindings,
  verifyLineBounds,
  evidencePassed,
  evidenceViolations,
  evidenceToPlain,
  WHOLE_FILE_LINE,
} from '../src/evidence.ts'

function realRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'evidence-test-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  // 3 physical lines: line1, line2, line3
  writeFileSync(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n')
  return root
}

describe('countLines', () => {
  it('counts physical lines without a phantom trailing newline', () => {
    assert.equal(countLines(''), 0)
    assert.equal(countLines('a'), 1)
    assert.equal(countLines('a\nb'), 2)
    assert.equal(countLines('a\nb\n'), 2)
    assert.equal(countLines('a\r\nb'), 2)
  })

  it('splits on every str.splitlines() separator for harness parity', () => {
    // Python splitlines() splits on \v \f \u2028 \x85 etc. in addition to \n/\r.
    // 4 separators (\u2028 \u2029 \v \f) → 5 physical lines.
    assert.equal(countLines('a\u2028b\u2029c\vd\fb'), 5)
    assert.equal(countLines('a\x0cb\x0bb'), 3) // \f \v as single-byte separators
  })
})

describe('resolveWithin', () => {
  it('rejects traversal paths escaping the root', () => {
    const root = realRepo()
    assert.equal(resolveWithin(root, '../secret'), null)
    assert.equal(resolveWithin(root, 'src/../../etc/passwd'), null)
    assert.ok(resolveWithin(root, 'src/a.ts') !== null)
  })
})

describe('verifyLineBounds', () => {
  it('whole-file findings (0/undefined) are always bounds-valid', () => {
    assert.deepEqual(verifyLineBounds(undefined, 'line1\nline2'), { inBounds: true, lineTotal: 2 })
    assert.deepEqual(verifyLineBounds(null, 'line1\nline2'), { inBounds: true, lineTotal: 2 })
    assert.deepEqual(verifyLineBounds(WHOLE_FILE_LINE, 'line1\nline2'), { inBounds: true, lineTotal: 2 })
  })

  it('rejects a fractional / NaN / infinite / negative line even inside the file', () => {
    // 42.5-style anchors can never point at real code: the gate must not
    // accept them just because the integer part is in range.
    for (const bad of [42.5, 1.5, 2.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5]) {
      const res = verifyLineBounds(bad, 'line1\nline2\nline3')
      assert.equal(res.inBounds, false, `${bad} must be out of bounds`)
      assert.equal(res.lineTotal, 3)
    }
  })

  it('anchored line 1 and the last line are in bounds, out-of-range is not', () => {
    assert.deepEqual(verifyLineBounds(1, 'line1\nline2'), { inBounds: true, lineTotal: 2 })
    assert.deepEqual(verifyLineBounds(2, 'line1\nline2'), { inBounds: true, lineTotal: 2 })
    assert.deepEqual(verifyLineBounds(3, 'line1\nline2'), { inBounds: false, lineTotal: 2 })
    assert.deepEqual(verifyLineBounds(0, 'line1'), { inBounds: true, lineTotal: 1 }) // 0 = whole file
  })
})

describe('verifyFinding', () => {
  it('accepts an existing file with a real anchored line', () => {
    const root = realRepo()
    const res = verifyFinding(root, { file: 'src/a.ts', line: 2 })
    assert.equal(res.verified, true)
    assert.equal(res.error, undefined)
    assert.equal(res.lineTotal, 3)
    assert.equal(res.line, 2)
  })

  it('accepts a whole-file finding against an existing file', () => {
    const root = realRepo()
    const res = verifyFinding(root, { file: 'src/a.ts', line: 0 })
    assert.equal(res.verified, true)
    assert.equal(res.error, undefined)
  })

  it('rejects a non-existent file as poisoned evidence', () => {
    const root = realRepo()
    const res = verifyFinding(root, { file: 'src/missing.ts', line: 1 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'file_not_found')
  })

  it('rejects a traversal path as poisoned evidence', () => {
    const root = realRepo()
    const res = verifyFinding(root, { file: '../../etc/passwd', line: 1 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'file_not_found')
  })

  it('rejects a line beyond the file as poisoned evidence', () => {
    const root = realRepo()
    const res = verifyFinding(root, { file: 'src/a.ts', line: 99 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'line_out_of_range')
    assert.equal(res.lineTotal, 3)
  })

  it('rejects a fractional line that would otherwise fall inside the file', () => {
    const root = realRepo()
    for (const line of [1.5, 2.5, 0.5]) {
      const res = verifyFinding(root, { file: 'src/a.ts', line })
      assert.equal(res.verified, false, `line ${line} must not pass the gate`)
      assert.equal(res.error, 'line_out_of_range')
    }
    // The integer anchors around them still behave: 1..3 valid, 0 whole-file.
    assert.equal(verifyFinding(root, { file: 'src/a.ts', line: 3 }).verified, true)
    assert.equal(verifyFinding(root, { file: 'src/a.ts', line: 0 }).verified, true)
    // Non-finite values are equally unanchorable.
    for (const line of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(verifyFinding(root, { file: 'src/a.ts', line }).verified, false)
    }
  })

  it('rejects a present-but-non-numeric line instead of degrading to whole-file', () => {
    const root = realRepo()
    // `"2"` / `true` reach the gate only when schema validation is off; they
    // claim an anchor we cannot resolve, so they must not silently become a
    // passing whole-file finding.
    for (const line of ['2', true, {}, []] as unknown as number[]) {
      const res = verifyFinding(root, { file: 'src/a.ts', line })
      assert.equal(res.verified, false, `${JSON.stringify(line)} must not pass the gate`)
      assert.equal(res.error, 'line_out_of_range')
    }
    // Absent / null keep the whole-file semantics (WHOLE_FILE_LINE = 0).
    const absent = verifyFinding(root, { file: 'src/a.ts' })
    assert.equal(absent.verified, true)
    assert.equal(absent.line, null)
    const nulled = verifyFinding(root, { file: 'src/a.ts', line: null as unknown as number })
    assert.equal(nulled.verified, true)
    assert.equal(nulled.line, null)
  })

  it('treats a binary (NUL-containing) file as not line-addressable', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-bin-'))
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x0a]))
    const res = verifyFinding(root, { file: 'blob.bin', line: 1 })
    assert.equal(res.verified, false)
    // Distinct code: the file EXISTS, it just cannot be line-addressed.
    assert.equal(res.error, 'binary_file')
    assert.equal(res.lineTotal, null) // binary → no addressable line count
  })

  it('fills readVerified only when a read set is provided', () => {
    const root = realRepo()
    const resolved = join(root, 'src', 'a.ts')
    const hit = verifyFinding(root, { file: 'src/a.ts', line: 1 }, { readSet: new Set([resolved]) })
    assert.equal(hit.readVerified, true)
    const miss = verifyFinding(root, { file: 'src/a.ts', line: 1 }, { readSet: new Set() })
    assert.equal(miss.readVerified, false)
    const none = verifyFinding(root, { file: 'src/a.ts', line: 1 })
    assert.equal(none.readVerified, undefined)
  })

  it('null / non-object findings fail closed as file_not_found (never throws)', () => {
    const root = realRepo()
    for (const bad of [null, undefined, 'text', 7, [] as unknown]) {
      const res = verifyFinding(root, bad as never)
      assert.equal(res.verified, false)
      assert.equal(res.error, 'file_not_found')
      assert.equal(res.file, '')
    }
  })

  it('a non-string file fails closed without ERR_INVALID_ARG_TYPE', () => {
    const root = realRepo()
    for (const badFile of [123, {}, ['src', 'a.ts']]) {
      const res = verifyFinding(root, { file: badFile } as never)
      assert.equal(res.verified, false)
      assert.equal(res.error, 'file_not_found')
    }
  })

  it('accepts a symlink pointing to a real file inside the project root', () => {
    const root = realRepo()
    writeFileSync(join(root, 'real.ts'), 'one\ntwo\nthree\n')
    symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'))
    const res = verifyFinding(root, { file: 'link.ts', line: 2 })
    assert.equal(res.verified, true)
    assert.equal(res.error, undefined)
    // resolvedPath is the lexical in-root path reported by the verifier; it
    // realpaths to the symlink target (a real file inside the project root).
    assert.equal(res.resolvedPath, join(root, 'link.ts'))
    assert.equal(realpathSync(join(root, 'link.ts')), realpathSync(join(root, 'real.ts')))
    assert.equal(res.lineTotal, 3)
  })

  it('treats a broken symlink (missing target) as file_not_found', () => {
    const root = realRepo()
    symlinkSync(join(root, 'ghost.ts'), join(root, 'broken.ts'))
    const res = verifyFinding(root, { file: 'broken.ts', line: 1 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'file_not_found')
  })

  it('reports lineTotal 0 and rejects a line-1 finding on an empty file', () => {
    const root = realRepo()
    writeFileSync(join(root, 'empty.ts'), '')
    const res = verifyFinding(root, { file: 'empty.ts', line: 1 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'line_out_of_range')
    assert.equal(res.lineTotal, 0)
    // Whole-file findings against the empty file stay bounds-valid.
    const whole = verifyFinding(root, { file: 'empty.ts', line: 0 })
    assert.equal(whole.verified, true)
    assert.equal(whole.lineTotal, 0)
  })

  it('treats an oversized file as not line-addressable without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-big-'))
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)
    writeFileSync(join(root, 'huge.ts'), big)
    const res = verifyFinding(root, { file: 'huge.ts', line: 1 })
    assert.equal(res.verified, false)
    // Distinct code: the file EXISTS, it is just over the read cap.
    assert.equal(res.error, 'file_too_large')
    assert.equal(res.lineTotal, null)
    assert.equal(res.resolvedPath, join(root, 'huge.ts'))
  })
})

describe('verifyFindings / evidencePassed / evidenceViolations / evidenceToPlain', () => {
  it('aggregates and flags any non-grounded finding', () => {
    const root = realRepo()
    const audit = verifyFindings(root, [
      { file: 'src/a.ts', line: 1 },
      { file: 'src/ghost.ts', line: 1 },
    ])
    assert.equal(audit.checked, 2)
    assert.equal(evidencePassed(audit), false)
    assert.equal(evidenceViolations(audit).length, 1)
    assert.equal(evidenceViolations(audit)[0]!.error, 'file_not_found')
  })

  it('reports passed=true and violations=[] for fully grounded evidence', () => {
    const root = realRepo()
    const audit = verifyFindings(root, [{ file: 'src/a.ts', line: 2 }])
    assert.equal(evidencePassed(audit), true)
    assert.equal(evidenceViolations(audit).length, 0)
    const plain = evidenceToPlain(audit)
    assert.equal(plain.passed, true)
    assert.deepEqual(plain.violations, [])
  })

  it('computes a readVerifiedRatio only when reads are tracked', () => {
    const root = realRepo()
    const audit = verifyFindings(
      root,
      [{ file: 'src/a.ts', line: 1 }],
      { readSet: new Set([join(root, 'src', 'a.ts')]) },
    )
    const plain = evidenceToPlain(audit)
    assert.equal(plain.readVerifiedRatio, 1)
  })
})
describe('per-file probe cache (memoized stat/read)', () => {
  it('probes each resolved path once per audit and shares the outcome', () => {
    const root = realRepo()
    const cache = createEvidenceCache()
    const audit = verifyFindings(
      root,
      [
        { file: 'src/a.ts', line: 1 },
        { file: 'src/a.ts', line: 2 },
        { file: 'src/a.ts', line: 3 },
        { file: 'src/a.ts', line: 0 },
      ],
      { cache },
    )
    // Four findings, ONE filesystem probe.
    assert.equal(cache.size, 1)
    assert.equal(audit.checked, 4)
    assert.equal(audit.results.every((r) => r.verified), true)
    // The per-finding line check still runs against each finding's own line.
    assert.deepEqual(audit.results.map((r) => r.line), [1, 2, 3, 0])
  })

  it('caches failing probes too (missing file costs one lookup, not one stat each)', () => {
    const root = realRepo()
    const cache = createEvidenceCache()
    const audit = verifyFindings(
      root,
      [{ file: 'src/ghost.ts', line: 1 }, { file: 'src/ghost.ts', line: 5 }],
      { cache },
    )
    assert.equal(cache.size, 1)
    assert.equal(audit.results.every((r) => r.error === 'file_not_found'), true)
  })

  it('a default (per-call) cache never leaks between audits', () => {
    const root = realRepo()
    const first = verifyFindings(root, [{ file: 'src/a.ts', line: 1 }])
    assert.equal(first.results[0]!.verified, true)
    // Delete the file: the NEXT audit must re-probe and see the real FS state.
    rmSync(join(root, 'src', 'a.ts'))
    const second = verifyFindings(root, [{ file: 'src/a.ts', line: 1 }])
    assert.equal(second.results[0]!.verified, false)
    assert.equal(second.results[0]!.error, 'file_not_found')
  })

  it('an explicitly supplied cache is a deliberate snapshot across calls', () => {
    const root = realRepo()
    const cache = createEvidenceCache()
    const first = verifyFindings(root, [{ file: 'src/a.ts', line: 1 }], { cache })
    assert.equal(first.results[0]!.verified, true)
    rmSync(join(root, 'src', 'a.ts'))
    // Same cache → answered from the first probe (documented snapshot), and
    // no new probe is recorded.
    const second = verifyFindings(root, [{ file: 'src/a.ts', line: 1 }], { cache })
    assert.equal(cache.size, 1)
    assert.equal(second.results[0]!.verified, true)
  })

  it('keeps the readSet verdict per-finding while the probe is cached', () => {
    const root = realRepo()
    const resolved = join(root, 'src', 'a.ts')
    const cache = createEvidenceCache()
    const read = verifyFindings(
      root,
      [{ file: 'src/a.ts', line: 1 }, { file: 'src/a.ts', line: 2 }],
      { cache, readSet: new Set([resolved]) },
    )
    assert.equal(cache.size, 1)
    assert.deepEqual(read.results.map((r) => r.readVerified), [true, true])
    // A different read set on the SAME cache still gets its own verdict: the
    // cached probe never carries readVerified (that is per-call state).
    const unread = verifyFindings(
      root,
      [{ file: 'src/a.ts', line: 1 }],
      { cache, readSet: new Set<string>() },
    )
    assert.equal(cache.size, 1)
    assert.equal(unread.results[0]!.readVerified, false)
    // And without a read set the hint stays "not checkable".
    const hintless = verifyFindings(root, [{ file: 'src/a.ts', line: 1 }], { cache })
    assert.equal(hintless.results[0]!.readVerified, undefined)
  })

  it('createEvidenceCache returns a fresh empty map each call', () => {
    const a = createEvidenceCache()
    const b = createEvidenceCache()
    assert.notEqual(a, b)
    assert.equal(a.size, 0)
    assert.equal(b.size, 0)
  })
})

describe('distinct evidence error codes', () => {
  it('reports file_not_found / line_out_of_range / binary_file / file_too_large distinctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-codes-'))
    writeFileSync(join(root, 'text.ts'), 'one\ntwo\n')
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x61]))
    writeFileSync(join(root, 'huge.ts'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
    mkdirSync(join(root, 'adir'))
    const audit = verifyFindings(root, [
      { file: 'missing.ts', line: 1 },
      { file: 'text.ts', line: 9 },
      { file: 'blob.bin', line: 1 },
      { file: 'huge.ts', line: 1 },
      { file: 'adir', line: 1 },
    ])
    assert.deepEqual(
      audit.results.map((r) => r.error),
      ['file_not_found', 'line_out_of_range', 'binary_file', 'file_too_large', 'line_out_of_range'],
    )
    // Every one of them fails the gate.
    assert.equal(evidencePassed(audit), false)
    assert.equal(evidenceViolations(audit).length, 5)
    const plain = evidenceToPlain(audit) as { violations: { error?: string }[] }
    assert.deepEqual(
      plain.violations.map((v) => v.error),
      ['file_not_found', 'line_out_of_range', 'binary_file', 'file_too_large', 'line_out_of_range'],
    )
  })
})
