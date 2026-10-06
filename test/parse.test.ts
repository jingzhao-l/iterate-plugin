import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SEVERITY_ORDER,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
  isReviewReport,
  findReportInObject,
  scanSessionForReport,
  isRunSummary,
  findRunSummaryInObject,
  scanSessionForRunSummary,
  extractVerdict,
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
  scanSessionForResume,
  countSessionImages,
  scanSessionForTranscript,
  normalizeTranscript,
  scanSessionForQualityGate,
  scanSessionForExperienceBank,
  scanSessionForDefenseEvents,
  filterLiveEntries,
  filterTimelineEntries,
  serializeObservatoryExport,
  latestPhase,
  stoppedReasonLabel,
  TRIAGE_VERDICTS,
  VERDICT_SHORTCUTS,
  isQualityGateSnapshot,
  findFirstInObject,
  latestToolResultNode,
  currentRoundNumber,
  attachLive,
  extractTranscript,
  computeSummaryFromFindings,
  normalizeQualityGateSnapshot,
  normalizeExperienceBankResult,
  normalizeDefenseEventsResult,
  // gap-fix helpers
  START_INSTRUCTION_FULL,
  START_INSTRUCTION_REVIEW_ONLY,
  START_INSTRUCTIONS,
  dashboardRunState,
  buildRoundComparison,
  serializeObservatoryExport as serializeExportWithExtras,
  EXPORT_EXTRA_KEYS,
  buildDiskSnapshotInstruction,
  DISK_SNAPSHOT_SOURCES,
  diskEmptyStateText,
  toolCalledInSession,
  buildFixInstruction,
  buildAssignFixesInstruction,
  buildArchitecturalFixInstruction,
  buildCheckpointResumeInstruction,
  buildCheckpointClearInstruction,
  buildQualityGateQueryInstruction,
  buildQualityGateClearInstruction,
  buildRollbackInstruction,
  buildExperienceListInstruction,
  buildDefenseEventsListInstruction,
  buildTriageReadbackInstruction,
  buildConfigFieldInstruction,
  configFieldByKey,
  CONFIG_EDIT_FIELDS,
  CONFIG_VALUE_PLACEHOLDER,
  normalizeValidations,
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

  it('rejects a junk result.report and keeps scanning deeper in the same result', () => {
    // Regression: an unvalidated `result.report` was returned as-is (feeding
    // normalizeReport) AND shadowed a valid report nested in the same result.
    const deeper = makeReport()
    const session = {
      toolCalls: [
        { tool: 'iterate_review', result: { report: { junk: true }, payload: { review: deeper } } },
      ],
    }
    assert.equal(scanSessionForReport(session), deeper)
  })

  it('returns null when the only result.report is junk', () => {
    const session = {
      toolCalls: [{ tool: 'iterate_review', result: { report: { junk: true } } }],
      messages: [{ tool_calls: [{ function: { name: 'iterate_review', arguments: '{"report":{"junk":true}}' } }] }],
    }
    assert.equal(scanSessionForReport(session), null)
  })

  it('falls back to an OLDER valid call when the newest report is junk', () => {
    const olderValid = makeReport()
    const session = {
      toolCalls: [
        { tool: 'iterate_review', result: { report: olderValid } },
        { tool: 'iterate_review', result: { report: { junk: true } } },
      ],
    }
    assert.equal(scanSessionForReport(session), olderValid)
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

  it('coerces non-array findings / rounds instead of throwing', () => {
    // Regression: `{findings:{a:1},rounds:{}}` (arbitrary session text) threw
    // `findings is not iterable` / `rounds.map is not a function` during render.
    const norm = normalizeReport({
      convergence: { findingsByRound: {} },
      findings: { a: 1 },
      rounds: {},
    })
    assert.deepEqual(norm.findings, [])
    assert.deepEqual(norm.rounds, [])
    const conv = norm.convergence as { totalRounds: number; findingsByRound: number[] }
    assert.equal(conv.totalRounds, 0)
    assert.deepEqual(conv.findingsByRound, []) // derived from the coerced rounds
    const sum = norm.summary as { totalFindings: number; byDimension: Record<string, number> }
    assert.equal(sum.totalFindings, 0)
    // byDimension is a null-prototype map (prototype-pollution guard), so the
    // comparison has to go through a plain-object copy.
    assert.deepEqual({ ...sum.byDimension }, {})
    // Junk scalar shapes must degrade the same way.
    const scalars = normalizeReport({ convergence: {}, findings: 'junk', rounds: 42 })
    assert.deepEqual(scalars.findings, [])
    assert.deepEqual(scalars.rounds, [])
  })

  it('derives stoppedReason only for FINISHED runs (in-progress stays null)', () => {
    // Regression: an in-progress run (1 of 5 rounds) was stamped 'converged'.
    const inProgress = normalizeReport({
      convergence: { totalRounds: 5 },
      rounds: [{ round: 1, findings: [] }],
      findings: [],
    })
    const inConv = inProgress.convergence as { stoppedReason: string | null }
    assert.equal(inConv.stoppedReason, null)

    const finished = normalizeReport({
      convergence: { totalRounds: 2 },
      rounds: [{ round: 1, findings: [] }, { round: 2, findings: [] }],
      findings: [],
    })
    assert.equal((finished.convergence as { stoppedReason: string | null }).stoppedReason, 'max_rounds_reached')

    const convergedEarly = normalizeReport({
      convergence: { totalRounds: 5, converged: true },
      rounds: [{ round: 1, findings: [] }],
      findings: [],
    })
    assert.equal((convergedEarly.convergence as { stoppedReason: string | null }).stoppedReason, 'converged')

    const explicit = normalizeReport({
      convergence: { totalRounds: 5, stoppedReason: 'aborted_by_validation' },
      rounds: [{ round: 1, findings: [] }],
      findings: [],
    })
    assert.equal((explicit.convergence as { stoppedReason: string | null }).stoppedReason, 'aborted_by_validation')

    // A junk (non-string) explicit reason must not survive either.
    const junkReason = normalizeReport({
      convergence: { totalRounds: 5, stoppedReason: 42 },
      rounds: [{ round: 1, findings: [] }],
      findings: [],
    })
    assert.equal((junkReason.convergence as { stoppedReason: string | null }).stoppedReason, null)
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

  it('reads the actual round number from a normal-mode single-round report', () => {
    // Normal-mode aggregates ship ONLY the live round: rounds.length is 1, but
    // the run may be on round 3. The round number must win over array length.
    const report = normalizeReport({
      convergence: { totalRounds: 5, findingsByRound: [4, 3, 2] },
      rounds: [{ round: 3, findings: [{ dimension: 'x' }] }],
      findings: [],
    })
    assert.equal(getCurrentRound(report), 3)
    assert.equal(computeConvergenceProgress(report), Math.round((3 / 5) * 100))
  })

  it('uses the highest round number when a cumulative report has gaps', () => {
    const report = normalizeReport({
      convergence: { totalRounds: 5 },
      rounds: [{ round: 1, findings: [] }, { round: 3, findings: [] }],
      findings: [],
    })
    assert.equal(getCurrentRound(report), 3)
    assert.equal(computeConvergenceProgress(report), Math.round((3 / 5) * 100))
  })

  it('falls back to array length when round numbers are missing', () => {
    const report = normalizeReport({
      convergence: { totalRounds: 5 },
      rounds: [{ findings: [] }, { findings: [] }],
      findings: [],
    })
    assert.equal(getCurrentRound(report), 2)
    assert.equal(computeConvergenceProgress(report), Math.round((2 / 5) * 100))
  })

  it('tolerates non-array rounds / findings on a RAW (un-normalized) report', () => {
    // Regression: `rounds: {}` made computeConvergenceProgress throw
    // `report.rounds is not iterable` when a raw scan result reached render.
    const raw = { convergence: { totalRounds: 5 }, rounds: {}, findings: {} }
    assert.equal(computeConvergenceProgress(raw), 0)
    assert.equal(getCurrentRound(raw), 0)
    assert.equal(computeConvergenceProgress(normalizeReport(raw)), 0)
    // Junk scalar shapes degrade to the same empty state.
    assert.equal(getCurrentRound({ rounds: 'nope' }), 0)
    assert.equal(getCurrentRound({}), 0)
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

  it('skips null / non-object findings instead of crashing', () => {
    const report = { findings: [null, 42, 'x', { severity: 'high', dimension: 'correctness' }] }
    assert.deepEqual(severityStats(report), { critical: 0, high: 1, medium: 0, low: 0 })
    assert.deepEqual({ ...groupByDimension(report) }, { correctness: [{ severity: 'high', dimension: 'correctness' }] })
  })

  it('buildRoundHistory tolerates a null round element', () => {
    const history = buildRoundHistory({ rounds: [null, { round: 2, findings: [] }] })
    assert.deepEqual(history, [
      { round: 0, count: 0, critical: 0, high: 0, medium: 0, low: 0 },
      { round: 2, count: 0, critical: 0, high: 0, medium: 0, low: 0 },
    ])
  })

  it('tolerates a non-array findings value instead of throwing', () => {
    // Regression: `findings: {}` threw `findings is not iterable` in both.
    const report = { findings: {} }
    assert.deepEqual(severityStats(report), { critical: 0, high: 0, medium: 0, low: 0 })
    assert.deepEqual({ ...groupByDimension(report) }, {})
    // …and in the summary / triage / hash consumers of the same field.
    assert.equal(computeSummaryFromFindings([] as unknown as Record<string, unknown>[]).totalFindings, 0)
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

  it('tolerates a non-array findings value', () => {
    // Regression: `findings: {}` must not throw in the triage-state builders.
    assert.deepEqual(buildTriageState({ findings: {} }), {})
    assert.ok(hashReport({ mode: 'dry-run', findings: {} }).startsWith('iterate-triage-'))
    // A string findings value must never fabricate index keys from its length.
    assert.deepEqual(buildTriageState({ findings: 'ab' }), {})
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

  it('ignores a non-array findings value (never indexes string characters)', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'ignore' }
    assert.deepEqual(collectIgnoredEntries(state, 'junk' as unknown as Record<string, unknown>[]), [])
    assert.deepEqual(collectIgnoredEntries(state, {} as unknown as Record<string, unknown>[]), [])
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

  it('buildFilterOptions skips null / non-object findings instead of crashing', () => {
    // Regression: ONE null finding killed the whole TriagePanel filter bar
    // with `Cannot read properties of null (reading 'severity')`.
    assert.doesNotThrow(() => buildFilterOptions([null] as unknown as Record<string, unknown>[]))
    const opts = buildFilterOptions(
      [null, 42, 'x', { severity: 'high', dimension: 'security' }] as unknown as Record<string, unknown>[],
    )
    assert.equal(opts.severities.find((s) => s.value === 'high')!.count, 1)
    assert.equal(opts.severities.find((s) => s.value === 'low')!.count, 0)
    assert.deepEqual(opts.dimensions, [{ value: 'security', count: 1 }])
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

  it('setAllVerdicts rejects verdicts outside TRIAGE_VERDICTS (via batchSetVerdict)', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep', '1': 'keep' }
    assert.equal(setAllVerdicts(state, 'bogus' as 'keep' | 'skip' | 'ignore'), state)
    assert.deepEqual(state, { '0': 'keep', '1': 'keep' })
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

  it('computeTrendMetrics degrades for non-array rounds / findingsByRound', () => {
    // Regression: `rounds: {}` + `convergence.findingsByRound: {}` threw
    // inside the trend derivation during render.
    const metrics = computeTrendMetrics({ rounds: {}, convergence: { findingsByRound: {} } })
    assert.deepEqual(metrics.points, [])
    assert.equal(metrics.total, 0)
    assert.equal(metrics.firstRound, 0)
    assert.equal(metrics.reductionPercent, 0)
    assert.equal(metrics.converged, false)
    assert.deepEqual(buildRoundHistory({ rounds: 'junk' }), [])
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

  it('buildConfigEditGuide surfaces the reasoning_effort field', () => {
    const guide = buildConfigEditGuide()
    assert.match(guide, /reasoning_effort/)
    assert.match(guide, /"low" \/ "medium" \/ "high"/)
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

// ─── Run-summary / meta-review verdict ───────────────────────────────────────

describe('run-summary / meta-review verdict detection', () => {
  function makeRunSummary(overrides = {}) {
    return {
      mode: 'dry-run',
      goal: 'Improve code quality',
      rounds: 3,
      converged: true,
      totalFindings: 2,
      report: makeReport(),
      metaReview: { verdict: 'approved', issues: [], checksRun: 6 },
      finalReport: {
        verdict: 'approved',
        source: {},
        metaReview: { verdict: 'approved', checksRun: 6, issues: [] },
        summary: { totalFindings: 2, converged: true, totalRounds: 3, reportIssues: 0, verdict: 'approved' },
      },
      ...overrides,
    }
  }

  it('isRunSummary recognizes the closing dry-run object', () => {
    assert.equal(isRunSummary(makeRunSummary()), true)
    assert.equal(isRunSummary(null), false)
    assert.equal(isRunSummary(makeReport()), false) // ReviewReport ≠ run-summary
    const needsRevision = makeRunSummary({ finalReport: { verdict: 'needs_revision' } })
    assert.equal(isRunSummary(needsRevision), true)
    const bogus = makeRunSummary({ finalReport: { verdict: 'pending' } })
    assert.equal(isRunSummary(bogus), false)
  })

  it('findRunSummaryInObject finds a run-summary nested in the session tree', () => {
    const run = makeRunSummary()
    const session = { latest: { result: { run } } }
    assert.equal(findRunSummaryInObject(session), run)
    assert.equal(findRunSummaryInObject({ a: { b: [1, 2, 3] } }), null)
    assert.equal(findRunSummaryInObject(null), null)
  })

  it('scanSessionForRunSummary finds the run-summary from a workflow result', () => {
    const run = makeRunSummary()
    const session = { toolCalls: [{ tool: 'workflow', result: run }] }
    assert.equal(scanSessionForRunSummary(session), run)
    assert.equal(scanSessionForRunSummary({ toolCalls: [{ tool: 'iterate_review', result: { report: makeReport() } }] }), null)
    assert.equal(scanSessionForRunSummary(null), null)
  })

  it('extractVerdict yields an approved verdict summary', () => {
    const v = extractVerdict(makeRunSummary())
    assert.equal(v?.verdict, 'approved')
    assert.equal(v?.totalRounds, 3)
    assert.equal(v?.totalFindings, 2)
    assert.equal(v?.checksRun, 6)
    assert.equal(v?.reportIssues, 0)
    assert.equal(v?.converged, true)
  })

  it('extractVerdict reports needs_revision with issue counts', () => {
    const v = extractVerdict(makeRunSummary({
      converged: false,
      finalReport: {
        verdict: 'needs_revision',
        metaReview: { verdict: 'revise', checksRun: 6, issues: [{ code: 'SEVERITY_SUM' }] },
      },
    }))
    assert.equal(v?.verdict, 'needs_revision')
    assert.equal(v?.reportIssues, 1)
    assert.equal(v?.converged, false)
  })

  it('extractVerdict returns null for non-run-summary input', () => {
    assert.equal(extractVerdict(null), null)
    assert.equal(extractVerdict(makeReport()), null)
  })
})

// ─── fixedCount threading through normalization ─────────────────────────────

describe('normalizeReport preserves normal-mode fixedCount', () => {
  it('carries fixedCount through when the summary provides it', () => {
    const report = makeReport()
    report.mode = 'normal'
    report.summary = {
      ...(report.summary as Record<string, unknown>),
      fixedCount: 7,
    } as typeof report.summary & { fixedCount: number }
    const norm = normalizeReport(report)
    const sum = norm.summary as { fixedCount?: number }
    assert.equal(sum.fixedCount, 7)
  })

  it('leaves fixedCount absent when the summary does not provide it', () => {
    const norm = normalizeReport(makeReport())
    const sum = norm.summary as { fixedCount?: number }
    assert.equal(sum.fixedCount, undefined)
  })
})

// ─── scanSessionForResume ────────────────────────────────────────────────────

describe('scanSessionForResume', () => {
  it('returns 0 for non-object / empty input', () => {
    assert.equal(scanSessionForResume(null), 0)
    assert.equal(scanSessionForResume(undefined), 0)
    assert.equal(scanSessionForResume('x'), 0)
    assert.equal(scanSessionForResume({}), 0)
  })

  it('finds a direct resume marker with its resumeCount', () => {
    const session = { type: 'resume', data: { resumedFromRound: 2, resumeCount: 3 } }
    assert.equal(scanSessionForResume(session), 3)
  })

  it('finds a nested decision-log resume entry', () => {
    const session = {
      entries: [
        { type: 'review_result', round: 2 },
        { entry: { type: 'resume', data: { resumedFromRound: 1, resumeCount: 2 } } },
      ],
    }
    assert.equal(scanSessionForResume(session), 2)
  })

  it('returns the highest resumeCount observed across the tree', () => {
    const session = {
      a: { entry: { type: 'resume', data: { resumeCount: 1 } } },
      b: [{ type: 'resume', data: { resumeCount: 4 } }, { type: 'resume', data: { resumeCount: 2 } }],
    }
    assert.equal(scanSessionForResume(session), 4)
  })

  it('treats non-numeric resumeCount as 0', () => {
    assert.equal(scanSessionForResume({ type: 'resume', data: { resumeCount: 'x' } }), 0)
  })
})

// ─── countSessionImages ──────────────────────────────────────────────────────

describe('countSessionImages', () => {
  it('returns 0 for non-object / empty input', () => {
    assert.equal(countSessionImages(null), 0)
    assert.equal(countSessionImages('x'), 0)
    assert.equal(countSessionImages({}), 0)
  })

  it('counts dsh image blocks with an attachment ref', () => {
    const session = {
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }] },
      ],
    }
    assert.equal(countSessionImages(session), 1)
  })

  it('counts raw attachment references by mediaType', () => {
    const session = { attachments: [{ mediaType: 'image/png', width: 800, height: 600 }] }
    assert.equal(countSessionImages(session), 1)
  })

  it('dedupes the same attachmentId across multiple blocks', () => {
    const session = {
      messages: [
        { content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] },
        { content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] },
      ],
    }
    assert.equal(countSessionImages(session), 1)
  })

  it('counts distinct attachmentIds separately', () => {
    const session = {
      content: [
        { type: 'image', attachment: { attachmentId: 'a' } },
        { type: 'image', attachment: { attachmentId: 'b' } },
        { type: 'image', attachment: { attachmentId: 'a' } },
      ],
    }
    assert.equal(countSessionImages(session), 2)
  })

  it('ignores non-image media types', () => {
    const session = { attachments: [{ mediaType: 'application/pdf' }] }
    assert.equal(countSessionImages(session), 0)
  })
})

// ─── Transcript live-feed bridge (attachLive + normalizeTranscript) ────────

const LIVE_SAMPLE = [
  { ts: '2026-01-01T00:00:00.000Z', type: 'read', tool: 'read_file', target: 'src/a.ts' },
  { ts: 1780123456789, type: 'fix', tool: 'iterate_fix', target: 'src/b.ts' },
]

/** A valid TranscriptManifest (isTranscriptManifest requires version+rounds+convergence-array). */
function makeTranscriptManifest() {
  return {
    version: 1,
    project: 'proj',
    mode: 'normal',
    goal: 'Improve code quality',
    maxRounds: 3,
    rounds: [{ round: 1, threads: [], findings: [], readFiles: [] }],
    convergence: [1, 0],
    findings: [],
    fixes: [],
    checkpoint: null,
    timeline: [],
    nudge: null,
  }
}

describe('transcript live bridge', () => {
  it('scanSessionForTranscript surfaces the sibling live array on the manifest', () => {
    const transcript = makeTranscriptManifest()
    const session = {
      toolCalls: [
        {
          tool: 'iterate_transcript',
          result: { operation: 'capture', found: true, live: LIVE_SAMPLE, transcript },
        },
      ],
    }
    const manifest = scanSessionForTranscript(session) as Record<string, unknown> | null
    assert.ok(manifest)
    assert.deepEqual(safeLiveOf(manifest), LIVE_SAMPLE.map((e) => ({ ...e })))
  })

  it('does not mutate the found manifest when attaching live (shallow copy)', () => {
    const transcript = makeTranscriptManifest()
    const session = {
      toolCalls: [{ tool: 'iterate_transcript', result: { operation: 'capture', live: LIVE_SAMPLE, transcript } }],
    }
    const snapshot = JSON.stringify(transcript)
    const manifest = scanSessionForTranscript(session) as Record<string, unknown> | null
    assert.ok(manifest)
    assert.notEqual(manifest, transcript) // not the same reference
    assert.equal(JSON.stringify(transcript), snapshot) // input untouched
  })

  it('keeps the manifest unchanged when the source has no live array', () => {
    const transcript = makeTranscriptManifest()
    const session = { toolCalls: [{ tool: 'iterate_transcript', result: { operation: 'capture', transcript } }] }
    const manifest = scanSessionForTranscript(session) as Record<string, unknown> | null
    assert.ok(manifest)
    assert.equal(safeLiveOf(manifest), undefined)
  })

  it('normalizeTranscript maps live entries into strings and tolerates missing live', () => {
    const normWithLive = normalizeTranscript({
      ...makeTranscriptManifest(),
      live: LIVE_SAMPLE,
    }) as unknown as { live: Array<{ ts?: string; type?: string; tool?: string; target?: string }> }
    assert.ok(Array.isArray(normWithLive.live))
    assert.equal(normWithLive.live.length, 2)
    // Numeric epoch ms is stringified; ISO string is preserved as-is.
    assert.equal(normWithLive.live[0]!.ts, '2026-01-01T00:00:00.000Z')
    assert.equal(normWithLive.live[1]!.ts, String(1780123456789))
    assert.equal(normWithLive.live[1]!.type, 'fix')
    assert.equal(normWithLive.live[1]!.target, 'src/b.ts')

    const normNoLive = normalizeTranscript(makeTranscriptManifest()) as unknown as { live: unknown[] }
    assert.ok(Array.isArray(normNoLive.live))
    assert.equal(normNoLive.live.length, 0)
  })

  it('drops malformed live entries that lack a ts string', () => {
    const norm = normalizeTranscript({
      ...makeTranscriptManifest(),
      live: [
        { type: 'read', tool: 'read_file', target: 'ok.ts' }, // no ts -> asStr -> ''
        { ts: 'bad-ts', type: 'fix', tool: 'iterate_fix', target: 'x.ts' },
      ],
    }) as unknown as { live: Array<{ ts?: string }> }
    assert.equal(norm.live.length, 2)
    // Entries without a usable ts degrade to '' rather than throwing.
    assert.equal(norm.live[0]!.ts, '')
  })

  it('normalizeTranscript passes taskMode through (code/iterate) and tolerates absence/junk', () => {
    const clean = normalizeTranscript(makeTranscriptManifest()) as unknown as { taskMode: string | null }
    assert.equal(clean.taskMode, null)

    const iterate = normalizeTranscript({
      ...makeTranscriptManifest(),
      taskMode: 'iterate',
    }) as unknown as { taskMode: string | null }
    assert.equal(iterate.taskMode, 'iterate')

    const code = normalizeTranscript({
      ...makeTranscriptManifest(),
      taskMode: 'code',
    }) as unknown as { taskMode: string | null }
    assert.equal(code.taskMode, 'code')

    const junk = normalizeTranscript({
      ...makeTranscriptManifest(),
      taskMode: 'review-session',
    }) as unknown as { taskMode: string | null }
    assert.equal(junk.taskMode, null)
  })

  it('normalizeTranscript passes stoppedReason through so the observatory badge renders it', () => {
    // Regression: normalizeTranscript dropped `stoppedReason`, so the
    // observatory badge always fell back to a bare "已结束" instead of the
    // actual stop reason (converged / max_rounds_reached / aborted_by_*).
    const conv = normalizeTranscript({
      ...makeTranscriptManifest(),
      stoppedReason: 'converged',
    }) as unknown as { stoppedReason: string | null }
    assert.equal(conv.stoppedReason, 'converged')

    const config = normalizeTranscript({
      ...makeTranscriptManifest(),
      stoppedReason: 'aborted_by_config',
    }) as unknown as { stoppedReason: string | null }
    assert.equal(config.stoppedReason, 'aborted_by_config')

    // Absent / null / empty values all normalize to null (badge shows "已结束").
    const missing = normalizeTranscript(makeTranscriptManifest()) as unknown as { stoppedReason: string | null }
    assert.equal(missing.stoppedReason, null)
    const empty = normalizeTranscript({
      ...makeTranscriptManifest(),
      stoppedReason: '',
    }) as unknown as { stoppedReason: string | null }
    assert.equal(empty.stoppedReason, null)
  })

  it('stoppedReasonLabel renders a Chinese badge for every known stop reason', () => {
    assert.match(stoppedReasonLabel('converged'), /已收敛/)
    assert.match(stoppedReasonLabel('max_rounds_reached'), /轮数上限/)
    assert.match(stoppedReasonLabel('aborted_by_validation'), /验证失败/)
    assert.match(stoppedReasonLabel('aborted_by_config'), /白名单/)
    // v3.5.5 schema-retry batch — these must NOT fall through to raw English.
    assert.match(stoppedReasonLabel('schema_invalid'), /schema 校验失败/)
    assert.match(stoppedReasonLabel('no_usable_reviewer_output'), /无可用审查输出/)
    assert.match(stoppedReasonLabel('inconclusive'), /结论不明/)
  })

  it('stoppedReasonLabel falls back safely for unknown/no values', () => {
    assert.equal(stoppedReasonLabel('some_other_reason'), '已结束 · some_other_reason')
    assert.equal(stoppedReasonLabel(null), '已结束')
    assert.equal(stoppedReasonLabel(undefined), '已结束')
    assert.equal(stoppedReasonLabel(''), '已结束')
  })

  it('scanSessionForQualityGate returns the latest normalized snapshot (reverse chronological)', () => {
    const session = {
      toolCalls: [
        {
          tool: 'iterate_quality_gate',
          result: { ok: true, kind: 'quality_gate', operation: 'read', snapshot: snap('pass') },
        },
        {
          tool: 'iterate_quality_gate',
          result: { ok: true, kind: 'quality_gate', operation: 'compute', snapshot: snap('fail') },
        },
      ],
    }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'fail') // latest call wins
    assert.equal(out.overallScore, 72)
    assert.equal(out.verificationPassRate, 80)
    assert.equal(out.failReason, 'correctness 收敛度不足')
    assert.equal(out.dimensions.length, 2)
    assert.equal(out.dimensions[0].dimension, 'correctness')
    assert.equal(out.dimensions[0].score, 55)
    assert.deepEqual(session.toolCalls[1]!.result.snapshot, snap('fail')) // input untouched
  })

  it('scanSessionForQualityGate returns null when the session has no gate results', () => {
    assert.equal(scanSessionForQualityGate({ toolCalls: [] }), null)
    assert.equal(scanSessionForQualityGate({ toolCalls: [{ tool: 'iterate_experience', result: { entries: [], count: 0 } }] }), null)
    assert.equal(scanSessionForQualityGate(null), null)
  })

  it('scanSessionForQualityGate surfaces a result embedded in message.tool_calls', () => {
    // Assistant tool-call variant: the result lives on the call object inside
    // message.tool_calls, not on session.toolCalls. The scanner must find it
    // instead of falling back to the (non-JSON) content of the last message.
    const session = {
      messages: [
        { role: 'assistant', tool_calls: [{ name: 'iterate_quality_gate', result: { ok: true, kind: 'quality_gate', operation: 'compute', snapshot: snap('pass') } }] },
        { role: 'assistant', content: '门禁已刷新，一切正常。' },
      ],
    }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'pass')
    assert.equal(out.dimensions.length, 2)
  })

  it('scanSessionForDefenseEvents reads message.tool_calls results too', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { name: 'iterate_defense_events', result: { ok: true, kind: 'defense_events', operation: 'list', language: 'zh', count: 1, events: [eventRec], counts: eventCounts } },
          ],
        },
      ],
    }
    const out = scanSessionForDefenseEvents(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.count, 1)
    assert.equal(out.events.length, 1)
    assert.equal(out.events[0].id, 'def-42')
    assert.equal(out.counts.rollback, 2)
  })

  it('scanSessionForExperienceBank folds get/add single entries into the entries array', () => {
    const listSession = { toolCalls: [{ tool: 'iterate_experience', result: listResult }] }
    const listOut = scanSessionForExperienceBank(listSession) as Record<string, any> | null
    assert.ok(listOut)
    assert.equal(listOut.operation, 'list')
    assert.equal(listOut.count, 2)
    assert.equal(listOut.totalHits, 4)
    assert.equal(listOut.entries.length, 2)
    assert.equal(listOut.entries[0].pattern, '请先解析 JSON')
    assert.equal(listOut.entries[0].hitCount, 2)

    const addSession = {
      toolCalls: [{ tool: 'iterate_experience', result: { ok: true, kind: 'experience', operation: 'add', added: true, entry: singleEntry } }],
    }
    const addOut = scanSessionForExperienceBank(addSession) as Record<string, any> | null
    assert.ok(addOut)
    assert.equal(addOut.added, true)
    assert.equal(addOut.entries.length, 1)
    assert.equal(addOut.entries[0].id, 'exp-9')
  })

  it('scanSessionForExperienceBank deep-finds nested result shapes and tolerates absence', () => {
    const nested = {
      toolCalls: [{
        tool: 'iterate_experience',
        // Wrapped; the list node lives one level down inside `details`.
        result: { ok: true, kind: 'experience', operation: 'list', details: listResult },
      }],
    }
    const out = scanSessionForExperienceBank(nested) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.count, 2)
    assert.equal(out.entries.length, 2)
    assert.equal(scanSessionForExperienceBank({ toolCalls: [] }), null)
    assert.equal(scanSessionForExperienceBank(null), null)
  })

  it('scanSessionForDefenseEvents merges record events and keeps type counts', () => {
    const session = {
      toolCalls: [
        {
          tool: 'iterate_defense_events',
          result: { ok: true, kind: 'defense_events', operation: 'record', language: 'zh', counts: eventCounts, event: eventRec },
        },
      ],
    }
    const out = scanSessionForDefenseEvents(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.operation, 'record')
    assert.equal(out.events.length, 1)
    assert.equal(out.events[0].type, 'rollback')
    assert.equal(out.events[0].description, '修复导致构建失败，回滚')
    assert.equal(out.counts.rollback, 2)
    assert.equal(out.counts.invariant_violated, 1)
    // Unknown/degenerate counts degrade to zero for every KNOWN type.
    assert.equal(out.counts.precondition_failed, 0)
    assert.equal(out.counts.assumption_falsified, 0)
  })

  it('scanSessionForDefenseEvents returns null when the session has none', () => {
    assert.equal(scanSessionForDefenseEvents({ toolCalls: [] }), null)
    assert.equal(scanSessionForDefenseEvents(null), null)
  })
})

function safeLiveOf(manifest: Record<string, unknown>): unknown[] | undefined {
  const v = manifest.live
  return Array.isArray(v) ? (v as unknown[]) : undefined
}

// ─── Malformed / cyclic input resilience (extractTranscript + countSessionImages) ─

describe('cyclic / malformed session resilience', () => {
  it('scanSessionForTranscript does not stack-overflow on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { message: 'hi' }
    cyclic.self = cyclic
    const session = { toolCalls: [{ tool: 'iterate_transcript', result: { message: { inner: cyclic } } }] }
    const manifest = scanSessionForTranscript(session)
    // Must terminate (no RangeError) and find nothing meaningful.
    assert.equal(manifest, null)
  })

  it('countSessionImages counts a block once even when the attachment also matches the raw ref shape', () => {
    // An image block whose attachment carries mediaType would previously match
    // BOTH the block shape and the raw-ref shape, double-counting it to 2.
    const session = {
      content: [{ type: 'image', attachment: { mediaType: 'image/png', attachmentId: 'img-1' } }],
    }
    assert.equal(countSessionImages(session), 1)
  })

  it('countSessionImages does not double-count when attachmentId is absent', () => {
    const session = {
      content: [{ type: 'image', attachment: { mediaType: 'image/png' } }],
    }
    assert.equal(countSessionImages(session), 1)
  })
})

// ─── Quality command center fixtures (v3.1+) ────────────────────────────────

/** A realistic QualityGateSnapshot; overallStatus is parameterized externally. */
function snap(status: string) {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    overallStatus: status,
    overallScore: 72,
    verificationPassRate: 80,
    totalChecks: 10,
    passedChecks: 8,
    failedChecks: 2,
    failReason: status === 'fail' ? 'correctness 收敛度不足' : null,
    totalFindings: 5,
    criticalCount: 0,
    highCount: 1,
    mediumCount: 2,
    lowCount: 2,
    dimensions: [
      { dimension: 'correctness', convergenceRate: 42, findingsCount: 3, fixedCount: 1, score: 55, status: 'fail' },
      { dimension: 'security', convergenceRate: 90, findingsCount: 2, fixedCount: 2, score: 85, status: 'pass' },
    ],
  }
}

const singleEntry = {
  id: 'exp-9',
  dimension: 'correctness',
  pattern: '解析前先校验输入',
  description: '反序列化 JSON 前校验字段存在性。',
  verifiedFix: '用 zod 校验后再使用 payload',
  findingSummary: '直接 JSON.parse 未校验结构',
  severity: 'high',
  hitCount: 1,
  lastHitAt: '2026-01-02T00:00:00.000Z',
  files: ['src/x.ts'],
  tags: ['json', 'robustness'],
}

const listResult = {
  ok: true,
  kind: 'experience',
  operation: 'list',
  count: 2,
  totalHits: 4,
  entries: [
    { ...singleEntry, id: 'exp-1', pattern: '请先解析 JSON', hitCount: 2 },
    { ...singleEntry, id: 'exp-2', pattern: '统一使用 option', hitCount: 2 },
  ],
}

const eventCounts = {
  precondition_failed: 0,
  rollback: 2,
  invariant_violated: 1,
  assumption_falsified: 0,
}

const eventRec = {
  id: 'def-42',
  timestamp: '2026-01-01T00:00:00.000Z',
  round: 2,
  type: 'rollback',
  description: '修复导致构建失败，回滚',
  defense: '验证守卫：构建必须通过才能进入下一轮',
  outcome: 'reverted',
  file: 'src/y.ts',
  line: 14,
  severity: 'high',
}

describe('hashReport (content digest)', () => {
  const base = {
    mode: 'dry-run',
    findings: [
      { dimension: 'correctness', file: 'a.ts', line: 1, summary: 'missing null check' },
      { dimension: 'security', file: 'b.ts', line: 0, summary: 'unpinned dep' },
    ],
  }
  it('is stable for identical reports', () => {
    const h1 = hashReport(JSON.parse(JSON.stringify(base)))
    const h2 = hashReport(JSON.parse(JSON.stringify(base)))
    assert.equal(h1, h2)
  })
  it('differs when a finding summary changes', () => {
    const other = JSON.parse(JSON.stringify(base))
    other.findings[0].summary = 'missing bounds check'
    assert.notEqual(hashReport(base), hashReport(other))
  })
  it('differs when only the first-20-chars collide (old weak signature)', () => {
    const a = JSON.parse(JSON.stringify(base))
    const b = JSON.parse(JSON.stringify(base))
    a.findings[0].summary = 'missing null check at line X'
    b.findings[0].summary = 'missing null check at line Y'
    // old key used mode+count+first 20 chars — these two collide under the old scheme
    assert.equal(String(a.findings[0].summary).slice(0, 20), String(b.findings[0].summary).slice(0, 20))
    assert.notEqual(hashReport(a), hashReport(b))
  })
  it('differs when a finding line changes', () => {
    const other = JSON.parse(JSON.stringify(base))
    other.findings[0].line = 2
    assert.notEqual(hashReport(base), hashReport(other))
  })
})

// ─── Runtime-observatory UI pure helpers ─────────────────────────────────────

describe('filterLiveEntries', () => {
  const entries = [
    { ts: 't1', type: 'read', tool: 'read_file', target: 'a.ts' },
    { ts: 't2', type: 'fix', tool: 'iterate_fix', target: 'b.ts' },
    { ts: 't3', type: 'rollback', tool: 'iterate_rollback', target: 'fix-1' },
    { ts: 't4', type: 'read', tool: 'read_file', target: 'c.ts' },
  ]
  it('returns a copy of all entries when type is empty', () => {
    const out = filterLiveEntries(entries, '')
    assert.deepEqual(out, entries)
    assert.notEqual(out, entries) // copy, not the same reference
  })
  it('filters by exact type', () => {
    const out = filterLiveEntries(entries, 'read')
    assert.deepEqual(out.map((e) => e.target), ['a.ts', 'c.ts'])
  })
  it('returns [] for an unknown type', () => {
    assert.deepEqual(filterLiveEntries(entries, 'prune'), [])
  })
  it('treats non-string / missing type as "match everything"', () => {
    assert.equal(filterLiveEntries(entries, undefined).length, 4)
    assert.equal(filterLiveEntries(entries, 5 as unknown as string).length, 4)
  })
  it('is defensive for non-array input', () => {
    assert.deepEqual(filterLiveEntries(null, 'read'), [])
    assert.deepEqual(filterLiveEntries({}, 'read'), [])
  })
  it('preserves the original (newest first) order', () => {
    const out = filterLiveEntries(entries, '')
    assert.deepEqual(out.map((e) => e.ts), ['t1', 't2', 't3', 't4'])
  })
})

describe('filterTimelineEntries', () => {
  const entries = [
    { timestamp: '2026-01-01T00:00:00.000Z', round: 2, type: 'atomic_fix', data: { file: 'b.ts' } },
    { timestamp: '2026-01-01T00:00:01.000Z', round: 1, type: 'round_start', data: { round: 1 } },
    { timestamp: '2026-01-01T00:00:02.000Z', round: 1, type: 'review_result', data: { count: 2 } },
    { timestamp: '2026-01-01T00:00:03.000Z', round: 2, type: 'revert', data: { id: 'f1' } },
  ]
  it('returns all entries newest first when no filters are set', () => {
    const out = filterTimelineEntries(entries, {})
    assert.deepEqual(out.map((e) => e.timestamp), [
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
  })
  it('filters by type', () => {
    const out = filterTimelineEntries(entries, { type: 'revert' })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.type, 'revert')
  })
  it('filters by round (string-compared)', () => {
    const out = filterTimelineEntries(entries, { round: '1' })
    assert.equal(out.length, 2)
    for (const e of out) assert.equal(String(e.round), '1')
  })
  it('filters by case-insensitive search over type/round/data', () => {
    const out = filterTimelineEntries(entries, { search: 'b.ts' })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.type, 'atomic_fix')
    const byType = filterTimelineEntries(entries, { search: 'REVIEW_RESULT' })
    assert.equal(byType.length, 1)
    assert.equal(byType[0]!.type, 'review_result')
  })
  it('combines type + round + search filters', () => {
    const out = filterTimelineEntries(entries, { type: 'round_start', round: '1', search: 'round_start' })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.type, 'round_start')
  })
  it('returns [] when no entry matches', () => {
    assert.deepEqual(filterTimelineEntries(entries, { round: '9' }), [])
  })
  it('is defensive for non-array input and drops non-object entries', () => {
    assert.deepEqual(filterTimelineEntries(null, {}), [])
    assert.deepEqual(filterTimelineEntries([null, 42, 'x', ...entries], { type: 'revert' }), [
      entries[3],
    ])
  })
  it('still sorts newest first when timestamps are absent (localeCompare on "")', () => {
    const out = filterTimelineEntries(
      [{ type: 'a' }, { type: 'b', timestamp: '2026-01-01T00:00:00.000Z' }],
      {},
    )
    assert.equal(out.length, 2)
  })
  it('does not crash when a timeline entry data is circular during a search', () => {
    const cyclic: Record<string, unknown> = { file: 'b.ts' }
    cyclic.self = cyclic
    // The search must terminate without a RangeError/TypeError; the circular
    // data stringifies to "[object Object]" so it cannot match the query.
    const out = filterTimelineEntries([{ timestamp: 't', type: 'atomic_fix', data: cyclic }], { search: 'b.ts' })
    assert.deepEqual(out, [])
  })
  it('does not crash when data is a non-stringifiable primitive', () => {
    const out = filterTimelineEntries(
      [{ timestamp: 't', type: 'x', data: 42 }, { timestamp: 't2', type: 'x', data: 'plain' }],
      { search: 'plain' },
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.data, 'plain')
  })
})

