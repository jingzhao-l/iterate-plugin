/**
 * Meta-review engine: review a ReviewReport and produce a final review report.
 *
 * This is the "纯反复审查" closing step: after the review loop converges on
 * zero new findings, we don't just trust the aggregated report — we audit the
 * report itself for internal consistency (counts, severity buckets, dimension
 * sums, sort order, convergence math). The result is a deterministic
 * `MetaReviewResult` plus a `FinalReviewReport` that pairs the source report
 * with a verdict.
 *
 * Like `review.ts`, this module contains NO I/O and NO agent spawning — it is
 * the pure, testable core. The workflow script (skill-prompt.ts) orchestrates
 * the actual subagent-driven meta-review critique; all deterministic math
 * lives here.
 */
import { sortFindings } from "./review.js";
/** Number of distinct consistency checks performed by `metaReviewReport`. */
export const META_REVIEW_CHECKS = 6;
/**
 * Audit a ReviewReport for internal consistency.
 *
 * Checks (all deterministic, no I/O):
 *  1. COUNT_MATCH: summary.totalFindings === findings.length
 *  2. SEVERITY_SUM: summary severity buckets (critical+high+medium+low) total
 *     to summary.totalFindings AND match the actual per-severity counts.
 *  3. DIMENSION_SUM: summary.byDimension values sum to totalFindings and every
 *     finding's dimension is present in report.dimensions.
 *  4. SORT_ORDER: findings are severity-sorted (most severe first).
 *  5. CONVERGENCE: findingsByRound sums to totalFindings and the `converged`
 *     flag is consistent with the last round's new-finding count.
 *  6. ROUND_SHAPE: every round has a positive round number; no round is
 *     missing from the sequence. A round with zero findings is only flagged
 *     when it is NOT the last round — an empty FINAL round means the review
 *     converged (the last pass found nothing new), which is the expected,
 *     successful termination of a dry-run, not a defect.
 *
 * Returns a MetaReviewResult; `passed` is true only when all checks pass.
 */
