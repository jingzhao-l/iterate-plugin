import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convergenceRateFor, computeQualityGate, readQualityGate, writeQualityGate } from '../src/tools/quality-store.ts'

describe('convergenceRateFor', () => {
  it('is 100 for a dimension with no findings at all', () => {
    assert.equal(convergenceRateFor(undefined, 0), 100)
    assert.equal(convergenceRateFor([], 0), 100)
  })

  it('is 0 when a reading exists but no round series is available', () => {
    assert.equal(convergenceRateFor(undefined, 4), 0)
  })

  it('measures the reduction from first to last round', () => {
    assert.equal(convergenceRateFor([5, 3, 1, 0], 0), 100)
    assert.equal(convergenceRateFor([10, 10, 10], 10), 0)
    assert.equal(convergenceRateFor([10, 5, 5], 5), 50)
    assert.equal(convergenceRateFor([4, 1], 1), 75)
  })

  it('clamps to [0, 100] and tolerates malformed input', () => {
    assert.equal(convergenceRateFor([0, 0], 0), 100) // clean throughout → converged
    assert.equal(convergenceRateFor([0, 100], 100), 0) // regression from clean → no convergence
    assert.equal(convergenceRateFor([5, 20], 20), 0) // growth → no convergence
    assert.equal(convergenceRateFor([NaN, -3, 8] as number[], 8), 0)
    assert.equal(convergenceRateFor(['x' as unknown as number], 5), 0)
  })
})

describe('computeQualityGate', () => {
  it('scores each dimension and derives a real convergence rate from findingsByRound', () => {
    const snapshot = computeQualityGate({
      dimensions: ['correctness'],
      findings: [
        { dimension: 'correctness', severity: 'high', file: 'a.ts' },
        { dimension: 'correctness', severity: 'medium', file: 'b.ts' },
      ],
      validationResults: [{ command: 'npm test', exitCode: 0 }],
      findingsByRound: { correctness: [6, 2] },
      fixedByDimension: { correctness: 2 },
    })

    assert.equal(snapshot.totalFindings, 2)
    assert.equal(snapshot.passedChecks, 1)
    assert.equal(snapshot.verificationPassRate, 100)
    const dim = snapshot.dimensions[0]!
    assert.equal(dim.dimension, 'correctness')
    assert.equal(dim.findingsCount, 2)
    assert.equal(dim.fixedCount, 2)
    // (6-2)/6 = 66.6% → 67
    assert.equal(dim.convergenceRate, 67)
    // 100 - (1*15 + 1*5) = 80 → pass
    assert.equal(dim.score, 80)
    assert.equal(dim.status, 'pass')
  })

  it('falls back to fully-converged with no findings, 0 with findings but no series', () => {
    const clean = computeQualityGate({ dimensions: ['security'], findings: [] })
    assert.equal(clean.overallStatus, 'pass')
    assert.equal(clean.dimensions[0]!.convergenceRate, 100)

    const pending = computeQualityGate({
      dimensions: ['security'],
      findings: [{ dimension: 'security', severity: 'medium', file: 'x.ts' }],
    })
    assert.equal(pending.dimensions[0]!.convergenceRate, 0)
  })

  it('ignores findings for dimensions that are not gated', () => {
    const snapshot = computeQualityGate({
      dimensions: ['correctness'],
      findings: [
        { dimension: 'correctness', severity: 'low', file: 'a.ts' },
        { dimension: 'security', severity: 'critical', file: 'b.ts' },
      ],
    })
    assert.equal(snapshot.totalFindings, 2) // global count still sees it
    assert.equal(snapshot.criticalCount, 1)
    assert.equal(snapshot.dimensions[0]!.findingsCount, 1)
    // the un-gated dimension is unscored for the critical finding (only its own findings count)
    assert.equal(snapshot.dimensions[0]!.status, 'pass')
  })

  it('fails the gate on critical findings, failed verification, or a low overall score', () => {
    const critical = computeQualityGate({
      dimensions: ['x'],
      findings: [{ dimension: 'x', severity: 'critical', file: 'a.ts' }],
    })
    assert.equal(critical.overallStatus, 'fail')
    assert.match(critical.failReason as string, /critical/)

    const verif = computeQualityGate({
      dimensions: ['x'],
      findings: [],
      validationResults: [{ command: 'npm test', exitCode: 1 }],
    })
    assert.equal(verif.overallStatus, 'fail')
    assert.match(verif.failReason as string, /validation/)

    const manyLow = Array.from({ length: 40 }, (_, i) => ({
      dimension: 'x',
      severity: 'low',
      file: `f${i}.ts`,
    }))
    const poorScore = computeQualityGate({ dimensions: ['x'], findings: manyLow })
    assert.equal(poorScore.overallStatus, 'fail')
    assert.match(poorScore.failReason as string, /below threshold/)
  })
})

describe('writeQualityGate', () => {
  it('persists a snapshot and reports ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-store-'))
    try {
      const result = writeQualityGate(dir, computeQualityGate({ dimensions: ['correctness'], findings: [] }))
      assert.deepEqual(result, { ok: true })
      assert.equal(existsSync(join(dir, '.iterate', 'quality-gate.json')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a write failure instead of reporting false success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-store-'))
    try {
      // `.iterate` exists as a plain FILE — the write below it must fail.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = writeQualityGate(dir, computeQualityGate({ dimensions: [], findings: [] }))
      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /quality-gate\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readQualityGate', () => {
  it('returns an empty snapshot when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-read-'))
    try {
      const snap = readQualityGate(dir)
      assert.equal(snap.overallStatus, 'pending')
      assert.deepEqual(snap.dimensions, [])
      assert.equal(snap.overallScore, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes a hand-edited file so the tool render never crashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      // `dimensions` absent + non-numeric fields must degrade, not throw.
      writeFileSync(join(dir, '.iterate', 'quality-gate.json'), JSON.stringify({
        overallStatus: 'pass',
        overallScore: 'nope',
        dimensions: undefined,
      }), 'utf-8')
      const snap = readQualityGate(dir)
      assert.equal(snap.overallStatus, 'pass')
      assert.equal(snap.overallScore, 0)
      assert.deepEqual(snap.dimensions, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps only well-formed dimension entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'quality-gate.json'), JSON.stringify({
        overallStatus: 'fail',
        dimensions: [
          { dimension: 'security', score: 30, status: 'fail' },
          { score: 99 },        // no dimension string → dropped
          null,                  // → dropped
        ],
        totalFindings: 'oops',
      }), 'utf-8')
      const snap = readQualityGate(dir)
      assert.equal(snap.dimensions.length, 1)
      assert.equal(snap.dimensions[0]!.dimension, 'security')
      assert.equal(snap.totalFindings, 0)
      assert.equal(snap.overallStatus, 'fail')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes per-dimension numeric/status fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-read-'))
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'quality-gate.json'), JSON.stringify({
        dimensions: [
          { dimension: 'security', score: 'oops', convergenceRate: null, findingsCount: 3, fixedCount: 1, status: 'warp' },
        ],
      }), 'utf-8')
      const snap = readQualityGate(dir)
      const dim = snap.dimensions[0]!
      assert.equal(dim.score, 0)
      assert.equal(dim.convergenceRate, 0)
      assert.equal(dim.findingsCount, 3)
      assert.equal(dim.status, 'warn') // unknown status degrades to warn
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})