describe('serializeObservatoryExport', () => {
  it('produces valid JSON with exportedAt, manifest and live', () => {
    const manifest = { version: 1, goal: 'g', rounds: [] }
    const live = [{ type: 'read', target: 'a.ts' }]
    const parsed = JSON.parse(serializeObservatoryExport(manifest, live)) as {
      exportedAt: string
      manifest: Record<string, unknown>
      live: unknown[]
    }
    assert.equal(typeof parsed.exportedAt, 'string')
    assert.deepEqual(parsed.manifest, manifest)
    assert.deepEqual(parsed.live, live)
  })
  it('includes a parseable exportedAt stamp', () => {
    const before = Date.now()
    const parsed = JSON.parse(serializeObservatoryExport({}, [])) as { exportedAt: string }
    const stamp = Date.parse(parsed.exportedAt)
    assert.ok(Number.isFinite(stamp), 'exportedAt must be a parseable ISO timestamp')
    assert.ok(stamp >= before - 1000 && stamp <= Date.now() + 1000, 'exportedAt must be "now"')
  })
  it('guards a null manifest and non-array live', () => {
    const parsed = JSON.parse(serializeObservatoryExport(null, 'nope')) as {
      manifest: unknown
      live: unknown[]
    }
    assert.equal(parsed.manifest, null)
    assert.deepEqual(parsed.live, [])
  })
  it('never throws on a non-serializable manifest (cyclic)', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const text = serializeObservatoryExport(cyclic, [])
    const parsed = JSON.parse(text) as { manifest: unknown }
    assert.equal(parsed.manifest, null)
  })
})

