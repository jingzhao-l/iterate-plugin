/**
 * Deterministic review engine for the iterate review loop (dry-run and normal).
 *
 * This module contains NO I/O and NO agent spawning — it is the pure,
 * testable core of the multi-round convergence loop:
 *
 *   1. dedupe findings across rounds (file + dimension + normalized summary)
 *   2. filter out `known_intentional` entries from personalization
 *   3. sort by severity (critical > high > medium > low)
 *   4. compute multi-round convergence stats ("纯反复审查" 收敛统计)
 *   5. assemble the ReviewReport
 *   6. build reviewer task prompts + structured-output schema for subagents
 *
 * The workflow script (see skill-prompt.ts) does the orchestration:
 * spawn parallel reviewers, feed back already-known findings each round,
 * and stop when a round yields 0 new findings or the round cap is reached.
 * All deterministic math lives here so it can be unit-tested.
 */
/** Severity ordering: lower rank = more severe. */
export const SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};
/** Sort findings by severity (most severe first), then by file path. */
export function sortFindings(findings) {
    return [...findings].sort((a, b) => {
        // Guard against an out-of-spec severity string (e.g. from a model that
        // bypassed the schema): treat it as the least severe so NaN never enters
        // the comparator and ordering stays deterministic.
        const rankA = SEVERITY_RANK[a.severity] ?? SEVERITY_RANK.low;
        const rankB = SEVERITY_RANK[b.severity] ?? SEVERITY_RANK.low;
        const bySeverity = rankA - rankB;
        if (bySeverity !== 0)
            return bySeverity;
        const byFile = a.file.localeCompare(b.file);
        if (byFile !== 0)
            return byFile;
        return (a.line ?? 0) - (b.line ?? 0);
    });
}
/** Normalize a summary so near-identical duplicates collapse to one key. */
export function normalizeSummary(summary) {
    return summary
        .trim()
        .toLowerCase()
        .replace(/[\s\n\t]+/g, ' ');
}
/** Dedupe key: same file + same dimension + similar summary. */
export function findingKey(f) {
    return `${f.file}|${f.dimension}|${normalizeSummary(f.summary)}`;
}
/**
 * Remove duplicate findings within a list.
 * Keeps the first occurrence of each dedupe key.
 */
export function dedupeFindings(findings) {
    const seen = new Set();
    const out = [];
    for (const f of findings) {
        const key = findingKey(f);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(f);
    }
    return out;
}
/**
 * Filter out findings that match a `known_intentional` entry.
 * Match rule (mirrors SKILL.md Phase 1 FILTER):
 *  - same `file` AND same `dimension`, AND
 *  - entry `line` is 0/undefined (whole file) OR equals the finding's line.
 */
export function filterKnownIntentional(findings, known) {
    if (!known || known.length === 0)
        return findings;
    return findings.filter((f) => {
        const matched = known.some((k) => {
            const sameFile = k.file === f.file;
            const sameDim = k.dimension === f.dimension;
            if (!sameFile || !sameDim)
                return false;
            const wholeFile = k.line === undefined || k.line === 0;
            if (wholeFile)
                return true;
            return k.line === f.line;
        });
        return !matched;
    });
}
/**
 * Merge per-round findings into one globally-deduped stream while tracking
 * which round first surfaced each finding. This is the deterministic core of
 * "反复多轮审查直至收敛":
 *  - `findingsByRound` = number of GLOBALLY new findings first seen in round r,
 *    indexed by the actual `round` number (round r → index r-1). The array is
 *    sized to the highest round number encountered, so non-contiguous round
 *    numbers (e.g. a resumed run that starts at round 5, or a caller that only
 *    passes `[{round: 3}]`) still yield correct counts instead of being
 *    collapsed onto wrong indices.
 *  - `converged` = the last executed round produced 0 new findings
 *  - `stoppedReason` = 'converged' | 'max_rounds_reached'
 */
