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
  normalizeFindingFilter,
  findingMatches,
  filterFindings,
  filterFindingsWithIndices,
  buildFilterOptions,
  countVerdicts,
  batchSetVerdict,
  setAllVerdicts,
  buildRoundHistory,
  buildFindingTrend,
  computeTrendMetrics,
  trendMax,
  buildCompletionSummary,
  buildConfigEditGuide,
  buildConfigEditInstruction,
  keyToVerdict,
  allVerdictKeys,
  RUNTIME_ARTIFACTS,
  buildRuntimeStatusGuide,
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
    report.summary = { totalFindings: 2 } as {
      totalFindings: number
      critical: number
      high: number
      medium: number
      low: number
      byDimension: { correctness: number; security: number }
    } // partial: severity counts missing
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
    assert.equal(groups.correctness?.length, 1)
    assert.equal(groups.security?.length, 1)
  })
})

// ─── buildTriageState / hashReport ───────────────────────────────────────────

describe('buildTriageState / hashReport', () => {
  it('initializes every finding to keep', () => {
    const report = makeReport()
    assert.deepEqual(buildTriageState(report), { '0': 'keep', '1': 'keep' } as Record<string, 'keep' | 'skip' | 'ignore'>)
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
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep', '1': 'ignore' }
    const entries = collectIgnoredEntries(state, report.findings)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.file, 'src/auth.ts')
    assert.equal(entries[0]!.dimension, 'security')
    assert.equal(entries[0]!.line, 12)
  })
})

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('defines a consistent severity taxonomy', () => {
    assert.deepEqual(SEVERITY_ORDER, ['critical', 'high', 'medium', 'low'])
    for (const sev of SEVERITY_ORDER) {
      const key = sev as keyof typeof SEVERITY_LABEL
      assert.ok(typeof SEVERITY_LABEL[key] === 'string')
      assert.match(SEVERITY_COLOR[key], /^#/)
    }
  })
})

// ─── Finding filtering ───────────────────────────────────────────────────────

describe('finding filtering', () => {
  it('normalizes filters (drops unknown severities, trims search)', () => {
    assert.deepEqual(
      normalizeFindingFilter({ severities: ['high', 'bogus'], dimensions: ['', 'security'], search: '  Guard  ' }),
      { severities: ['high'], dimensions: ['security'], search: 'guard' },
    )
    assert.deepEqual(normalizeFindingFilter(null), { severities: [], dimensions: [], search: '' })
    assert.deepEqual(normalizeFindingFilter(undefined), { severities: [], dimensions: [], search: '' })
  })

  it('findingMatches respects severity, dimension, and search filters', () => {
    const f = makeFinding()
    assert.equal(findingMatches(f, { severities: ['high'], dimensions: [], search: '' }), true)
    assert.equal(findingMatches(f, { severities: ['critical'], dimensions: [], search: '' }), false)
    assert.equal(findingMatches(f, { severities: [], dimensions: ['correctness'], search: '' }), true)
    assert.equal(findingMatches(f, { severities: [], dimensions: ['security'], search: '' }), false)
    assert.equal(findingMatches(f, { severities: [], dimensions: [], search: 'null deref' }), true)
    assert.equal(findingMatches(f, { severities: [], dimensions: [], search: 'zzz' }), false)
  })

  it('filterFindings returns matches only', () => {
    const report = makeReport()
    const criticalOnly = filterFindings(report.findings, { severities: ['critical'], dimensions: [], search: '' })
    assert.equal(criticalOnly.length, 1)
    assert.equal(criticalOnly[0]!.dimension, 'security')
  })

  it('filterFindingsWithIndices keeps original indices for batch ops', () => {
    const report = makeReport() // findings[0]=correctness/high, findings[1]=security/critical
    const { filtered, indices } = filterFindingsWithIndices(report.findings, {
      severities: [],
      dimensions: ['security'],
      search: '',
    })
    assert.equal(filtered.length, 1)
    assert.deepEqual(indices, [1])
  })
})

// ─── Filter options / verdicts / batch ops ───────────────────────────────────

describe('filter options & batch verdicts', () => {
  it('buildFilterOptions counts severities and dimensions', () => {
    const report = makeReport()
    const opts = buildFilterOptions(report.findings)
    assert.equal(opts.severities.find((s) => s.value === 'critical')!.count, 1)
    assert.equal(opts.severities.find((s) => s.value === 'high')!.count, 1)
    assert.equal(opts.dimensions.find((d) => d.value === 'security')!.count, 1)
  })

  it('countVerdicts tallies each verdict', () => {
    assert.deepEqual(countVerdicts({ '0': 'keep', '1': 'ignore', '2': 'skip' }), { keep: 1, skip: 1, ignore: 1 })
    assert.deepEqual(countVerdicts({}), { keep: 0, skip: 0, ignore: 0 })
  })

  it('batchSetVerdict returns a NEW state without mutating the input', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep', '1': 'keep', '2': 'keep' }
    const snapshot = JSON.stringify(state)
    const next = batchSetVerdict(state, [1, 2], 'ignore')
    assert.equal(state[1], 'keep')
    assert.equal(JSON.stringify(state), snapshot)
    assert.deepEqual(next, { '0': 'keep', '1': 'ignore', '2': 'ignore' })
  })

  it('batchSetVerdict ignores invalid verdicts / indices', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep' }
    assert.equal(batchSetVerdict(state, [0], 'bogus' as 'keep' | 'skip' | 'ignore'), state)
    assert.equal(batchSetVerdict(state, [], 'ignore'), state)
    assert.deepEqual(batchSetVerdict(state, [0, -1, 1.5], 'skip'), { '0': 'skip' })
  })

  it('setAllVerdicts can target the whole state or a whitelist', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep', '1': 'keep' }
    assert.deepEqual(setAllVerdicts(state, 'skip'), { '0': 'skip', '1': 'skip' })
    assert.deepEqual(setAllVerdicts(state, 'ignore', [0]), { '0': 'ignore', '1': 'keep' })
  })
})

