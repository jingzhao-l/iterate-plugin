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
import { isValidRoundNumber, sortFindings } from "./review.js";
/**
 * Number of distinct consistency checks performed by `metaReviewReport`.
 * The check set is: COUNT_MATCH, SEVERITY_SUM, DIMENSION_SUM, DIMENSION_UNKNOWN,
 * SORT_ORDER, CONVERGENCE_SUM, CONVERGENCE_FLAG, ROUND_NUMBER, ROUND_EMPTY,
 * ROUND_GAP.
 */
export const META_REVIEW_CHECKS = 10;
/**
 * How many uncovered scope files are listed in a COVERAGE_GAP hint before the
 * remainder is folded into a "+N more" suffix.
 */
export const COVERAGE_LIST_TRUNCATE = 10;
/**
 * Hard sanity ceiling on a reported round number.
 *
 * `rounds[].round` is model/JSON-authored and only needs to be a number to
 * reach this audit. Round-gap detection enumerates `min..max` of the PRESENT
 * round numbers, so an absurd value (rounds `{1, 1e15}` or a round of
 * `Infinity`) used to turn a linear check into an effectively-infinite loop —
 * a trivial CPU/memory denial of service (and one ROUND_GAP issue per missing
 * round). Anything above this ceiling is rejected as an invalid round
 * (ROUND_NUMBER) and excluded from gap enumeration instead of being walked.
 * Generously above any real run: `config.max_rounds` is capped at 100.
 */
export const MAX_REVIEW_ROUND_NUMBER = 1000;
/**
 * Max individual ROUND_GAP issues emitted per audit. The remainder is folded
 * into a single "+N more" issue so a wide-but-legal gap can never flood the
 * issue list (each issue carries a detail string).
 */
export const MAX_ROUND_GAP_REPORTS = 50;
/**
 * Hard bound on the round-gap enumeration span. Below
 * MAX_REVIEW_ROUND_NUMBER on purpose: even a legal range (e.g. round 1 plus
 * round 1000) is too wide for per-number gap reporting to mean anything, so
 * it collapses to ONE "range too wide" issue instead of ~1000 iterations and
 * ~1000 issues. Together with the round-number ceiling this makes the
 * enumeration O(MAX_ROUND_GAP_SPAN) no matter what reaches it.
 */