export function aggregateRounds(rounds, maxReviewRounds) {
    const seen = new Set();
    const firstRoundByKey = new Map();
    const merged = [];
    // Guard: round numbers are expected to be positive integers. Skip malformed
    // entries defensively rather than letting `firstRoundByKey` key on NaN/0.
    let maxRound = 0;
    for (const round of rounds) {
        if (typeof round.round !== 'number' || !Number.isInteger(round.round) || round.round < 1)
            continue;
        if (round.round > maxRound)
            maxRound = round.round;
        for (const f of round.findings) {
            const key = findingKey(f);
            if (seen.has(key))
                continue;
            seen.add(key);
            firstRoundByKey.set(key, round.round);
            merged.push(f);
        }
    }
    const findingsByRound = [];
    for (let r = 1; r <= maxRound; r++) {
        let count = 0;
        for (const key of firstRoundByKey.keys()) {
            if (firstRoundByKey.get(key) === r)
                count++;
        }
        findingsByRound.push(count);
    }
    return { findings: dedupeFindings(merged), findingsByRound, firstRoundByKey };
}
/**
 * Compute convergence statistics for a dry-run review.
 */
export function computeConvergence(rounds, maxReviewRounds) {
    const { findingsByRound } = aggregateRounds(rounds, maxReviewRounds);
    const totalRounds = rounds.length;
    // `findingsByRound` is indexed by the actual round number (round r → index
    // r-1), so convergence must read the LAST PRESENT round's count using its
    // reported round number — not `totalRounds - 1`, which is only valid for
    // contiguous 1..N round numbers.
    const lastRound = totalRounds > 0 ? rounds[totalRounds - 1].round : 0;
    const lastRoundCount = lastRound > 0 ? (findingsByRound[lastRound - 1] ?? 0) : 0;
    const converged = totalRounds > 0 && lastRoundCount === 0;
    return {
        totalRounds,
        findingsByRound,
        converged,
        stoppedReason: totalRounds === 0
            ? 'max_rounds_reached'
            : converged
                ? 'converged'
                : 'max_rounds_reached',
    };
}
/** Build a severity/summary breakdown map for the report. */
function summarize(findings) {
    const summary = {
        totalFindings: findings.length,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        byDimension: {},
    };
    for (const f of findings) {
        if (f.severity === 'critical')
            summary.critical++;
        else if (f.severity === 'high')
            summary.high++;
        else if (f.severity === 'medium')
            summary.medium++;
        else
            summary.low++;
        summary.byDimension[f.dimension] = (summary.byDimension[f.dimension] ?? 0) + 1;
    }
    return summary;
}
/**
 * Assemble the final ReviewReport from raw per-round findings.
 * Applies known_intentional filtering, cross-round dedupe, severity sort,
 * and convergence stats in one deterministic pass. Shared by dry-run (pure
 * review) and normal (autonomous loop) modes — the mode only records intent;
 * the math is identical.
 */
export function buildReviewReport(input) {
    // 1. Filter known-intentional per round (before cross-round dedupe).
    const filteredRounds = input.rounds.map((r) => ({
        round: r.round,
        findings: filterKnownIntentional(r.findings, input.knownIntentional),
    }));
    // 2. Cross-round dedupe + per-round "first seen" tracking.
    const { findings, findingsByRound } = aggregateRounds(filteredRounds, input.maxReviewRounds);
    // 3. Severity sort the global result.
    const sorted = sortFindings(findings);
    // 4. Convergence. Must be identical to `computeConvergence`: `findingsByRound`
    //    is indexed by the actual round number (round r → index r-1) and sized to
    //    the highest round, so convergence reads the LAST PRESENT round's count
    //    using its reported round number — NOT `filteredRounds.length - 1`, which
    //    is only valid for contiguous 1..N round numbers (resumed iterations and
    //    non-contiguous round sets would otherwise read the wrong count).
    const lastRound = filteredRounds.length > 0 ? filteredRounds[filteredRounds.length - 1].round : 0;
    const lastRoundCount = lastRound > 0 ? (findingsByRound[lastRound - 1] ?? 0) : 0;
    const converged = filteredRounds.length > 0 && lastRoundCount === 0;
    // Attach the normal-mode fix count to the summary (dry-run leaves it absent).
    const computed = summarize(sorted);
    if (input.mode === 'normal' && typeof input.fixedCount === 'number' && Number.isInteger(input.fixedCount)) {
        computed.fixedCount = input.fixedCount;
    }
    return {
        mode: input.mode,
        goal: input.goal,
        dimensions: input.dimensions,
        maxReviewRounds: input.maxReviewRounds,
        rounds: filteredRounds,
        findings: sorted,
        convergence: {
            totalRounds: filteredRounds.length,
            findingsByRound,
            converged,
            stoppedReason: filteredRounds.length === 0
                ? 'max_rounds_reached'
                : converged
                    ? 'converged'
                    : 'max_rounds_reached',
        },
        summary: computed,
    };
}
/**
 * JSON Schema for reviewer subagent structured output.
 * Object-rooted (dsh `agent` opts.schema requires object-rooted schemas with
 * only type/properties/required/additionalProperties/items/enum/const/oneOf).
 */
