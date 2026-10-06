import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildFinalReviewReport,
  metaReviewReport,
  MAX_REVIEW_ROUND_NUMBER,
  MAX_ROUND_GAP_REPORTS,
  META_REVIEW_CHECKS,
} from '../src/meta-review.ts'
import { buildReviewReport } from '../src/review.ts'
import type { EvidenceAudit } from '../src/evidence.ts'
import type { ReviewFinding, ReviewReport } from '../src/types.ts'

const f = (partial: Partial<ReviewFinding>): ReviewFinding => ({
  dimension: 'correctness',
  file: 'src/a.ts',
  severity: 'medium',
  summary: 'A problem',
  failure_scenario: 'fails when x happens',
  suggested_fix: 'do y instead',
  is_atomic: true,
  ...partial,
})

/** A well-formed, internally consistent report (dry-run, converged). */
function goodReport(): ReviewReport {
  return buildReviewReport({
    mode: 'dry-run',
    goal: 'Improve quality',
    dimensions: ['correctness', 'security'],
    maxReviewRounds: 3,
    rounds: [
      {
        round: 1,
        findings: [
          f({ dimension: 'security', severity: 'critical', summary: 'sql injection', line: 10 }),
          f({ dimension: 'correctness', severity: 'low', summary: 'typo', line: 20 }),
        ],
      },
      { round: 2, findings: [f({ dimension: 'security', severity: 'critical', summary: 'sql injection', line: 10 })] },
    ],
  })
}

describe('metaReviewReport', () => {
  it('passes a well-formed, converged report with zero issues', () => {
    const result = metaReviewReport(goodReport())
    assert.equal(result.passed, true)
    assert.equal(result.verdict, 'approved')
    assert.equal(result.checksRun, META_REVIEW_CHECKS)
    assert.deepEqual(result.issues, [])
  })

  it('detects a COUNT_MATCH failure when totalFindings != findings.length', () => {
    const report = goodReport()
    report.summary.totalFindings = report.findings.length + 1
    const result = metaReviewReport(report)
    assert.equal(result.passed, false)
    assert.equal(result.verdict, 'revise')
    assert.ok(result.issues.some((i) => i.code === 'COUNT_MATCH'))
  })

  it('detects a SEVERITY_SUM failure when severity buckets are inconsistent', () => {
    const report = goodReport()
    report.summary.low = report.summary.low + 5 // inflate low out of the real total
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'SEVERITY_SUM'))
  })

  it('detects a DIMENSION_SUM failure when byDimension does not sum to total', () => {
    const report = goodReport()
    report.summary.byDimension = { correctness: report.findings.length + 3 }
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'DIMENSION_SUM'))
  })

  it('detects a DIMENSION_UNKNOWN failure for a finding outside report.dimensions', () => {
    const report = goodReport()
    report.findings[0] = f({ dimension: 'nonsense', summary: 'bad dim' })
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'DIMENSION_UNKNOWN'))
  })

  it('detects a SORT_ORDER failure when findings are not severity-sorted', () => {
    const report = goodReport()
    // Swap the two findings so a low-severity appears before a critical one.
    const first = report.findings[0]!
    const second = report.findings[1]!
    report.findings[0] = second
    report.findings[1] = first
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'SORT_ORDER'))
  })

  it('detects a CONVERGENCE_FLAG failure when the flag disagrees with the last round', () => {
    const report = goodReport()
    report.convergence.converged = !report.convergence.converged
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'CONVERGENCE_FLAG'))
  })

  it('does NOT false-flag CONVERGENCE_FLAG for non-contiguous round reports', () => {
    // `findingsByRound` is index-by-round-number, so the flag must be checked
    // against the LAST RECORDED round's count (round 3 → index 2 = 1 new), which
    // matches buildReviewReport. ROUND_GAP may fire (the audit flags gaps), but
    // CONVERGENCE_FLAG must stay consistent with the report's own computation.
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness'],
      maxReviewRounds: 5,
      rounds: [
        { round: 1, findings: [f({ summary: 'first issue' })] },
        { round: 3, findings: [f({ summary: 'new issue in resumed round 3' })] },
      ],
    })
    const result = metaReviewReport(report)
    assert.equal(report.convergence.converged, false)
    assert.ok(!result.issues.some((i) => i.code === 'CONVERGENCE_FLAG'))
  })

  it('detects a ROUND_GAP failure when the round sequence skips a number', () => {
    const report = goodReport()
    report.rounds = [{ round: 1, findings: [f({ summary: 'r1' })] }, { round: 3, findings: [f({ summary: 'r3' })] }]
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'ROUND_GAP'))
  })

  it('does NOT flag ROUND_EMPTY for a final converged round with zero findings', () => {
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness', 'security'],
      maxReviewRounds: 3,
      rounds: [
        {
          round: 1,
          findings: [
            f({ dimension: 'security', severity: 'critical', summary: 'sql injection', line: 10 }),
            f({ dimension: 'correctness', severity: 'low', summary: 'typo', line: 20 }),
          ],
        },
        { round: 2, findings: [] }, // converged round: nothing new found
      ],
    })
    const result = metaReviewReport(report)
    // No ROUND_EMPTY / ROUND_GAP issue: an empty final round IS the convergence signal.
    assert.equal(result.passed, true)
    assert.equal(result.verdict, 'approved')
    assert.ok(!result.issues.some((i) => i.code === 'ROUND_EMPTY'))
    assert.ok(!result.issues.some((i) => i.code === 'ROUND_GAP'))
  })

  it('still flags ROUND_EMPTY for a non-final empty round', () => {
    const report = goodReport()
    report.rounds = [
      { round: 1, findings: [f({ summary: 'r1' })] },
      { round: 2, findings: [] }, // empty middle round, but a later round exists
      { round: 3, findings: [f({ summary: 'r3' })] },
    ]
    const result = metaReviewReport(report)
    assert.ok(result.issues.some((i) => i.code === 'ROUND_EMPTY'))
  })

  it('handles a null/undefined report without crashing', () => {
    const result = metaReviewReport(null as unknown as ReviewReport)
    assert.equal(result.passed, false)
    assert.equal(result.verdict, 'revise')
    assert.ok(result.issues.some((i) => i.code === 'REPORT_UNDEFINED'))
  })
})

