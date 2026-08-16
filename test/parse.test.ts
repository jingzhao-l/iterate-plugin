import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SEVERITY_ORDER,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
  isReviewReport,
  findReportInObject,
  scanSessionForReport,
  normalizeReport,
  computeConvergenceProgress,
  getCurrentRound,
  getTotalRounds,
  severityStats,
  groupByDimension,
  buildTriageState,
  hashReport,
  toKnownIntentionalYaml,
  buildApplyInstruction,
  collectIgnoredEntries,
} from '../lib/parse.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    dimension: 'correctness',
    file: 'src/app.ts',
    line: 12,
    severity: 'high',
    summary: 'Null deref on optional input',
    failure_scenario: 'undefined input crashes',
    suggested_fix: 'Guard the input',
    is_atomic: true,
    ...overrides,
  }
}

function makeReport() {
  const f1 = makeFinding()
  const f2 = makeFinding({
    dimension: 'security',
    file: 'src/auth.ts',
    severity: 'critical',
    summary: 'Missing auth check',
  })
  return {
    mode: 'dry-run',
    goal: 'Improve code quality',
    dimensions: ['correctness', 'security'],
    maxReviewRounds: 3,
    rounds: [
      { round: 1, findings: [f1] },
      { round: 2, findings: [f2] },
    ],
    findings: [f1, f2],
    convergence: {
      totalRounds: 3,
      findingsByRound: [1, 1, 0],
      converged: true,
      stoppedReason: 'converged',
    },
    summary: {
      totalFindings: 2,
      critical: 1,
      high: 1,
      medium: 0,
      low: 0,
      byDimension: { correctness: 1, security: 1 },
    },
  }
}

// ─── isReviewReport ──────────────────────────────────────────────────────────

describe('isReviewReport', () => {
  it('accepts an object with convergence/findings/rounds', () => {
    assert.equal(isReviewReport(makeReport()), true)
  })

  it('rejects null, non-objects, and partial shapes', () => {
    assert.equal(isReviewReport(null), false)
    assert.equal(isReviewReport('report'), false)
    assert.equal(isReviewReport(42), false)
    assert.equal(isReviewReport({}), false)
    assert.equal(isReviewReport({ convergence: {}, findings: [] }), false)
    assert.equal(isReviewReport({ convergence: {}, findings: [], rounds: [] }), true)
  })
})

// ─── findReportInObject ──────────────────────────────────────────────────────

describe('findReportInObject', () => {
  it('finds a report nested inside tool-call results', () => {
    const report = makeReport()
    const session = { messages: [{ content: 'x' }], latest: { result: { report } } }
    assert.equal(findReportInObject(session), report)
  })

  it('returns null for objects without a report', () => {
    assert.equal(findReportInObject({ a: { b: [1, 2, 3] } }), null)
    assert.equal(findReportInObject(null), null)
    assert.equal(findReportInObject('nope'), null)
  })

  it('handles circular references without infinite recursion', () => {
    const node: Record<string, unknown> = { name: 'root', child: null as unknown }
    node.child = node
    assert.equal(findReportInObject(node), null)
  })

  it('respects maxDepth', () => {
    const report = makeReport()
    const deep = { a: { b: { c: { d: { e: report } } } } }
    assert.equal(findReportInObject(deep, undefined, 2), null)
    assert.equal(findReportInObject(deep, undefined, 10), report)
  })
})

// ─── scanSessionForReport ────────────────────────────────────────────────────

describe('scanSessionForReport', () => {
  it('finds a report in session.toolCalls from the most recent iterate_review call', () => {
    const report = makeReport()
    const session = {
      toolCalls: [
        { tool: 'other', result: { value: 1 } },
        { tool: 'iterate_review', result: { report } },
      ],
    }
    assert.equal(scanSessionForReport(session), report)
  })

  it('returns null when no iterate_review result exists', () => {
    assert.equal(scanSessionForReport({ toolCalls: [{ tool: 'other', result: {} }] }), null)
    assert.equal(scanSessionForReport(null), null)
  })
})

// ─── normalizeReport ─────────────────────────────────────────────────────────