describe('latestPhase', () => {
  it('returns the last non-empty phase', () => {
    assert.equal(latestPhase(['plan', 'review', 'fix']), 'fix')
    assert.equal(latestPhase(['plan', 'review']), 'review')
  })
  it('skips blank / non-string entries', () => {
    assert.equal(latestPhase(['plan', '', '  review  ']), 'review')
    assert.equal(latestPhase(['', null, 42]), '')
  })
  it('returns "" for an empty or non-array input', () => {
    assert.equal(latestPhase([]), '')
    assert.equal(latestPhase(null), '')
    assert.equal(latestPhase('plan'), '')
  })
})

// ─── Exported core deep-scan helpers ─────────────────────────────────────────

describe('findFirstInObject', () => {
  const findGate = (o: Record<string, unknown>) => isQualityGateSnapshot(o)

  it('finds the first node satisfying the predicate', () => {
    const tree = { wrap: { nested: [{ nope: true }, { snapshot: snap('pass') }] } }
    const found = findFirstInObject(tree, findGate)
    assert.ok(found)
    assert.equal(found.overallStatus, 'pass')
  })

  it('sees through STRING-encoded JSON nodes (tool results / contents)', () => {
    const wrapped = findFirstInObject('  ' + JSON.stringify({ snapshot: snap('fail') }), findGate)
    assert.ok(wrapped)
    assert.equal(wrapped.overallStatus, 'fail')
    const asArray = findFirstInObject(JSON.stringify([{ snapshot: snap('pass') }]), findGate)
    assert.ok(asArray)
    assert.equal(asArray.overallStatus, 'pass')
  })

  it('returns null for plain / broken strings and primitives', () => {
    assert.equal(findFirstInObject('门禁已刷新', findGate), null)
    assert.equal(findFirstInObject('{"overallStatus":"pass"', findGate), null) // broken JSON text
    assert.equal(findFirstInObject('{"overallStatus":"pass"}', findGate), null) // parses, no match
    assert.equal(findFirstInObject(42, findGate), null)
    assert.equal(findFirstInObject(true, findGate), null)
    assert.equal(findFirstInObject(null, findGate), null)
  })

  it('keeps the circular-reference and depth guards', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    assert.equal(findFirstInObject(node, findGate), null)
    const deep = { a: { b: { snapshot: snap('pass') } } }
    assert.equal(findFirstInObject(deep, findGate, undefined, 1), null)
    assert.ok(findFirstInObject(deep, findGate, undefined, 8))
  })
})