describe('buildFinalReviewReport', () => {
  it('produces an approved final report for a consistent source', () => {
    const final = buildFinalReviewReport(goodReport())
    assert.equal(final.verdict, 'approved')
    assert.equal(final.metaReview.verdict, 'approved')
    assert.equal(final.summary.verdict, 'approved')
    assert.equal(final.summary.reportIssues, 0)
    assert.equal(final.summary.totalFindings, goodReport().summary.totalFindings)
    assert.equal(final.summary.converged, true)
  })

  it('produces needs_revision when the source report is inconsistent', () => {
    const report = goodReport()
    report.summary.totalFindings = report.findings.length + 1
    const final = buildFinalReviewReport(report)
    assert.equal(final.verdict, 'needs_revision')
    assert.equal(final.summary.verdict, 'needs_revision')
    assert.equal(final.summary.reportIssues, final.metaReview.issues.length)
    // The source report itself is preserved unchanged.
    assert.equal(final.source, report)
  })

  it('flips to needs_revision on evidence violation (hard gate, default on)', () => {
    const report = goodReport()
    const evidence: EvidenceAudit = {
      checked: 1,
      results: [
        {
          file: 'src/nope.ts',
          line: 12,
          lineTotal: null,
          resolvedPath: '/root/src/nope.ts',
          verified: false,
          error: 'file_not_found',
        },
      ],
    }
    const final = buildFinalReviewReport(report, { evidence })
    assert.equal(final.verdict, 'needs_revision')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue, 'expected an EVIDENCE_VIOLATION issue')
    assert.equal(issue!.severity, 'critical')
    assert.match(issue!.detail, /does not exist at all/)
  })

  it('flags line_out_of_range evidence as a critical violation', () => {
    const report = goodReport()
    const evidence: EvidenceAudit = {
      checked: 1,
      results: [
        {
          file: 'src/a.ts',
          line: 9999,
          lineTotal: 10,
          resolvedPath: '/root/src/a.ts',
          verified: false,
          error: 'line_out_of_range',
        },
      ],
    }
    const final = buildFinalReviewReport(report, { evidence })
    assert.equal(final.verdict, 'needs_revision')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.detail, /9999 is beyond/)
  })

  it('counts the evidence check when it runs', () => {
    const report = goodReport()
    const clean: EvidenceAudit = {
      checked: 1,
      results: [
        {
          file: 'src/a.ts',
          line: 10,
          lineTotal: 100,
          resolvedPath: '/root/src/a.ts',
          verified: true,
        },
      ],
    }
    const before = buildFinalReviewReport(report).metaReview.checksRun
    const after = buildFinalReviewReport(report, { evidence: clean })
    assert.equal(after.metaReview.checksRun, before + 1)
    assert.equal(after.verdict, 'approved')
  })

  it('skips the evidence gate when no evidence audit is supplied', () => {
    const report = goodReport()
    const final = buildFinalReviewReport(report, { evidence: null })
    assert.equal(final.verdict, 'approved')
    assert.ok(!final.metaReview.issues.some((i) => i.code === 'EVIDENCE_VIOLATION'))
  })

  it('emits COVERAGE_GAP (medium hint) but keeps the verdict when files are uncovered', () => {
    const report = goodReport()
    const coverage = {
      assigned: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      read: ['src/a.ts'],
      covered: ['src/a.ts'],
      uncovered: ['src/b.ts', 'src/c.ts'],
      ratio: 1 / 3,
    }
    const final = buildFinalReviewReport(report, { coverage })
    // Coverage is prompt-informative: it NEVER flips an otherwise-clean verdict.
    assert.equal(final.verdict, 'approved')
    const issue = final.metaReview.issues.find((i) => i.code === 'COVERAGE_GAP')
    assert.ok(issue, 'expected a COVERAGE_GAP issue')
    assert.equal(issue!.severity, 'medium')
    assert.match(issue!.summary, /2 of 3 scope files/)
    assert.match(issue!.detail, /Uncovered: src\/b\.ts, src\/c\.ts/)
  })

  it('counts the coverage check when it runs', () => {
    const report = goodReport()
    const before = buildFinalReviewReport(report).metaReview.checksRun
    const withCoverage = buildFinalReviewReport(report, { coverage: {
      assigned: ['src/a.ts'],
      read: ['src/a.ts'],
      covered: ['src/a.ts'],
      uncovered: [],
      ratio: 1,
    } })
    assert.equal(withCoverage.metaReview.checksRun, before + 1)
    assert.ok(!withCoverage.metaReview.issues.some((i) => i.code === 'COVERAGE_GAP'))
  })

  it('skips the coverage check when no coverage is supplied', () => {
    const report = goodReport()
    const final = buildFinalReviewReport(report, { coverage: null })
    assert.equal(final.verdict, 'approved')
    assert.ok(!final.metaReview.issues.some((i) => i.code === 'COVERAGE_GAP'))
  })

  it('attributes an EVIDENCE_VIOLATION to the round that first surfaced it', () => {
    const report = goodReport()
    const evidence: EvidenceAudit = {
      checked: 1,
      results: [
        {
          file: 'src/a.ts',
          line: 10,
          lineTotal: null,
          resolvedPath: '/root/src/a.ts',
          verified: false,
          error: 'line_out_of_range',
        },
      ],
    }
    const final = buildFinalReviewReport(report, { evidence })
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.summary, /\(round 1\)/)
  })

  it('surfaces the coverage result on the final report', () => {
    const report = goodReport()
    const coverage = {
      assigned: ['src/a.ts'],
      read: [],
      covered: [],
      uncovered: ['src/a.ts'],
      ratio: 0,
    }
    const final = buildFinalReviewReport(report, { coverage })
    assert.deepEqual(final.coverage, coverage)
  })
})
// ─── ROUND_GAP hardening (untrusted round numbers) ──────────────────────────