describe('normalizeReport', () => {
  it('fills missing convergence/summary fields from the rounds and findings', () => {
    const minimal = {
      convergence: {},
      rounds: [{ round: 1, findings: [makeFinding()] }],
      findings: [makeFinding()],
    }
    const norm = normalizeReport(minimal)
    const conv = norm.convergence as { totalRounds: number; findingsByRound: number[] }
    const sum = norm.summary as { totalFindings: number; high: number }
    assert.equal(conv.totalRounds, 1)
    assert.deepEqual(conv.findingsByRound, [1])
    assert.equal(sum.totalFindings, 1)
    assert.equal(sum.high, 1)
    assert.equal(norm.mode, 'dry-run')
  })

  it('preserves explicitly provided convergence and summary', () => {
    const report = makeReport()
    const norm = normalizeReport(report)
    const conv = norm.convergence as { totalRounds: number; converged: boolean }
    const sum = norm.summary as { critical: number; byDimension: Record<string, number> }
    assert.equal(conv.totalRounds, 3)
    assert.equal(conv.converged, true)
    assert.equal(sum.critical, 1)
    assert.equal(sum.byDimension.security, 1)
  })

  it('does not mutate the input', () => {
    const report = makeReport()
    const snapshot = JSON.stringify(report)
    normalizeReport(report)
    assert.equal(JSON.stringify(report), snapshot)
  })

  it('does not mutate a partially-populated summary object', () => {
    const report = makeReport()
    report.summary = { totalFindings: 2 } // partial: severity counts missing
    const snapshot = JSON.stringify(report)
    const norm = normalizeReport(report)
    // The input summary object must be left untouched…
    assert.equal(JSON.stringify(report), snapshot)
    // …while the normalized summary still carries the full computed fields.
    const sum = norm.summary as { totalFindings: number; high: number; byDimension: Record<string, number> }
    assert.equal(sum.totalFindings, 2)
    assert.equal(sum.high, 1)
    assert.equal(sum.byDimension.security, 1)
  })
})

// ─── Convergence helpers ─────────────────────────────────────────────────────

describe('convergence helpers', () => {
  it('computes progress, current round, and total rounds', () => {
    const report = makeReport()
    assert.equal(getCurrentRound(report), 2)
    assert.equal(getTotalRounds(report), 3)
    assert.equal(computeConvergenceProgress(report), Math.round((2 / 3) * 100))
  })

  it('clamps progress to 100', () => {
    const report = normalizeReport({
      convergence: { totalRounds: 1 },
      rounds: [{ round: 1, findings: [] }],
      findings: [],
    })
    assert.equal(computeConvergenceProgress(report), 100)
  })

  it('returns 0 (not NaN) when total rounds is missing or 0', () => {
    const empty = normalizeReport({ convergence: {}, rounds: [], findings: [] })
    assert.equal(computeConvergenceProgress(empty), 0)
    const zero = normalizeReport({ convergence: { totalRounds: 0 }, rounds: [], findings: [] })
    assert.equal(computeConvergenceProgress(zero), 0)
    assert.ok(Number.isFinite(computeConvergenceProgress(empty)))
  })
})

// ─── severityStats / groupByDimension ────────────────────────────────────────

describe('severityStats / groupByDimension', () => {
  it('counts findings by severity', () => {
    const stats = severityStats(makeReport())
    assert.deepEqual(stats, { critical: 1, high: 1, medium: 0, low: 0 })
  })

  it('groups findings by dimension', () => {
    const groups = groupByDimension(makeReport())
    assert.equal(groups.correctness.length, 1)
    assert.equal(groups.security.length, 1)
  })
})

// ─── buildTriageState / hashReport ───────────────────────────────────────────

describe('buildTriageState / hashReport', () => {
  it('initializes every finding to keep', () => {
    const report = makeReport()
    assert.deepEqual(buildTriageState(report), { '0': 'keep', '1': 'keep' })
  })

  it('produces a deterministic hash', () => {
    const report = makeReport()
    assert.equal(hashReport(report), hashReport(makeReport()))
    assert.ok(hashReport(report).startsWith('iterate-triage-'))
  })
})

// ─── toKnownIntentionalYaml / buildApplyInstruction / collectIgnoredEntries ──

describe('triage serialization helpers', () => {
  it('renders entries as known_intentional YAML with optional line', () => {
    const yamlText = toKnownIntentionalYaml([
      { file: 'src/a.ts', line: 5, dimension: 'security', reason: 'test only' },
      { file: 'src/b.ts', dimension: 'style', reason: 'legacy' },
    ])
    assert.match(yamlText, /known_intentional:/)
    assert.match(yamlText, /file: "src\/a.ts"/)
    assert.match(yamlText, /line: 5/)
    assert.match(yamlText, /file: "src\/b.ts"/)
    assert.ok(!yamlText.includes('line: undefined'))
  })

  it('returns empty string for no entries', () => {
    assert.equal(toKnownIntentionalYaml([]), '')
  })

  it('builds an apply instruction that names iterate_triage', () => {
    const text = buildApplyInstruction([
      { file: 'src/a.ts', dimension: 'security', reason: 'r' },
    ])
    assert.match(text, /iterate_triage/)
    assert.match(text, /"operation": "apply"/)
    assert.match(text, /"file": "src\/a.ts"/)
  })

  it('collects ignored entries from triage state', () => {
    const report = makeReport()
    const state = { '0': 'keep', '1': 'ignore' }
    const entries = collectIgnoredEntries(state, report.findings)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].file, 'src/auth.ts')
    assert.equal(entries[0].dimension, 'security')
    assert.equal(entries[0].line, undefined)
  })
})

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('defines a consistent severity taxonomy', () => {
    assert.deepEqual(SEVERITY_ORDER, ['critical', 'high', 'medium', 'low'])
    for (const sev of SEVERITY_ORDER) {
      assert.ok(typeof SEVERITY_LABEL[sev] === 'string')
      assert.match(SEVERITY_COLOR[sev], /^#/)
    }
  })
})