describe('latestToolResultNode', () => {
  const findGate = (n: unknown) => findFirstInObject(n, (o) => isQualityGateSnapshot(o))

  it('returns the newest matching toolCalls result (reverse chronological)', () => {
    const session = {
      toolCalls: [
        { tool: 'iterate_quality_gate', result: { snapshot: snap('pass') } },
        { tool: 'iterate_quality_gate', result: { snapshot: snap('fail') } },
      ],
    }
    const node = latestToolResultNode(session, 'iterate_quality_gate', findGate) as Record<string, any> | null
    assert.ok(node)
    assert.equal(node.snapshot.overallStatus, 'fail')
  })

  it('skips a junk LATEST result so an older valid one still surfaces', () => {
    const session = {
      toolCalls: [
        { tool: 'iterate_quality_gate', result: { snapshot: snap('pass') } },
        { tool: 'iterate_quality_gate', result: { error: 'boom' } },
      ],
    }
    const node = latestToolResultNode(session, 'iterate_quality_gate', findGate) as Record<string, any> | null
    assert.ok(node)
    assert.equal(node.snapshot.overallStatus, 'pass')
  })

  it('reads assistant message.tool_calls results too', () => {
    const session = {
      messages: [
        { role: 'assistant', tool_calls: [{ name: 'iterate_quality_gate', result: { snapshot: snap('pass') } }] },
      ],
    }
    const node = latestToolResultNode(session, 'iterate_quality_gate', findGate) as Record<string, any> | null
    assert.ok(node)
    assert.equal(node.snapshot.overallStatus, 'pass')
  })

  it('scans contents newest→oldest so a closing message never shadows an embedded payload', () => {
    const payload = JSON.stringify({ snapshot: snap('pass') })
    const session = { messages: [{ content: payload }, { content: '门禁已刷新，一切正常。' }] }
    assert.equal(latestToolResultNode(session, 'iterate_quality_gate', findGate), payload)
  })

  it('prefers the newest content when several messages embed a match', () => {
    const olderPayload = JSON.stringify({ snapshot: snap('pass') })
    const newerPayload = JSON.stringify({ snapshot: snap('fail') })
    const session = { messages: [{ content: olderPayload }, { content: newerPayload }] }
    assert.equal(latestToolResultNode(session, 'iterate_quality_gate', findGate), newerPayload)
  })

  it('returns null for non-object sessions or when nothing matches', () => {
    assert.equal(latestToolResultNode(null, 'iterate_quality_gate', findGate), null)
    assert.equal(latestToolResultNode('session', 'iterate_quality_gate', findGate), null)
    assert.equal(
      latestToolResultNode({ toolCalls: [{ tool: 'iterate_quality_gate', result: { error: 'boom' } }] }, 'iterate_quality_gate', findGate),
      null,
    )
    assert.equal(latestToolResultNode({ messages: [{ content: 'plain text' }] }, 'iterate_quality_gate', findGate), null)
  })
})

