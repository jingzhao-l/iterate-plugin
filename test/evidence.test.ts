import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  countLines,
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

  it('treats a binary (NUL-containing) file as not line-addressable', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-bin-'))
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x0a]))
    const res = verifyFinding(root, { file: 'blob.bin', line: 1 })
    assert.equal(res.verified, false)
    assert.equal(res.error, 'line_out_of_range')
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
    assert.equal(res.error, 'line_out_of_range')
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