describe('ROUND_GAP enumeration bounds', () => {
  /** A report whose rounds list is exactly `rounds` (rest is well-formed). */
  function roundsOnly(rounds: ReviewReport['rounds']): ReviewReport {
    const report = goodReport()
    report.rounds = rounds
    return report
  }

  it('rejects an absurd round number instead of walking min..max (CPU DoS)', () => {
    // rounds {1, 1e15} previously drove `for (i = min; i <= max; i++)` for
    // ~1e15 iterations (and pushed one issue per missing round).
    const started = Date.now()
    const result = metaReviewReport(
      roundsOnly([{ round: 1, findings: [f({ summary: 'r1' })] }, { round: 1e15, findings: [f({ summary: 'huge' })] }]),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `gap audit took ${elapsed}ms`)
    assert.ok(result.issues.some((i) => i.code === 'ROUND_NUMBER'), 'absurd round is invalid, not a gap')
    assert.ok(!result.issues.some((i) => i.code === 'ROUND_GAP'), 'no enumeration over an absurd range')
    // …and an `Infinity` round must not hang either.
    const inf = metaReviewReport(
      roundsOnly([{ round: 1, findings: [f({ summary: 'r1' })] }, { round: Number.POSITIVE_INFINITY, findings: [] }]),
    )
    assert.ok(inf.issues.some((i) => i.code === 'ROUND_NUMBER'))
    assert.ok(!inf.issues.some((i) => i.code === 'ROUND_GAP'))
  })

  it('flags fractional / negative round numbers as ROUND_NUMBER', () => {
    const result = metaReviewReport(
      roundsOnly([
        { round: 1, findings: [f({ summary: 'r1' })] },
        { round: 1.5, findings: [f({ summary: 'half' })] },
        { round: -3, findings: [] },
      ]),
    )
    const roundNumbers = result.issues.filter((i) => i.code === 'ROUND_NUMBER')
    assert.equal(roundNumbers.length, 2, 'the 1.5 and -3 rounds are both invalid')
    // Only round 1 is present → no gap to report.
    assert.ok(!result.issues.some((i) => i.code === 'ROUND_GAP'))
  })

  it('caps the number of individual ROUND_GAP issues', () => {
    const report = roundsOnly([
      { round: 1, findings: [f({ summary: 'r1' })] },
      { round: 101, findings: [f({ summary: 'r101' })] },
    ])
    const result = metaReviewReport(report)
    const gaps = result.issues.filter((i) => i.code === 'ROUND_GAP')
    // 99 missing rounds, but only MAX_ROUND_GAP_REPORTS listed individually
    // plus one "+N more" summary issue.
    assert.equal(gaps.length, MAX_ROUND_GAP_REPORTS + 1)
    assert.ok(gaps.some((i) => /more rounds are missing/.test(i.summary)))
    assert.equal(result.checksRun, META_REVIEW_CHECKS)
  })

  it('collapses a range wider than MAX_ROUND_GAP_SPAN into a single issue', () => {
    const result = metaReviewReport(
      roundsOnly([
        { round: 1, findings: [f({ summary: 'r1' })] },
        { round: MAX_REVIEW_ROUND_NUMBER, findings: [f({ summary: 'last' })] },
      ]),
    )
    const gaps = result.issues.filter((i) => i.code === 'ROUND_GAP')
    assert.equal(gaps.length, 1)
    assert.match(gaps[0]!.summary, /too wide to audit/)
    // round 1000 is within the ceiling, so it is never called out as invalid.
    assert.ok(!result.issues.some((i) => i.code === 'ROUND_NUMBER'))
  })
})