export function findingsSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        dimension: { type: 'string' },
                        file: { type: 'string' },
                        line: { type: 'integer' },
                        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                        summary: { type: 'string' },
                        failure_scenario: { type: 'string' },
                        suggested_fix: { type: 'string' },
                        is_atomic: { type: 'boolean' },
                    },
                    required: [
                        'dimension',
                        'file',
                        'severity',
                        'summary',
                        'failure_scenario',
                        'suggested_fix',
                        'is_atomic',
                    ],
                },
            },
        },
        required: ['findings'],
    };
}
/**
 * Build the task prompt for one dimension's reviewer subagent.
 * In dry-run mode, pass `alreadyKnown` (the findings from earlier rounds) so the
 * reviewer hunts for NEW issues only — that is what makes "反复审查" converge.
 */
export function reviewerTaskPrompt(input) {
    const parts = [];
    parts.push(`You are the "${input.dimension}" reviewer for the iterate review.`, `Goal: ${input.goal}`, `Scope: ${input.scope === 'full' ? 'entire codebase' : 'changed files only'}.`);
    if (input.mode === 'dry-run') {
        parts.push('MODE: dry-run / pure review. You MUST NOT modify, create, or delete ANY file. Read-only analysis only.');
    }
    if (input.alreadyKnown && input.alreadyKnown.length > 0) {
        parts.push('Already-known findings from earlier rounds (do NOT re-report these; find NEW issues only):', JSON.stringify(input.alreadyKnown, null, 2));
    }
    else {
        parts.push('This is round 1 — report every issue you find in this dimension.');
    }
    parts.push(`Return a JSON object: {"findings": [...]}.`, `Each finding: dimension (must be "${input.dimension}"), file (relative path), ` +
        'line (optional integer), severity (critical/high/medium/low), summary (one line), ' +
        'failure_scenario (how/when it fails, specific evidence), suggested_fix (the concrete fix), ' +
        `is_atomic (true if the fix is <= ${input.maxLines} lines within a SINGLE file/function, else false).`, `Write summaries and details in ${input.outputLanguage}.`);
    return parts.join('\n');
}
/**
 * Build a review plan: how many rounds, which dimensions, and the reviewer
 * prompt template for each dimension. Used by the `iterate_review` tool's
 * `plan` operation to give the orchestrator a canonical spec.
 */
export function buildReviewPlan(input) {
    // Defensive reads: a malformed config (e.g. `dimensions` as a non-array, or
    // `review`/`atomic` missing) must degrade to sane defaults instead of
    // throwing an uncaught TypeError inside the tool's `execute`.
    const language = input.config.language === 'zh' ? 'Chinese (中文)' : 'English';
    const goal = input.config.goal ?? '';
    const scope = input.config.review?.scope ?? 'full';
    const dimensions = Array.isArray(input.config.dimensions) ? input.config.dimensions : [];
    const maxLines = input.config.atomic?.max_lines ?? 20;
    return {
        mode: input.mode,
        goal,
        scope,
        dimensions: dimensions.map((d) => ({
            id: d,
            reviewerPrompt: reviewerTaskPrompt({
                dimension: d,
                goal,
                scope,
                mode: input.mode,
                alreadyKnown: [],
                outputLanguage: language,
                maxLines,
            }),
            findingsSchema: findingsSchema(),
        })),
        maxReviewRounds: input.maxReviewRounds,
        knownIntentional: input.knownIntentional ?? [],
    };
}