export function metaReviewReport(report) {
    const issues = [];
    const add = (code, severity, summary, detail) => {
        issues.push({ code, severity, summary, detail });
    };
    // Guard: a null/undefined report is a hard failure, not a crash.
    if (!report || typeof report !== 'object') {
        return {
            passed: false,
            verdict: 'revise',
            checksRun: META_REVIEW_CHECKS,
            issues: [
                {
                    code: 'REPORT_UNDEFINED',
                    severity: 'critical',
                    summary: 'Report is missing or not an object',
                    detail: 'metaReviewReport received no valid ReviewReport to audit.',
                },
            ],
        };
    }
    const findings = Array.isArray(report.findings) ? report.findings : [];
    const summary = report.summary ?? {};
    const total = Number(summary.totalFindings ?? 0);
    const dimensions = Array.isArray(report.dimensions) ? report.dimensions : [];
    // 1. COUNT_MATCH
    if (total !== findings.length) {
        add('COUNT_MATCH', 'high', `summary.totalFindings (${total}) does not match findings.length (${findings.length})`, `The report claims ${total} findings but lists ${findings.length}.`);
    }
    // 2. SEVERITY_SUM
    const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
        const s = f?.severity;
        if (s && s in sevCounts)
            sevCounts[s]++;
    }
    const bucketSum = sevCounts.critical + sevCounts.high + sevCounts.medium + sevCounts.low;
    const declaredSeveritySum = Number(summary.critical ?? 0) +
        Number(summary.high ?? 0) +
        Number(summary.medium ?? 0) +
        Number(summary.low ?? 0);
    if (declaredSeveritySum !== total || bucketSum !== total) {
        add('SEVERITY_SUM', 'high', 'Severity bucket counts are inconsistent with totalFindings', `declared buckets sum to ${declaredSeveritySum}, actual buckets sum to ${bucketSum}, ` +
            `but totalFindings is ${total}.`);
    }
    // 3. DIMENSION_SUM
    const byDim = summary.byDimension ?? {};
    let dimSum = 0;
    for (const v of Object.values(byDim))
        dimSum += Number(v) || 0;
    if (dimSum !== total) {
        add('DIMENSION_SUM', 'high', 'byDimension counts do not sum to totalFindings', `byDimension sums to ${dimSum}, but totalFindings is ${total}.`);
    }
    const invalidDim = findings.find((f) => !dimensions.includes(f?.dimension));
    if (invalidDim) {
        add('DIMENSION_UNKNOWN', 'medium', `Finding references unknown dimension "${invalidDim.dimension}"`, `dimension "${invalidDim.dimension}" is not in report.dimensions ` +
            `(${dimensions.join(', ') || 'none'}).`);
    }
    // 4. SORT_ORDER
    const sorted = sortFindings(findings);
    const isSorted = sorted.every((f, i) => f === findings[i]);
    if (!isSorted) {
        add('SORT_ORDER', 'low', 'Findings are not severity-sorted', 'findings should be ordered most-severe first (critical > high > medium > low).');
    }
    // 5. CONVERGENCE
    const findingsByRound = Array.isArray(report.convergence?.findingsByRound)
        ? report.convergence.findingsByRound
        : [];
    const convSum = findingsByRound.reduce((a, b) => a + Number(b) || 0, 0);
    if (convSum !== total) {
        add('CONVERGENCE_SUM', 'high', 'convergence.findingsByRound does not sum to totalFindings', `findingsByRound ${JSON.stringify(findingsByRound)} sums to ${convSum}, ` +
            `but totalFindings is ${total}.`);
    }
    // `findingsByRound` is indexed by the actual round number (round r → index
    // r-1), so the "last round" is the LAST RECORDED round's reported number, not
    // the array's last index (the array is sized to the highest round, which only
    // equals the record count for contiguous 1..N round numbers). Read the flag
    // consistency the same way buildReviewReport/computeConvergence set it.
    const reportRounds = Array.isArray(report.rounds) ? report.rounds : [];
    const lastRecordedRound = reportRounds.length > 0 && typeof reportRounds[reportRounds.length - 1]?.round === 'number'
        ? reportRounds[reportRounds.length - 1].round
        : null;
    const lastRoundNew = lastRecordedRound !== null && lastRecordedRound > 0
        ? Number(findingsByRound[lastRecordedRound - 1] ?? 0)
        : null;
    const expectedConverged = lastRoundNew === 0;
    if (report.convergence?.converged !== expectedConverged) {
        add('CONVERGENCE_FLAG', 'medium', 'convergence.converged flag is inconsistent with the last round', `last round reported ${lastRoundNew} new findings, so converged should be ` +
            `${expectedConverged}, but it is ${report.convergence?.converged}.`);
    }
    // 6. ROUND_SHAPE
    const rounds = Array.isArray(report.rounds) ? report.rounds : [];
    const seenRounds = new Set();
    for (const [index, r] of rounds.entries()) {
        if (!r || typeof r.round !== 'number' || r.round < 1) {
            add('ROUND_NUMBER', 'medium', 'A round has a missing or non-positive round number', `round: ${JSON.stringify(r)}`);
            continue;
        }
        seenRounds.add(r.round);
        const isLastRound = index === rounds.length - 1;
        if (!Array.isArray(r.findings) || (r.findings.length === 0 && !isLastRound)) {
            add('ROUND_EMPTY', 'low', `Round ${r.round} has no findings`, 'A recorded round should contain at least one finding — except a final converged round, ' +
                'which finding nothing new is the expected success signal.');
        }
    }
    for (let i = 1; i <= rounds.length; i++) {
        if (!seenRounds.has(i)) {
            add('ROUND_GAP', 'medium', `Round ${i} is missing from the round sequence`, `rounds present: ${[...seenRounds].sort((a, b) => a - b).join(', ') || 'none'}.`);
        }
    }
    const passed = issues.length === 0;
    return {
        passed,
        verdict: passed ? 'approved' : 'revise',
        checksRun: META_REVIEW_CHECKS,
        issues,
    };
}
/**
 * Build the final review report: pair the source report with its meta-review
 * verdict and a rolled-up summary. Pure and deterministic.
 *
 * `evidence` (an EvidenceAudit produced against the real repo) is the hard
 * code-evidence gate: every finding whose file/line does not resolve to
 * existing code is emitted as a critical EVIDENCE_VIOLATION and flips the
 * verdict to `needs_revision`. The audit itself reads the filesystem; this
 * function only folds the (pure, precomputed) result in.
 */
export function buildFinalReviewReport(report, opts = {}) {
    const meta = metaReviewReport(report);
    const evidence = opts.evidence ?? null;
    if (evidence !== null) {
        meta.checksRun += 1;
        if (evidence.results.some((r) => r.error !== undefined)) {
            for (const violation of evidence.results) {
                if (violation.error === undefined)
                    continue;
                const detail = violation.error === 'line_out_of_range'
                    ? `${violation.line} is beyond this file's ${violation.lineTotal} lines`
                    : `${violation.file} does not exist at all (verifiable read required)`;
                meta.issues.push({
                    code: 'EVIDENCE_VIOLATION',
                    severity: 'critical',
                    summary: `Finding references non-existent code: ${violation.file}` +
                        (violation.line ? `:${violation.line}` : ''),
                    detail: detail + '. Review results must anchor to real, read code.',
                });
            }
            meta.passed = false;
            meta.verdict = 'revise';
        }
    }
    const summary = report?.summary ?? {};
    const verdict = meta.passed ? 'approved' : 'needs_revision';
    return {
        verdict,
        source: report,
        metaReview: meta,
        summary: {
            totalFindings: Number(summary.totalFindings ?? 0),
            critical: Number(summary.critical ?? 0),
            high: Number(summary.high ?? 0),
            medium: Number(summary.medium ?? 0),
            low: Number(summary.low ?? 0),
            converged: Boolean(report?.convergence?.converged),
            totalRounds: Number(report?.convergence?.totalRounds ?? 0),
            reportIssues: meta.issues.length,
            verdict,
        },
    };
}