// ─── convergence reads agree with the aggregation core ─────────────────────

describe('convergence checks agree with buildReviewReport', () => {
  it('does not false-flag CONVERGENCE_* for an over-cap (folded) round', () => {
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds: [
        { round: 1, findings: [f({ summary: 'first issue' })] },
        { round: 50, findings: [f({ summary: 'late issue' })] },
      ],
    })
    const result = metaReviewReport(report)
    assert.equal(report.convergence.converged, false)
    assert.ok(!result.issues.some((i) => i.code === 'CONVERGENCE_SUM'))
    assert.ok(!result.issues.some((i) => i.code === 'CONVERGENCE_FLAG'))
    // The gap between 1 and 50 is real and still reported (bounded).
    assert.ok(result.issues.some((i) => i.code === 'ROUND_GAP'))
  })

  it('does not false-flag CONVERGENCE_FLAG when a trailing round is fractional', () => {
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds: [
        { round: 1, findings: [f({ summary: 'real issue' })] },
        { round: 1.5, findings: [f({ summary: 'real issue' })] },
      ],
    })
    const result = metaReviewReport(report)
    // `Math.min(1.5, len) - 1` is fractional → used to read `undefined` → 0 new
    // → expectedConverged flipped against the report's own flag.
    assert.equal(report.convergence.converged, false)
    assert.ok(!result.issues.some((i) => i.code === 'CONVERGENCE_FLAG'), JSON.stringify(result.issues))
    assert.ok(result.issues.some((i) => i.code === 'ROUND_NUMBER'), 'the 1.5 round is still reported')
  })

  it('findingsByRound sums to totalFindings for every report the core builds', () => {
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds: [
        { round: 1, findings: [f({ summary: 'a' })] },
        { round: 2, findings: [f({ summary: 'b' })] },
        { round: 77, findings: [f({ summary: 'c' })] },
      ],
    })
    const sum = report.convergence.findingsByRound.reduce((a, b) => a + b, 0)
    assert.equal(sum, report.summary.totalFindings)
    const result = metaReviewReport(report)
    assert.ok(!result.issues.some((i) => i.code === 'CONVERGENCE_SUM'))
  })
})