describe('currentRoundNumber', () => {
  it('reads the highest per-round number (normal-mode live-round aggregate)', () => {
    assert.equal(currentRoundNumber({ rounds: [{ round: 3 }, { round: 1 }] }), 3)
    assert.equal(currentRoundNumber({ rounds: [{ round: 2 }, { round: 5 }] }), 5)
  })

  it('falls back to the array length when round numbers are unusable', () => {
    assert.equal(currentRoundNumber({ rounds: [{}, {}] }), 2)
    assert.equal(currentRoundNumber({ rounds: [{ round: 0 }] }), 1)
    assert.equal(currentRoundNumber({ rounds: [null, 'x'] }), 2) // junk elements → length
  })

  it('returns 0 for non-array / missing rounds', () => {
    // Regression: `rounds: {}` threw `report.rounds is not iterable`.
    assert.equal(currentRoundNumber({ rounds: {} }), 0)
    assert.equal(currentRoundNumber({ rounds: 'junk' }), 0)
    assert.equal(currentRoundNumber({}), 0)
  })

  it('agrees with getCurrentRound on the same input', () => {
    const report = { rounds: [{ round: 4 }] }
    assert.equal(currentRoundNumber(report), getCurrentRound(report))
  })
})

// ─── Transcript extraction helpers (attachLive / extractTranscript) ─────────

describe('attachLive / extractTranscript', () => {
  it('attachLive copies the sibling live array without mutating the manifest', () => {
    const manifest = makeTranscriptManifest()
    const out = attachLive(manifest, { live: LIVE_SAMPLE })
    assert.ok(out)
    assert.notEqual(out, manifest) // defensive shallow copy
    assert.equal(safeLiveOf(out), LIVE_SAMPLE) // same array reference, copied on
    assert.equal((manifest as Record<string, unknown>).live, undefined) // input untouched
  })

  it('attachLive keeps the manifest unchanged when there is nothing to attach', () => {
    const manifest = makeTranscriptManifest()
    assert.equal(attachLive(manifest, {}), manifest)
    assert.equal(attachLive(manifest, { live: 'junk' }), manifest)
    assert.equal(attachLive(null, { live: LIVE_SAMPLE }), null)
    const withLive = { ...makeTranscriptManifest(), live: LIVE_SAMPLE }
    assert.equal(attachLive(withLive, { live: [{ ts: 'x' }] }), withLive) // already carries live
  })

  it('extractTranscript parses a STRING-wrapped manifest payload', () => {
    const manifest = makeTranscriptManifest()
    assert.deepEqual(extractTranscript(JSON.stringify(manifest)), manifest)
    assert.equal(extractTranscript(manifest), manifest) // raw object passes through
  })

  it('extractTranscript handles capture wrappers (live attached) and message wrappers', () => {
    const manifest = makeTranscriptManifest()
    const captured = extractTranscript({ operation: 'capture', transcript: manifest, live: LIVE_SAMPLE })
    assert.ok(captured)
    assert.equal(captured.version, manifest.version)
    assert.equal(safeLiveOf(captured), LIVE_SAMPLE)
    assert.equal(extractTranscript({ message: manifest }), manifest)
    assert.equal(extractTranscript({ content: [manifest] }), manifest)
  })

  it('extractTranscript returns null for non-JSON strings, primitives and cycles', () => {
    assert.equal(extractTranscript('plain text'), null)
    assert.equal(extractTranscript('{"broken'), null)
    assert.equal(extractTranscript(42), null)
    assert.equal(extractTranscript(null), null)
    const cycle: Record<string, unknown> = { name: 'root' }
    cycle.self = cycle
    assert.equal(extractTranscript(cycle), null)
  })
})

// ─── String-encoded session payloads (scanSessionFor* scanners) ─────────────

