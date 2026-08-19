import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
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