// ─── evidence violation detail distinguishes the new error codes ────────────

describe('EVIDENCE_VIOLATION detail per error code', () => {
  function withError(partial: Partial<{ file: string; line: number | null; lineTotal: number | null }>, error: string) {
    const report = goodReport()
    return buildFinalReviewReport(report, {
      evidence: {
        checked: 1,
        results: [
          {
            file: partial.file ?? 'src/a.ts',
            line: partial.line ?? null,
            lineTotal: partial.lineTotal ?? null,
            resolvedPath: '/root/src/a.ts',
            verified: false,
            error: error as 'file_not_found',
          },
        ],
      },
    })
  }

  it('describes a too-large file as too large, not as missing code', () => {
    const final = withError({ file: 'src/big.ts' }, 'file_too_large')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.detail, /too large to line-address/)
    assert.doesNotMatch(issue!.detail, /does not exist at all/)
    assert.match(issue!.summary, /cannot be anchored/)
    assert.equal(final.verdict, 'needs_revision')
  })

  it('describes a binary file as binary, not as missing code', () => {
    const final = withError({ file: 'src/blob.bin' }, 'binary_file')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.detail, /binary \(NUL-containing\)/)
    assert.doesNotMatch(issue!.detail, /does not exist at all/)
    assert.match(issue!.summary, /src\/blob\.bin/)
    assert.equal(final.verdict, 'needs_revision')
  })

  it('describes a directory / device target as not line-addressable', () => {
    const final = withError({ file: 'src' }, 'line_out_of_range')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.detail, /not a regular line-addressable file/)
  })

  it('still reports a plain out-of-range line with its line count', () => {
    const final = withError({ file: 'src/a.ts', line: 9999, lineTotal: 10 }, 'line_out_of_range')
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
    assert.match(issue!.detail, /9999 is beyond this file's 10 lines/)
    assert.match(issue!.summary, /non-existent code/)
  })

  it('survives a null round entry while attributing the round', () => {
    const report = goodReport()
    report.rounds = [null as unknown as ReviewReport['rounds'][number], ...report.rounds]
    const final = buildFinalReviewReport(report, {
      evidence: {
        checked: 1,
        results: [
          {
            file: 'src/a.ts',
            line: 10,
            lineTotal: null,
            resolvedPath: '/root/src/a.ts',
            verified: false,
            error: 'line_out_of_range',
          },
        ],
      },
    })
    const issue = final.metaReview.issues.find((i) => i.code === 'EVIDENCE_VIOLATION')
    assert.ok(issue)
  })
})