describe('string-encoded session payloads', () => {
  it('scanSessionForQualityGate reads a STRING-encoded tool result', () => {
    const session = { toolCalls: [{ tool: 'iterate_quality_gate', result: JSON.stringify({ snapshot: snap('pass') }) }] }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'pass')
    assert.equal(out.dimensions.length, 2)
  })

  it('scanSessionForQualityGate reads STRING-encoded message content', () => {
    const session = { messages: [{ role: 'assistant', content: JSON.stringify({ snapshot: snap('fail') }) }] }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'fail')
  })

  it('scanSessionForExperienceBank reads a STRING-encoded tool result', () => {
    const session = { toolCalls: [{ tool: 'iterate_experience', result: JSON.stringify(listResult) }] }
    const out = scanSessionForExperienceBank(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.count, 2)
    assert.equal(out.entries.length, 2)
  })

  it('scanSessionForDefenseEvents reads a STRING-encoded tool result', () => {
    const session = {
      toolCalls: [{
        tool: 'iterate_defense_events',
        result: JSON.stringify({ ok: true, kind: 'defense_events', operation: 'list', language: 'zh', count: 1, events: [eventRec], counts: eventCounts }),
      }],
    }
    const out = scanSessionForDefenseEvents(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.count, 1)
    assert.equal(out.counts.rollback, 2)
  })

  it('scanSessionForReport reads a STRING-encoded iterate_review result', () => {
    const report = makeReport()
    const session = { toolCalls: [{ tool: 'iterate_review', result: JSON.stringify({ report }) }] }
    // A string payload round-trips through JSON.parse, so assert deep equality
    // (the recovered report is a fresh object, not the original reference).
    assert.deepEqual(scanSessionForReport(session), report)
  })

  it('never false-positives on plain / broken non-JSON strings', () => {
    assert.equal(scanSessionForQualityGate({ toolCalls: [{ tool: 'iterate_quality_gate', result: '门禁已刷新' }] }), null)
    assert.equal(scanSessionForQualityGate({ messages: [{ content: '{"overallStatus":"pass"' }] }), null)
    assert.equal(scanSessionForReport({ toolCalls: [{ tool: 'iterate_review', result: 'not json at all' }] }), null)
  })
})

// ─── Message content fallback recency ────────────────────────────────────────

describe('message content fallback recency', () => {
  it('a conversational closing message does not shadow an earlier embedded result', () => {
    // Regression: [{content:'{"overallStatus":…}'},{content:'门禁已刷新'}] → null.
    const session = {
      messages: [
        { content: JSON.stringify({ snapshot: snap('pass') }) },
        { content: '门禁已刷新' },
      ],
    }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'pass')
  })

  it('prefers the newest embedded result when several contents carry one', () => {
    const session = {
      messages: [
        { content: JSON.stringify({ snapshot: snap('pass') }) },
        { content: JSON.stringify({ snapshot: snap('fail') }) },
      ],
    }
    const out = scanSessionForQualityGate(session) as Record<string, any> | null
    assert.ok(out)
    assert.equal(out.overallStatus, 'fail')
  })
})

// ─── Parallel tool-call recency (within one assistant message) ──────────────

describe('parallel tool-call recency', () => {
  it('the NEWER of two parallel iterate_review calls wins', () => {
    // Regression: tool_calls were scanned forward, so the OLDER result won
    // ("Prefers the most recent one" was contradicted).
    const olderReport = { ...makeReport(), marker: 'OLD' }
    const newerReport = { ...makeReport(), marker: 'NEW' }
    const session = {
      messages: [{
        tool_calls: [
          { function: { name: 'iterate_review', arguments: JSON.stringify({ report: olderReport }) } },
          { function: { name: 'iterate_review', arguments: JSON.stringify({ report: newerReport }) } },
        ],
      }],
    }
    const found = scanSessionForReport(session) as { marker?: string } | null
    assert.ok(found)
    assert.equal(found.marker, 'NEW')
  })

  it('the NEWER of two parallel iterate_transcript calls wins', () => {
    const olderManifest = { ...makeTranscriptManifest(), marker: 'OLD' }
    const newerManifest = { ...makeTranscriptManifest(), marker: 'NEW' }
    const session = {
      messages: [{
        tool_calls: [
          { arguments: JSON.stringify({ operation: 'capture', transcript: olderManifest }) },
          { arguments: JSON.stringify({ operation: 'capture', transcript: newerManifest }) },
        ],
      }],
    }
    const found = scanSessionForTranscript(session) as { marker?: string } | null
    assert.ok(found)
    assert.equal(found.marker, 'NEW')
  })
})

// ─── TRIAGE_VERDICTS as the verdict source of truth ─────────────────────────

describe('TRIAGE_VERDICTS as the verdict source of truth', () => {
  it('lists exactly the three triage verdicts every shortcut maps into', () => {
    assert.deepEqual([...TRIAGE_VERDICTS], ['keep', 'skip', 'ignore'])
    for (const v of Object.values(VERDICT_SHORTCUTS)) {
      assert.ok(TRIAGE_VERDICTS.includes(v))
    }
  })

  it('keyToVerdict rejects shortcut entries outside TRIAGE_VERDICTS', () => {
    const shortcuts = VERDICT_SHORTCUTS as Record<string, string>
    shortcuts.bogus_key = 'bogus'
    try {
      assert.equal(keyToVerdict('bogus_key'), null)
    } finally {
      delete shortcuts.bogus_key
    }
    // The genuine mappings still resolve after the guard.
    assert.equal(keyToVerdict('y'), 'keep')
    assert.equal(keyToVerdict('n'), 'skip')
    assert.equal(keyToVerdict('a'), 'ignore')
    assert.equal(keyToVerdict('x'), null)
  })

  it('batchSetVerdict and setAllVerdicts share the same validation', () => {
    const state: Record<string, 'keep' | 'skip' | 'ignore'> = { '0': 'keep' }
    assert.equal(batchSetVerdict(state, [0], 'bogus' as 'keep' | 'skip' | 'ignore'), state)
    assert.equal(setAllVerdicts(state, 'bogus' as 'keep' | 'skip' | 'ignore'), state)
    assert.deepEqual(setAllVerdicts(state, 'skip'), { '0': 'skip' })
    assert.deepEqual(countVerdicts(setAllVerdicts(state, 'ignore')), { keep: 0, skip: 0, ignore: 1 })
  })
})

// ─── Command-center normalizers (edge inputs) ───────────────────────────────

describe('command-center normalizers (edge inputs)', () => {
  it('computeSummaryFromFindings tolerates empty, junk and non-array input', () => {
    // `byDimension` is a null-prototype map (prototype-pollution guard), so the
    // deep-equalities below compare plain-object copies of it.
    const empty = { totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, byDimension: {} }
    const plain = (s: any) => ({ ...s, byDimension: { ...s.byDimension } })
    assert.deepEqual(plain(computeSummaryFromFindings([] as unknown as Record<string, unknown>[])), empty)
    assert.deepEqual(plain(computeSummaryFromFindings({} as unknown as Record<string, unknown>[])), empty)

    const junk = computeSummaryFromFindings(
      [null, 42, 'x', { severity: 'high', dimension: 'security' }, { severity: 'blocker' }] as unknown as Record<string, unknown>[],
    )
    assert.equal(junk.totalFindings, 5) // length counts every element…
    assert.equal(junk.high, 1) // …while junk is skipped for severity
    assert.equal(junk.critical, 0)
    assert.deepEqual({ ...junk.byDimension }, { security: 1, unknown: 1 })
    // …and the map must not inherit Object.prototype keys (a `__proto__`
    // finding would otherwise have been able to write to it).
    assert.equal(Object.getPrototypeOf(junk.byDimension), null)
    assert.equal((junk.byDimension as any).constructor, undefined)
  })

  it('normalizeQualityGateSnapshot degrades null / junk fields to defaults', () => {
    const empty = normalizeQualityGateSnapshot(null) as Record<string, any>
    assert.equal(empty.overallStatus, 'pending')
    assert.equal(empty.overallScore, 0)
    assert.equal(empty.failReason, null)
    assert.deepEqual(empty.dimensions, [])

    const junk = normalizeQualityGateSnapshot({
      overallStatus: 'bogus',
      overallScore: 'high',
      verificationPassRate: Number.NaN,
      totalFindings: 7,
      dimensions: [null, 'x', { dimension: 'correctness', score: 3, status: 'bogus' }],
    }) as Record<string, any>
    assert.equal(junk.overallStatus, 'pending')
    assert.equal(junk.overallScore, 0)
    assert.equal(junk.verificationPassRate, 0)
    assert.equal(junk.totalFindings, 7)
    assert.equal(junk.dimensions.length, 3)
    assert.deepEqual(junk.dimensions[0], { dimension: '', convergenceRate: 0, findingsCount: 0, fixedCount: 0, score: 0, status: 'warn' })
    assert.equal(junk.dimensions[2].dimension, 'correctness')
    assert.equal(junk.dimensions[2].score, 3)
    assert.equal(junk.dimensions[2].status, 'warn') // unknown status degrades to warn
  })

  it('normalizeExperienceBankResult tolerates junk entries and field types', () => {
    const empty = normalizeExperienceBankResult(null) as Record<string, any>
    assert.equal(empty.operation, '')
    assert.equal(empty.count, 0)
    assert.equal(empty.added, false)
    assert.deepEqual(empty.entries, [])

    const junk = normalizeExperienceBankResult({
      operation: 'list',
      count: 'two',
      added: 1,
      entries: [null, 'x', { id: 'e1', hitCount: 'many', files: [1, 'a'], tags: null }],
    }) as Record<string, any>
    assert.equal(junk.count, 0)
    assert.equal(junk.added, false)
    assert.equal(junk.entries.length, 3)
    assert.deepEqual(junk.entries[0], {
      id: '', timestamp: '', dimension: '', pattern: '', description: '',
      verifiedFix: '', findingSummary: '', severity: '', hitCount: 0,
      lastHitAt: null, files: [], tags: [],
    })
    assert.equal(junk.entries[2].id, 'e1')
    assert.equal(junk.entries[2].hitCount, 0)
    assert.deepEqual(junk.entries[2].files, ['', 'a'])
    assert.deepEqual(junk.entries[2].tags, [])

    // A `get`/`add` result with a junk entry degrades to an empty list.
    const noEntry = normalizeExperienceBankResult({ operation: 'get', entry: null }) as Record<string, any>
    assert.deepEqual(noEntry.entries, [])
  })

  it('normalizeDefenseEventsResult tolerates junk counts and event elements', () => {
    const empty = normalizeDefenseEventsResult(null) as Record<string, any>
    assert.equal(empty.operation, '')
    assert.equal(empty.count, 0)
    assert.deepEqual(empty.counts, { precondition_failed: 0, rollback: 0, invariant_violated: 0, assumption_falsified: 0 })
    assert.deepEqual(empty.events, [])

    const junk = normalizeDefenseEventsResult({
      operation: 'list',
      count: 'many',
      counts: { rollback: -1, invariant_violated: 'x', precondition_failed: 2, bogus_type: 9 },
      events: [null, 'x', { id: 'd1', round: '2', type: 'rollback', line: 0 }],
    }) as Record<string, any>
    assert.equal(junk.count, 0)
    // Negative / non-numeric counts degrade to 0; unknown keys are dropped.
    assert.deepEqual(junk.counts, { precondition_failed: 2, rollback: 0, invariant_violated: 0, assumption_falsified: 0 })
    assert.equal(junk.events.length, 3)
    assert.equal(junk.events[0].type, '')
    assert.equal(junk.events[2].round, 0)
    assert.equal(junk.events[2].line, null) // line 0 is not a usable position
  })
})