// ─── History & trend ─────────────────────────────────────────────────────────

describe('history & trend', () => {
  it('buildRoundHistory produces per-round counts with severity breakdown', () => {
    const report = makeReport()
    const history = buildRoundHistory(report)
    assert.equal(history.length, 2)
    assert.deepEqual(history[0], { round: 1, count: 1, critical: 0, high: 1, medium: 0, low: 0 })
    assert.deepEqual(history[1], { round: 2, count: 1, critical: 1, high: 0, medium: 0, low: 0 })
  })

  it('buildFindingTrend prefers convergence.findingsByRound', () => {
    const report = makeReport()
    assert.deepEqual(buildFindingTrend(report), [
      { round: 1, count: 1 },
      { round: 2, count: 1 },
      { round: 3, count: 0 },
    ])
  })

  it('computeTrendMetrics derives reduction and convergence', () => {
    const report = makeReport()
    const metrics = computeTrendMetrics(report)
    assert.equal(metrics.total, 2)
    assert.equal(metrics.firstRound, 1)
    assert.equal(metrics.lastRound, 0)
    assert.equal(metrics.reductionPercent, 100)
    assert.equal(metrics.converged, true)
  })

  it('computeTrendMetrics handles an empty trend without division by zero', () => {
    const metrics = computeTrendMetrics(normalizeReport({ convergence: {}, rounds: [], findings: [] }))
    assert.equal(metrics.firstRound, 0)
    assert.equal(metrics.reductionPercent, 0)
  })

  it('trendMax returns a positive baseline even for an empty / all-zero series', () => {
    assert.equal(trendMax([]), 1)
    assert.equal(trendMax([{ round: 1, count: 0 }]), 1)
    assert.equal(trendMax([{ round: 1, count: 3 }, { round: 2, count: 7 }]), 7)
  })
})

// ─── Completion summary / config guide / shortcuts ───────────────────────────

describe('completion & guidance helpers', () => {
  it('buildCompletionSummary describes convergence or max rounds', () => {
    const report = makeReport()
    assert.match(buildCompletionSummary(report), /2\/3 轮/)
    assert.match(buildCompletionSummary(report), /已收敛/)
    const notConverged = normalizeReport({
      convergence: { totalRounds: 3, converged: false },
      rounds: [{ round: 1, findings: [makeFinding()] }],
      findings: [makeFinding()],
    })
    assert.match(buildCompletionSummary(notConverged), /已达最大轮数 3/)
  })

  it('buildConfigEditGuide lists the editable fields', () => {
    const guide = buildConfigEditGuide()
    assert.match(guide, /iterate.config.yaml/)
    assert.match(guide, /max_rounds/)
    assert.match(guide, /atomic.max_lines/)
    assert.match(guide, /iterate_config/)
  })

  it('buildConfigEditInstruction serializes the desired update', () => {
    const text = buildConfigEditInstruction({ max_rounds: 5, dimensions: ['correctness'] })
    assert.match(text, /iterate_config/)
    assert.match(text, /"operation": "write"/)
    assert.match(text, /"max_rounds": 5/)
  })

  it('keyToVerdict maps y/n/a shortcuts and returns null otherwise', () => {
    assert.equal(keyToVerdict('y'), 'keep')
    assert.equal(keyToVerdict('Y'), 'keep')
    assert.equal(keyToVerdict('n'), 'skip')
    assert.equal(keyToVerdict('a'), 'ignore')
    assert.equal(keyToVerdict('ArrowDown'), null)
    assert.equal(keyToVerdict('x'), null)
  })
})

// ─── Select-all keys & runtime status guide ──────────────────────────────────

describe('select-all keys & runtime status guide', () => {
  it('allVerdictKeys returns all numeric indices sorted ascending', () => {
    assert.deepEqual(allVerdictKeys({ 3: 'keep', 0: 'skip', 1: 'ignore' }), [0, 1, 3])
  })

  it('allVerdictKeys ignores non-numeric and negative keys', () => {
    assert.deepEqual(allVerdictKeys({ '-1': 'keep', foo: 'skip', 2: 'ignore' }), [2])
  })

  it('allVerdictKeys handles null / undefined / non-object input', () => {
    assert.deepEqual(allVerdictKeys(null), [])
    assert.deepEqual(allVerdictKeys(undefined), [])
    assert.deepEqual(allVerdictKeys({} as Record<string, 'keep' | 'skip' | 'ignore'>), [])
  })

  it('RUNTIME_ARTIFACTS covers the four expected artifacts', () => {
    const keys = RUNTIME_ARTIFACTS.map((a) => a.key)
    assert.deepEqual(keys, ['decision-log.jsonl', 'checkpoint.json', 'fixes/registry.json', 'fixes/*.bak'])
    for (const a of RUNTIME_ARTIFACTS) {
      assert.equal(typeof a.label, 'string')
      assert.ok(a.label.length > 0)
      assert.equal(typeof a.hint, 'string')
      assert.ok(a.hint.length > 0)
    }
  })

  it('buildRuntimeStatusGuide mentions artifacts and inspect/prune tools', () => {
    const guide = buildRuntimeStatusGuide()
    assert.match(guide, /\.iterate\//)
    assert.match(guide, /decision-log\.jsonl/)
    assert.match(guide, /checkpoint\.json/)
    assert.match(guide, /iterate_status/)
    assert.match(guide, /iterate_history/)
    assert.match(guide, /iterate_prune/)
    assert.match(guide, /dry-run/)
  })
})
