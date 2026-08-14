import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildFinalReviewReport,
  metaReviewReport,
  META_REVIEW_CHECKS,
} from '../src/meta-review.ts'
import { buildReviewReport } from '../src/review.ts'
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
})