// ═══ Gap-fix helpers ═══════════════════════════════════════════════════════
//
// These lock the copy-to-instruction contract: every paste-able payload the
// client generates must match the target tool's parameter schema, and the
// startup text must be an instruction (dsh exposes NO command API to plugins,
// so a `/iterate` slash command can never exist).

/** Extract the first ```json fenced block from an instruction, if any. */
function jsonBlockOf(text: string): Record<string, unknown> | null {
  const m = /```json\n([\s\S]*?)```/.exec(text)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1]!)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ─── #1 startup instructions ────────────────────────────────────────────────

describe('startup instructions (gap #1)', () => {
  it('are natural-language instructions, never slash commands', () => {
    // `src/index.ts` registers 17 tools + a system prompt only; there is no
    // command registry, so a copied `/iterate` would paste into a command that
    // does not exist.
    for (const text of [START_INSTRUCTION_FULL, START_INSTRUCTION_REVIEW_ONLY]) {
      assert.ok(text.trim().length > 0)
      assert.ok(!text.startsWith('/'), `startup copy must not look like a slash command: ${text.slice(0, 40)}`)
      assert.match(text, /workflow/, 'must route through the `workflow` tool the skill prompt teaches')
    }
  })

  it('the registered set exposes both modes', () => {
    assert.equal(START_INSTRUCTIONS.full, START_INSTRUCTION_FULL)
    assert.equal(START_INSTRUCTIONS.reviewOnly, START_INSTRUCTION_REVIEW_ONLY)
    assert.match(START_INSTRUCTION_FULL, /"normal"/)
    assert.match(START_INSTRUCTION_REVIEW_ONLY, /"dry-run"/)
  })

  it('the full instruction preflights validation.commands', () => {
    // The full-loop CTA is the one place a first-time user is guaranteed to
    // read; it must surface the zero-verification hazard (gap #2's client half).
    assert.match(START_INSTRUCTION_FULL, /validation\.commands/)
    assert.match(START_INSTRUCTION_FULL, /iterate_config/)
  })
})

// ─── #5 dashboard run state ─────────────────────────────────────────────────

describe('dashboardRunState (gap #5)', () => {
  it('reports empty when there is no manifest at all', () => {
    assert.deepEqual(dashboardRunState(null), { state: 'empty', round: 0, phase: '', stoppedReason: '' })
    assert.equal(dashboardRunState(undefined).state, 'empty')
    assert.equal(dashboardRunState('junk').state, 'empty')
  })

  it('reports running (with round + phase) while the run is active', () => {
    const state = dashboardRunState({ active: true, round: 2, maxRounds: 5, phases: ['plan', 'review'] })
    assert.equal(state.state, 'running')
    assert.equal(state.round, 2)
    assert.equal(state.phase, 'review')
    assert.equal(state.stoppedReason, '')
  })

  it('reports done once the run is no longer active', () => {
    const state = dashboardRunState({ active: false, round: 3, phases: ['report'], stoppedReason: 'converged' })
    assert.equal(state.state, 'done')
    assert.equal(state.round, 3)
    assert.equal(state.stoppedReason, 'converged')
    assert.equal(state.phase, 'report')
  })

  it('clamps a junk round to 1 instead of rendering Round 0', () => {
    assert.equal(dashboardRunState({ active: true, round: 'nope' }).round, 1)
    assert.equal(dashboardRunState({ active: true, round: -4 }).round, 1)
  })
})

// ─── #6 validations normalization ───────────────────────────────────────────

describe('validations contract (gap #6)', () => {
  it('keeps only well-formed rows and drops junk', () => {
    const rows = normalizeValidations([
      { round: 2, command: 'npm test', exitCode: 1, allowed: false, rejectReason: 'unit failures' },
      { round: '3', command: 'npm run lint', exitCode: 0, allowed: true },
      { round: 0, command: '', allowed: false }, // no command → dropped
      null,
      'junk',
      { round: 1, command: 'npm run build', exitCode: 'x', allowed: false }, // exitCode → null
    ])
    assert.equal(rows.length, 3)
    assert.deepEqual(rows[0], { round: 2, command: 'npm test', exitCode: 1, allowed: false, rejectReason: 'unit failures' })
    assert.deepEqual(rows[1], { round: 3, command: 'npm run lint', exitCode: 0, allowed: true })
    assert.deepEqual(rows[2], { round: 1, command: 'npm run build', exitCode: null, allowed: false })
  })

  it('non-array input degrades to []', () => {
    assert.deepEqual(normalizeValidations(null), [])
    assert.deepEqual(normalizeValidations({}), [])
    assert.deepEqual(normalizeValidations('x'), [])
  })

  it('normalizeTranscript exposes the rows on the manifest', () => {
    const t = normalizeTranscript({
      active: true,
      validations: [{ round: 1, command: 'npm test', exitCode: 0, allowed: true }],
    }) as { validations: Array<Record<string, unknown>> }
    assert.equal(t.validations.length, 1)
    assert.equal(t.validations[0]!.command, 'npm test')
    // Absent field still yields an array (the UI branches on length, not null).
    assert.deepEqual((normalizeTranscript({}) as { validations: unknown[] }).validations, [])
  })

  it('an aborted_by_validation manifest keeps its reason so the UI can highlight', () => {
    const t = normalizeTranscript({ stoppedReason: 'aborted_by_validation' }) as { stoppedReason: string }
    assert.equal(t.stoppedReason, 'aborted_by_validation')
  })
})

// ─── #7 triage write-back loop ──────────────────────────────────────────────

describe('triage readback instruction (gap #7)', () => {
  it('names iterate_triage with operation list', () => {
    const text = buildTriageReadbackInstruction()
    assert.match(text, /iterate_triage/)
    assert.deepEqual(jsonBlockOf(text), { operation: 'list' })
  })

  it('the apply instruction still drives a validated write', () => {
    const text = buildApplyInstruction([{ file: 'src/a.ts', dimension: 'security', reason: 'r' }])
    assert.deepEqual(jsonBlockOf(text)?.operation, 'apply')
    assert.match(text, /iterate_triage/)
  })
})

// ─── #8 config fields + field instruction ───────────────────────────────────

describe('config field picker (gap #8)', () => {
  it('CONFIG_EDIT_FIELDS includes validation.commands with an explicit empty warning', () => {
    const field = configFieldByKey('validation.commands')
    assert.ok(field, 'validation.commands must be selectable in the settings UI')
    assert.match(field!.hint, /npm test/)
    assert.match(field!.hint, /不验证/)
  })

  it('also lists language and personalization.known_intentional', () => {
    assert.ok(configFieldByKey('language'))
    assert.ok(configFieldByKey('personalization.known_intentional'))
    assert.equal(configFieldByKey('nope'), null)
    assert.equal(configFieldByKey(''), null)
  })

  it('the guide warns about running with no verification commands', () => {
    const guide = buildConfigEditGuide()
    assert.match(guide, /validation\.commands/)
    assert.match(guide, /不被保护|不受任何测试保护/)
    assert.match(guide, /选字段/)
  })

  it('buildConfigFieldInstruction emits an iterate_config write payload', () => {
    const text = buildConfigFieldInstruction('max_rounds', 5)
    const payload = jsonBlockOf(text)
    assert.ok(payload)
    assert.equal(payload!.operation, 'write')
    assert.deepEqual((payload!.updates as Record<string, unknown>).max_rounds, 5)
    assert.match(text, /iterate_config/)
    assert.match(text, /备份/)
  })

  it('omitted values become an explicit model-filled placeholder', () => {
    const payload = jsonBlockOf(buildConfigFieldInstruction('validation.commands'))
    assert.deepEqual(payload!.updates, { 'validation.commands': CONFIG_VALUE_PLACEHOLDER })
    assert.match(CONFIG_VALUE_PLACEHOLDER, /由模型填写/)
  })

  it('every listed field round-trips through the instruction builder', () => {
    for (const f of CONFIG_EDIT_FIELDS) {
      const payload = jsonBlockOf(buildConfigFieldInstruction(f.key))
      assert.ok(payload, `no payload for ${f.key}`)
      assert.deepEqual(Object.keys(payload!.updates as object), [f.key])
      assert.match(buildConfigFieldInstruction(f.key), new RegExp(f.key.replace(/\./g, '\\.')))
    }
  })
})

// ─── #10 instruction payloads vs tool schemas ───────────────────────────────