export const MAX_ROUND_GAP_SPAN = 500;
/** Bounded, non-throwing list preview for issue detail strings. */
function previewList(values, max = 20) {
    const shown = values
        .slice(0, max)
        .map((v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '[object]'))
        .join(', ');
    return values.length > max ? `${shown}, … (+${values.length - max} more)` : shown;
}
/** Bounded, non-throwing object preview (a hostile round may be circular). */
function previewRound(r) {
    if (r === null || typeof r !== 'object')
        return String(r);
    const roundNo = r.round;
    const findings = r.findings;
    return `{round: ${String(roundNo)}, findings: ${Array.isArray(findings) ? `array(${findings.length})` : typeof findings}}`;
}
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
        // hasOwn, not `in`: `'__proto__' in sevCounts` is true via inheritance,
        // and an out-of-spec severity must simply not be bucketed.
        if (s && Object.hasOwn(sevCounts, s))
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
    const invalidDim = findings.find((f) => !!f && !dimensions.includes(f?.dimension));
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
        add('CONVERGENCE_SUM', 'high', 'convergence.findingsByRound does not sum to totalFindings', `findingsByRound [${previewList(findingsByRound)}] sums to ${convSum}, ` +
            `but totalFindings is ${total}.`);
    }
    // `findingsByRound` is indexed by the actual round number (round r → index
    // r-1), so the "last round" is the HIGHEST VALID round number, not the
    // array's last element (buildReviewReport sorts its round list, but this
    // audit runs on arbitrary JSON, and a malformed trailing round — `1.5`,
    // `Infinity` — must not be used as an index: Math.min(1.5, len) - 1 is
    // fractional and reads `undefined` → 0 new → a false CONVERGENCE_FLAG).
    const reportRounds = Array.isArray(report.rounds) ? report.rounds : [];
    let lastRecordedRound = null;
    for (const r of reportRounds) {
        if (!r || typeof r !== 'object' || !isValidRoundNumber(r.round))
            continue;
        if (lastRecordedRound === null || r.round > lastRecordedRound)
            lastRecordedRound = r.round;
    }
    const lastRoundNew = lastRecordedRound !== null && lastRecordedRound > 0
        // Over-cap rounds are FOLDED by aggregateRounds into the final slot, so a
        // reported round number may exceed the array length — read the SAME
        // clamped index buildReviewReport/computeConvergence use, or a real
        // over-cap round would be mis-read as 0 new (flag mismatch).
        ? Number(findingsByRound[Math.min(lastRecordedRound, findingsByRound.length) - 1] ?? 0)
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
        // Reject everything the deterministic core would refuse: a missing,
        // non-integer, non-finite or absurdly large round number. This is also
        // the DoS guard for ROUND_GAP below — a round of `Infinity`/1e15 would
        // otherwise be treated as a legitimate endpoint of the enumeration range.
        if (!r ||
            typeof r !== 'object' ||
            !isValidRoundNumber(r.round) ||
            r.round > MAX_REVIEW_ROUND_NUMBER) {
            add('ROUND_NUMBER', 'medium', 'A round has a missing, non-integer or out-of-range round number', `round: ${previewRound(r)} (round numbers must be integers in 1..${MAX_REVIEW_ROUND_NUMBER})`);
            continue;
        }
        seenRounds.add(r.round);
        const isLastRound = index === rounds.length - 1;
        if (!Array.isArray(r.findings) || (r.findings.length === 0 && !isLastRound)) {
            add('ROUND_EMPTY', 'low', `Round ${r.round} has no findings`, 'A recorded round should contain at least one finding — except a final converged round, ' +
                'which finding nothing new is the expected success signal.');
        }
    }
    // ROUND_GAP: only flag gaps WITHIN the range of actually-present round
    // numbers. Non-contiguous starts (e.g. a resumed run beginning at round 5)
    // and arbitrary round numbering are supported by the aggregate engine, so
    // missing 1..N prefixes are NOT defects. Checks min..max of present rounds.
    const present = [...seenRounds].sort((a, b) => a - b);
    if (present.length > 0) {
        const min = present[0];
        const max = present[present.length - 1];
        const span = max - min + 1;
        const presentPreview = previewList(present, 20);
        // Hard bound on the enumeration: `min`/`max` come from untrusted round
        // numbers, so an unguarded `for (i = min; i <= max; i++)` over
        // {1, 1e15} is an effectively-infinite loop (CPU DoS) that would also
        // push ~1e15 issues. Rounds above MAX_REVIEW_ROUND_NUMBER are rejected
        // above, which keeps `span` bounded on its own; this guard stays as the
        // belt-and-braces backstop so the walk is O(MAX_ROUND_GAP_SPAN) no
        // matter what reaches it.
        if (span > MAX_ROUND_GAP_SPAN) {
            add('ROUND_GAP', 'medium', `Round sequence ${min}..${max} is too wide to audit for gaps`, `${span} round numbers spanned; only rounds present were accepted: ${presentPreview}.`);
        }
        else {
            const missing = [];
            for (let i = min; i <= max; i++) {
                if (!seenRounds.has(i))
                    missing.push(i);
            }
            for (const m of missing.slice(0, MAX_ROUND_GAP_REPORTS)) {
                add('ROUND_GAP', 'medium', `Round ${m} is missing from the round sequence`, `rounds present: ${presentPreview}.`);
            }
            if (missing.length > MAX_ROUND_GAP_REPORTS) {
                add('ROUND_GAP', 'medium', `${missing.length - MAX_ROUND_GAP_REPORTS} more rounds are missing (list capped)`, `${missing.length} of the ${span} numbers in ${min}..${max} are absent; only the first ` +
                    `${MAX_ROUND_GAP_REPORTS} are listed individually. rounds present: ${presentPreview}.`);
            }
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
 * Human-readable reason for a failed evidence attestation.
 *
 * `file_too_large` / `binary_file` are DISTINCT from `line_out_of_range` (see
 * evidence.ts): the file EXISTS but cannot be line-addressed, so saying
 * "does not exist" would send the reader looking for a missing file.
 */
function describeEvidenceViolation(v) {
    switch (v.error) {
        case 'file_too_large':
            return `${v.file} is too large to line-address (over the evidence size cap)`;
        case 'binary_file':
            return `${v.file} is a binary (NUL-containing) file that cannot be line-addressed`;
        case 'line_out_of_range':
            return v.lineTotal !== undefined && v.lineTotal !== null
                ? `${v.line} is beyond this file's ${v.lineTotal} lines`
                : `${v.file} is not a regular line-addressable file (directory/device/FIFO)`;
        default:
            return `${v.file} does not exist at all (verifiable read required)`;
    }
}
/** Headline for a failed evidence attestation (matches the detail above). */
function evidenceViolationSummary(v) {
    const unaddressable = v.error === 'file_too_large' || v.error === 'binary_file';
    const head = unaddressable
        ? 'Finding cannot be anchored to line-addressable code'
        : 'Finding references non-existent code';
    return `${head}: ${v.file}${v.line ? `:${v.line}` : ''}`;
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
 *
 * `coverage` (a CoverageResult) is a *prompt-informative* check: a scope whose
 * reviewer never reported reading a meaningful share of its assigned files
 * surfaces a medium COVERAGE_GAP hint (it does NOT flip the verdict — the
 * subagent's actual tool-call trace is not aggregated here, so coverage can
 * only advise, never adjudicate).
 */
export function buildFinalReviewReport(report, opts = {}) {
    const meta = metaReviewReport(report);
    const coverage = opts.coverage ?? null;
    if (coverage !== null) {
        meta.checksRun += 1;
        if (coverage.uncovered.length > 0) {
            const listed = coverage.uncovered.slice(0, COVERAGE_LIST_TRUNCATE).join(', ');
            const extra = coverage.uncovered.length - COVERAGE_LIST_TRUNCATE > 0
                ? ` (+${coverage.uncovered.length - COVERAGE_LIST_TRUNCATE} more)`
                : '';
            meta.issues.push({
                code: 'COVERAGE_GAP',
                severity: 'medium',
                summary: `${coverage.uncovered.length} of ${coverage.assigned.length} scope files ` +
                    'were not (self-)reported as read',
                detail: `The reviewer reported reading ${coverage.covered.length}/${coverage.assigned.length} ` +
                    `assigned files. Uncovered: ${listed}${extra}. Best-effort coverage hint — ` +
                    'verify these files were actually opened.',
            });
        }
    }
    const evidence = opts.evidence ?? null;
    if (evidence !== null) {
        meta.checksRun += 1;
        if (evidence.results.some((r) => r.error !== undefined)) {
            for (const violation of evidence.results) {
                if (violation.error === undefined)
                    continue;
                const detail = describeEvidenceViolation(violation);
                const summary = evidenceViolationSummary(violation);
                let roundHint = '';
                if (report && violation.file) {
                    // Try to attribute the poisoned finding to the round that first
                    // surfaced it (best-effort; report rounds carry it). `rounds` is
                    // untrusted JSON, so a null entry must not throw here.
                    for (const r of (Array.isArray(report.rounds) ? report.rounds : []) ?? []) {
                        const findings = Array.isArray(r?.findings) ? r.findings : [];
                        const matched = findings.some((fnd) => !!fnd && fnd?.file === violation.file && fnd?.line === violation.line);
                        if (matched) {
                            roundHint = ` (round ${String(r.round)})`;
                            break;
                        }
                    }
                }
                meta.issues.push({
                    code: 'EVIDENCE_VIOLATION',
                    severity: 'critical',
                    summary: summary + roundHint,
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
        coverage: coverage, // preserve the coverage result (or null) on the final report
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
