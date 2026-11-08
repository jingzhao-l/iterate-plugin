/**
 * test/run-compare.test.ts — the cross-session comparison reducer (v3.16).
 *
 * `src/client/run-compare.ts` turns a run manifest into a compact, serializable
 * baseline and compares two of them side by side. These are the pure halves
 * the F2 tab renders from — every field is derived with defensive optional
 * chaining, so a partial manifest reads as 0/null rather than crashing.
 *
 * What this locks down:
 *   1. buildRunBaseline derives the right aggregates (rounds / findings /
 *      critical+high / fixes / validation pass rate / quality gate),
 *   2. parseRunBaseline round-trips a saved baseline and rejects a
 *      corrupt / wrong-version / non-array payload instead of mis-reading it,
 *   3. compareRuns emits one row per metric with the right "higher is better"
 *      direction, and renders null for a side that never measured it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRunBaseline,
  parseRunBaseline,
  compareRuns,
  RUN_BASELINE_STORAGE_KEY,
  RUN_BASELINE_VERSION,
  type RunBaseline,
  type RunBaselineInput,
  type RunCompareMetric,
} from '../src/client/run-compare.ts'

const SAVED_AT = '2026-11-08T00:00:00.000Z'

function input(overrides: Partial<RunBaselineInput> = {}): RunBaselineInput {
  return {
    project: '/srv/proj',
    mode: 'normal',
    convergence: [3, 1, 0],
    findings: [
      { severity: 'critical' },
      { severity: 'high' },
      { severity: 'medium' },
      { severity: 'low' },
      { severity: undefined },
    ],
    fixes: [{ success: true }, { success: true }, { success: false }],
    validations: [{ allowed: true }, { allowed: true }, { allowed: false }],
    qualityGateStatus: 'pass',
    qualityGateScore: 92,
    stoppedReason: 'converged',
    ...overrides,
  }
}

describe('buildRunBaseline', () => {
  it('derives the aggregates from a real manifest shape', () => {
    const b = buildRunBaseline(input(), SAVED_AT)
    assert.equal(b.version, RUN_BASELINE_VERSION)
    assert.equal(b.savedAt, SAVED_AT)
    assert.equal(b.project, '/srv/proj')
    assert.equal(b.mode, 'normal')
    assert.equal(b.rounds, 3, 'rounds = length of the convergence series')
    assert.equal(b.findings, 5)
    assert.equal(b.criticalHigh, 2, 'critical + high are the must-fix surface')
    assert.equal(b.fixed, 2)
    assert.equal(b.failedFixes, 1)
    assert.equal(b.validationTotal, 3)
    assert.equal(b.validationPassRate, 67, 'round((2/3)*100)')
    assert.equal(b.qualityGateStatus, 'pass')
    assert.equal(b.qualityGateScore, 92)
    assert.equal(b.stoppedReason, 'converged')
    assert.deepEqual(b.convergence, [3, 1, 0])
  })

  it('treats a missing / malformed measurement as 0 or null, never NaN', () => {
    const b = buildRunBaseline(input({ convergence: undefined, findings: undefined, fixes: undefined, validations: undefined }), SAVED_AT)
    assert.equal(b.rounds, 0)
    assert.equal(b.findings, 0)
    assert.equal(b.criticalHigh, 0)
    assert.equal(b.fixed, 0)
    assert.equal(b.failedFixes, 0)
    assert.equal(b.validationPassRate, null, 'no validation ran → no pass rate, not 0%')
    assert.equal(b.validationTotal, 0)
  })

  it('drops an optional project / mode when absent (omitted keys, not empty)', () => {
    const b = buildRunBaseline(input({ project: undefined, mode: undefined }), SAVED_AT)
    assert.equal('project' in b, false)
    assert.equal('mode' in b, false)
  })

  it('ignores a non-object finding / fix / validation entry defensively', () => {
    const b = buildRunBaseline(
      input({ findings: [null, 'x', { severity: 'high' }], fixes: [null, true, { success: true }], validations: [null, { allowed: false }] } as RunBaselineInput),
      SAVED_AT,
    )
    assert.equal(b.findings, 1, 'only object findings count; null / primitive entries are skipped')
    assert.equal(b.criticalHigh, 1)
    assert.equal(b.fixed, 1)
    assert.equal(b.failedFixes, 0)
    assert.equal(b.validationPassRate, 0, 'the one allowed:false is the only counted validation')
    assert.equal(b.validationTotal, 1)
  })

  it('rounds the pass rate and leaves it null when no validation ran', () => {
    assert.equal(buildRunBaseline(input({ validations: [{ allowed: true }, { allowed: true }] }), SAVED_AT).validationPassRate, 100)
    assert.equal(buildRunBaseline(input({ validations: [] }), SAVED_AT).validationPassRate, null)
  })
})

describe('parseRunBaseline', () => {
  it('round-trips a baseline it built', () => {
    const built = buildRunBaseline(input(), SAVED_AT)
    const parsed = parseRunBaseline(JSON.stringify(built))
    assert.deepEqual(parsed, built)
  })

  it('returns null for empty, non-JSON, non-object and wrong-version payloads', () => {
    assert.equal(parseRunBaseline(null), null)
    assert.equal(parseRunBaseline(''), null)
    assert.equal(parseRunBaseline('not json'), null)
    assert.equal(parseRunBaseline('42'), null)
    assert.equal(parseRunBaseline('"hello"'), null)
    assert.equal(parseRunBaseline(JSON.stringify({ ...buildRunBaseline(input(), SAVED_AT), version: 99 })), null)
  })

  it('recovers from a missing convergence array (never throws, reads as empty)', () => {
    const built = buildRunBaseline(input(), SAVED_AT)
    const parsed = parseRunBaseline(JSON.stringify({ ...built, convergence: 'nope' }))
    assert.ok(parsed)
    assert.deepEqual(parsed.convergence, [])
  })

  it('rejects a baseline without a savedAt or findings count', () => {
    const built = buildRunBaseline(input(), SAVED_AT)
    assert.equal(parseRunBaseline(JSON.stringify({ ...built, savedAt: '' })), null)
    assert.equal(parseRunBaseline(JSON.stringify({ ...built, findings: 'x' })), null)
    assert.equal(parseRunBaseline(JSON.stringify({ ...built, findings: Number.NaN })), null)
  })
})

describe('compareRuns', () => {
  // Typed accessor: `noUncheckedIndexedAccess` makes Record index access
  // `T | undefined`, so look up by key and assert presence instead.
  const metric = (rows: RunCompareMetric[], key: RunCompareMetric['key']): RunCompareMetric => {
    const row = rows.find((r) => r.key === key)
    assert.ok(row, `metric ${key} is present`)
    return row
  }

  it('emits every metric with the right direction', () => {
    const base = buildRunBaseline(input(), SAVED_AT)
    const cur = buildRunBaseline(input(), SAVED_AT)
    const rows = compareRuns(base, cur)
    assert.equal(rows.length, 7)
    assert.equal(metric(rows, 'rounds').higherIsBetter, null, 'rounds is neutral — fewer is usually faster but not always better')
    assert.equal(metric(rows, 'findings').higherIsBetter, false)
    assert.equal(metric(rows, 'criticalHigh').higherIsBetter, false)
    assert.equal(metric(rows, 'fixed').higherIsBetter, true)
    assert.equal(metric(rows, 'failedFixes').higherIsBetter, false)
    assert.equal(metric(rows, 'validationPassRate').higherIsBetter, true)
    assert.equal(metric(rows, 'qualityGateScore').higherIsBetter, true)
  })

  it('reports null for a side that never measured a metric', () => {
    const base = buildRunBaseline(input(), SAVED_AT)
    const dry = buildRunBaseline(input({ fixes: [], validations: [], qualityGateStatus: null, qualityGateScore: null }), SAVED_AT)
    const rows = compareRuns(base, dry)
    assert.equal(metric(rows, 'fixed').current, 0, 'a dry-run fixes nothing — current reads 0, not null')
    assert.equal(metric(rows, 'failedFixes').current, 0)
    assert.equal(metric(rows, 'validationPassRate').current, null, 'no validation ran → null, not 0%')
    assert.equal(metric(rows, 'qualityGateScore').current, null, 'gate never computed → null')
    assert.equal(metric(rows, 'qualityGateScore').baseline, 92)
  })

  it('exposes the storage key the renderer persists under', () => {
    assert.equal(RUN_BASELINE_STORAGE_KEY, 'iterate.run-baseline')
  })
})