describe('instruction payloads match tool schemas (gap #10)', () => {
  const requiredFixParams = ['file', 'content', 'finding', 'round']

  it('buildFixInstruction carries all four required iterate_fix params', () => {
    const text = buildFixInstruction(makeFinding())
    const payload = jsonBlockOf(text)
    assert.ok(payload, 'must emit a JSON call block')
    for (const p of requiredFixParams) assert.ok(p in payload!, `missing required param ${p}`)
    // …and the two model-supplied ones are explicitly placeholders.
    assert.match(String(payload!.content), /由模型填写/)
    assert.deepEqual(payload!.round, '<由模型填写：当前迭代轮次（≥1 的整数）>')
    assert.match(text, /iterate_fix/)
    assert.match(text, /force/)
  })

  it('buildFixInstruction fills round when the UI knows it', () => {
    const payload = jsonBlockOf(buildFixInstruction(makeFinding(), { round: 3 }))
    assert.equal(payload!.round, 3)
  })

  it('buildFixInstruction refuses a finding without a file', () => {
    assert.equal(buildFixInstruction({ summary: 'x' }), '')
  })

  it('buildAssignFixesInstruction says one call per finding (no array param)', () => {
    const text = buildAssignFixesInstruction([makeFinding(), makeFinding({ file: 'src/b.ts' })])
    assert.match(text, /iterate_fix/)
    assert.match(text, /一次/)
    assert.match(text, /一个/, 'must state that iterate_fix takes exactly one finding')
    const block = jsonBlockOf(text)
    assert.ok(Array.isArray(block), 'the payload is a LIST of findings, not a fake single call')
    assert.equal((block as unknown as unknown[]).length, 2)
    assert.ok(!('content' in (block as object)), 'an array payload cannot carry content — hence the staged text')
  })

  it('buildAssignFixesInstruction returns empty for no findings', () => {
    assert.equal(buildAssignFixesInstruction([]), '')
    assert.equal(buildAssignFixesInstruction([null] as never), '')
  })

  it('buildArchitecturalFixInstruction keeps force:true but lists required params', () => {
    const text = buildArchitecturalFixInstruction([makeFinding()])
    assert.match(text, /force/)
    for (const p of requiredFixParams) assert.ok(text.includes(p), `missing ${p}`)
    assert.match(text, /iterate_fix/)
  })

  it('checkpoint resume/clear payloads carry ONLY the operation', () => {
    // `maxRounds`/`mode`/`round` are save-side inputs; `maxRounds: null` was
    // an invalid-integer field on a positive-integer schema.
    assert.deepEqual(jsonBlockOf(buildCheckpointResumeInstruction()), { operation: 'resume' })
    assert.deepEqual(jsonBlockOf(buildCheckpointClearInstruction()), { operation: 'clear' })
    assert.match(buildCheckpointResumeInstruction(), /iterate_checkpoint/)
  })

  it('quality-gate query/clear payloads carry an operation enum value', () => {
    assert.deepEqual(jsonBlockOf(buildQualityGateQueryInstruction()), { operation: 'read' })
    assert.deepEqual(jsonBlockOf(buildQualityGateClearInstruction()), { operation: 'clear' })
    assert.match(buildQualityGateQueryInstruction(), /iterate_quality_gate/)
  })

  it('rollback payload is exactly { id }', () => {
    assert.deepEqual(jsonBlockOf(buildRollbackInstruction('fix-7')), { id: 'fix-7' })
    assert.match(buildRollbackInstruction('fix-7'), /iterate_rollback/)
  })

  it('experience / defense-events list payloads use their operations', () => {
    assert.deepEqual(jsonBlockOf(buildExperienceListInstruction()), { operation: 'list' })
    assert.deepEqual(jsonBlockOf(buildDefenseEventsListInstruction()), { operation: 'list' })
    assert.match(buildExperienceListInstruction(), /iterate_experience/)
    assert.match(buildDefenseEventsListInstruction(), /iterate_defense_events/)
  })
})

// ─── #11 export extras ──────────────────────────────────────────────────────

describe('serializeObservatoryExport extras (gap #11)', () => {
  it('includes the four on-disk artifacts when supplied', () => {
    const extras = {
      qualityGate: { overallStatus: 'pass' },
      experienceBank: { entries: [] },
      defenseEvents: { counts: {} },
      report: { findings: [] },
    }
    const parsed = JSON.parse(serializeExportWithExtras({ version: 1 }, [], extras)) as Record<string, unknown>
    for (const key of EXPORT_EXTRA_KEYS) assert.ok(key in parsed, `missing ${key} in export`)
    assert.deepEqual(parsed.qualityGate, extras.qualityGate)
    assert.deepEqual(parsed.report, extras.report)
  })

  it('stays shape-stable when extras are absent / partial / undefined', () => {
    const bare = JSON.parse(serializeExportWithExtras({ version: 1 }, [])) as Record<string, unknown>
    for (const key of EXPORT_EXTRA_KEYS) assert.ok(!(key in bare), `${key} must be omitted, not null, when unknown`)
    const partial = JSON.parse(
      serializeExportWithExtras(null, [], { qualityGate: null, report: undefined, experienceBank: 'junk' } as never),
    ) as Record<string, unknown>
    assert.ok('qualityGate' in partial, 'explicit null is preserved')
    assert.ok(!('report' in partial), 'undefined is dropped')
    assert.equal(partial.experienceBank, 'junk')
    assert.ok(!('defenseEvents' in partial))
  })

  it('ignores unknown extra keys and non-object extras', () => {
    const parsed = JSON.parse(
      serializeExportWithExtras({}, [], { evil: 1, qualityGate: { ok: true } } as never),
    ) as Record<string, unknown>
    assert.ok(!('evil' in parsed))
    assert.deepEqual(JSON.parse(serializeExportWithExtras({}, [], 'junk' as never)), JSON.parse(serializeExportWithExtras({}, [], undefined)))
  })

  it('keeps the cyclic fallback', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = JSON.parse(serializeExportWithExtras(cyclic, [], { report: cyclic })) as { manifest: unknown }
    assert.equal(parsed.manifest, null)
  })
})

// ─── #13 cross-round comparison ─────────────────────────────────────────────

describe('buildRoundComparison (gap #13)', () => {
  const report = {
    findings: [
      { round: 1, severity: 'high', status: 'fixed' },
      { round: 1, severity: 'critical', status: 'open' },
      { round: 2, severity: 'high', status: 'fixed' },
      { severity: 'low', status: 'open' }, // round 0 → dropped
    ],
  }

  it('builds one sorted row per round', () => {
    const rows = buildRoundComparison(report, [])
    assert.deepEqual(rows.map((r) => r.round), [1, 2])
    assert.equal(rows[0]!.findings, 2)
    assert.equal(rows[0]!.fixed, 1)
    assert.deepEqual(rows[0]!.severities, { high: 1, critical: 1 })
    assert.deepEqual(rows[1]!.severities, { high: 1 })
    assert.deepEqual(rows[0]!.validations, [])
  })

  it('merges validation rows into the matching round', () => {
    const rows = buildRoundComparison(report, [
      { round: 1, command: 'npm test', exitCode: 1, allowed: false },
      { round: 2, command: 'npm test', exitCode: 0, allowed: true },
      { round: 4, command: 'npm run lint', exitCode: 0, allowed: true },
    ])
    assert.deepEqual(rows.map((r) => r.round), [1, 2, 4])
    assert.equal(rows[0]!.validations[0]!.allowed, false)
    assert.equal(rows[1]!.validations[0]!.allowed, true)
    assert.equal(rows[2]!.findings, 0)
    assert.equal(rows[2]!.fixed, 0)
  })

  it('tolerates junk report / validations', () => {
    assert.deepEqual(buildRoundComparison(null, null), [])
    assert.deepEqual(buildRoundComparison({}, 'x' as never), [])
    const rows = buildRoundComparison({ findings: [null, 42, 'x'] } as never, [null, 'y'] as never)
    // Junk findings still count (length semantics match the summary builder)
    // but no round>0 rows are produced without a usable round.
    assert.deepEqual(rows, [])
  })
})

// ─── #4 disk snapshot pull ──────────────────────────────────────────────────

describe('disk snapshot pull instruction (gap #4)', () => {
  it('lists every read-side tool with its JSON args', () => {
    const text = buildDiskSnapshotInstruction()
    for (const src of DISK_SNAPSHOT_SOURCES) {
      assert.ok(text.includes(src.tool), `${src.tool} missing from the pull instruction`)
      assert.ok(text.includes(JSON.stringify(src.args)), `args missing for ${src.tool}`)
    }
    assert.match(text, /完整返回结果/)
  })

  it('covers the four panel data sources plus status + history', () => {
    const tools = DISK_SNAPSHOT_SOURCES.map((s) => s.tool)
    for (const t of [
      'iterate_status',
      'iterate_transcript',
      'iterate_quality_gate',
      'iterate_experience',
      'iterate_defense_events',
      'iterate_history',
    ]) assert.ok(tools.includes(t as never), `${t} must be pullable`)
  })

  it('separates "not pulled" from "pulled and empty"', () => {
    assert.match(diskEmptyStateText(false, '质量门禁证书'), /尚未从磁盘拉取质量门禁证书/)
    assert.match(diskEmptyStateText(false, '质量门禁证书'), /拉取磁盘快照/)
    assert.match(diskEmptyStateText(true, '质量门禁证书'), /已从磁盘拉取/)
    assert.match(diskEmptyStateText(true, '质量门禁证书'), /磁盘无数据/)
    assert.match(diskEmptyStateText(true, ''), /已从磁盘拉取：数据/)
  })

  it('toolCalledInSession detects a tool call in either session shape', () => {
    assert.equal(toolCalledInSession({ toolCalls: [{ tool: 'iterate_quality_gate' }] }, 'iterate_quality_gate'), true)
    assert.equal(toolCalledInSession({ toolCalls: [{ tool: 'other' }] }, 'iterate_quality_gate'), false)
    assert.equal(
      toolCalledInSession({ messages: [{ tool_calls: [{ function: { name: 'iterate_experience' } }] }] }, 'iterate_experience'),
      true,
    )
    assert.equal(
      toolCalledInSession({ messages: [{ tool_calls: [{ name: 'iterate_defense_events' }] }] }, 'iterate_defense_events'),
      true,
    )
    assert.equal(toolCalledInSession(null, 'iterate_status'), false)
    assert.equal(toolCalledInSession({}, ''), false)
    assert.equal(toolCalledInSession('junk', 'iterate_status'), false)
  })
})

// ─── prototype-pollution guards ─────────────────────────────────────────────

describe('dimension maps are prototype-pollution safe', () => {
  it('groupByDimension uses a null-prototype map', () => {
    const groups = groupByDimension({ findings: [{ dimension: 'constructor', severity: 'high' }] })
    assert.equal(Object.getPrototypeOf(groups), null)
    // A dimension literally named `constructor` is an OWN bucket, not
    // Object.prototype.constructor — `.constructor` returns the findings list.
    assert.deepEqual((groups as unknown as Record<string, unknown>).constructor, [
      { dimension: 'constructor', severity: 'high' },
    ])
    // A `__proto__` dimension becomes an own key, not a setter call.
    const proto = groupByDimension({ findings: [{ dimension: '__proto__', severity: 'low' }] })
    assert.deepEqual({ ...proto }, { ['__proto__']: [{ dimension: '__proto__', severity: 'low' }] })
  })

  it('computeSummaryFromFindings ignores inherited severity keys', () => {
    const sum = computeSummaryFromFindings([{ severity: 'constructor' }] as never)
    assert.equal(sum.critical, 0)
    assert.equal(sum.high, 0)
    assert.equal(Object.getPrototypeOf(sum.byDimension), null)
  })
})
