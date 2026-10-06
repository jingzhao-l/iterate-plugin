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
import { DEFAULT_SCOPE_CHUNK_SIZE, chunkFiles } from "./review-scope.js";
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
        // bypassed the schema) AND against a null list element (model-authored
        // JSON): treat both as the least severe so NaN never enters the
        // comparator and ordering stays deterministic.
        const rankA = SEVERITY_RANK[a?.severity] ?? SEVERITY_RANK.low;
        const rankB = SEVERITY_RANK[b?.severity] ?? SEVERITY_RANK.low;
        const bySeverity = rankA - rankB;
        if (bySeverity !== 0)
            return bySeverity;
        // Defensive coercion: `file`/`line` can be wrong-typed when schema
        // validation is disabled — String()/Number() keep the comparator total.
        const byFile = String(a?.file ?? '').localeCompare(String(b?.file ?? ''));
        if (byFile !== 0)
            return byFile;
        return (Number(a?.line) || 0) - (Number(b?.line) || 0);
    });
}
/**
 * Hard ceiling on the round cap the aggregation math will honor.
 *
 * Mirrors `MAX_MAX_ROUNDS` in `config-loader.ts` (the config bomb guard) —
 * `test/review.test.ts` asserts the two constants stay in sync. The tool
 * boundary only clamps the LOWER bound of `maxReviewRounds`, so an absurd
 * caller value (1e15) would otherwise drive the `findingsByRound` allocation
 * bound (`roundCap * 2`) straight into OOM territory.
 */
export const MAX_REVIEW_ROUNDS_CAP = 100;
/**
 * Clamp an untrusted round cap to `[1, MAX_REVIEW_ROUNDS_CAP]`.
 *
 * Non-finite / non-numeric input (`NaN`, `Infinity`, a string) collapses to
 * 1 — the smallest sane cap. Without this, `Math.max(1, NaN)` stayed `NaN`
 * and `new Array(NaN)` threw `RangeError` out of `aggregateRounds`.
 */
export function clampMaxReviewRounds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return 1;
    return Math.min(MAX_REVIEW_ROUNDS_CAP, Math.max(1, Math.floor(value)));
}
/**
 * True when `n` is a round number the deterministic core accepts: a positive
 * integer. Shared by `aggregateRounds` / `computeConvergence` /
 * `buildReviewReport` (and re-read by the meta-review audit) so every reader
 * of "the last round" agrees on which round numbers count — a fractional
 * (`1.5`) or non-finite round is simply "not a round", never a convergence
 * input that could be mis-indexed into `findingsByRound`.
 */
export function isValidRoundNumber(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}
/** Normalize a summary so near-identical duplicates collapse to one key. */
export function normalizeSummary(summary) {
    // Coerce: `summary` is model-authored JSON when schema validation is off,
    // so a numeric summary must not crash `.trim()` inside the dedupe key.
    return String(summary ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s\n\t]+/g, ' ');
}
/**
 * Dedupe key: same file + same dimension + similar summary + explicit line.
 * Including the line keeps two genuine issues with identical wording at
 * different locations from collapsing into one (the line is omitted only when
 * neither side anchors one, i.e. whole-file findings).
 */
export function findingKey(f) {
    // Defensive reads: with `output_schema_validation: false` a finding may
    // carry wrong-typed fields (and `f` itself may be a null list element), and
    // this key feeds the dedupe Set on EVERY round — it must never throw.
    const src = (f ?? {});
    const line = typeof src.line === 'number' && src.line > 0 ? src.line : 0;
    return `${String(src.file ?? '')}|${String(src.dimension ?? '')}|${line}|${normalizeSummary(src.summary)}`;
}
/**
 * Remove duplicate findings within a list.
 * Keeps the first occurrence of each dedupe key.
 */
export function dedupeFindings(findings) {
    const seen = new Set();
    const out = [];
    for (const f of findings) {
        // A null / array entry (hostile or schema-validation-off JSON) must never
        // reach `summarize`, which reads `f.severity` unguarded.
        if (!f || typeof f !== 'object' || Array.isArray(f))
            continue;
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
    // `known` is config/arg JSON: a non-array truthy value must behave like
    // "no entries", never reach `known.some` and throw.
    if (!Array.isArray(known) || known.length === 0)
        return findings;
    return findings.filter((f) => {
        // A null / non-object finding has no file/dimension to match on; drop it
        // here so it can never crash the comparator (aggregateRounds drops it too,
        // so the report's counts stay consistent either way).
        if (!f || typeof f !== 'object' || Array.isArray(f))
            return false;
        const matched = known.some((k) => {
            if (!k || typeof k !== 'object')
                return false;
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
    // entries defensively rather than letting `firstRoundByKey` key on NaN/0 or
    // crashing on null / non-array findings.
    // Hard ceiling: round numbers are model-authored JSON; an absurd round (e.g.
    // 1e9) would otherwise allocate an array of that size below (OOM). Round
    // numbers above the configured cap are clamped to the cap.
    let maxRound = 0;
    // Upper-bounded too: `Math.max(1, NaN)` used to stay NaN and blow up in
    // `new Array(effectiveMax)`, and an unbounded cap scaled the allocation
    // bound to whatever the caller asked for.
    const roundCap = clampMaxReviewRounds(maxReviewRounds);
    for (const round of Array.isArray(rounds) ? rounds : []) {
        if (!round || typeof round !== 'object')
            continue;
        if (!isValidRoundNumber(round.round))
            continue;
        const findings = Array.isArray(round.findings) ? round.findings : [];
        if (round.round > maxRound)
            maxRound = round.round;
        for (const f of findings) {
            // Null / non-object elements (schema validation off) would crash
            // `findingKey`; dropping them here keeps `findingsByRound` summing to
            // exactly the returned findings list (the meta-review's CONVERGENCE_SUM
            // check reads that equality).
            if (!f || typeof f !== 'object' || Array.isArray(f))
                continue;
            const key = findingKey(f);
            if (seen.has(key))
                continue;
            seen.add(key);
            firstRoundByKey.set(key, round.round);
            merged.push(f);
        }
    }
    // Clamp the allocation bound so a hostile round number cannot OOM the tool.
    const effectiveMax = Math.min(maxRound, Math.max(1, roundCap * 2));
    const findingsByRound = new Array(effectiveMax).fill(0);
    for (const key of firstRoundByKey.keys()) {
        const firstRound = firstRoundByKey.get(key) ?? 1;
        // Fold rounds BEYOND the allocation bound into the highest slot instead of
        // dropping them: a finding first seen in an over-cap round was previously
        // invisible to `findingsByRound`, so a run whose final rounds exceeded the
        // cap looked "converged" even though a real round found new issues. Folding
        // keeps the counts truthful (the sum still equals totalFindings) while the
        // memory bound stays fixed.
        const idx = Math.min(firstRound, effectiveMax) - 1;
        findingsByRound[idx] = (findingsByRound[idx] || 0) + 1;
    }
    return { findings: dedupeFindings(merged), findingsByRound, firstRoundByKey };
}
/**
 * Compute convergence statistics for a dry-run review.
 */
export function computeConvergence(rounds, maxReviewRounds) {
    const list = Array.isArray(rounds) ? rounds : [];
    const { findingsByRound } = aggregateRounds(list, maxReviewRounds);
    const totalRounds = list.length;
    // `findingsByRound` is indexed by the actual round number (round r → index
    // r-1), sized to the highest present round (clamped). Convergence must read
    // the HIGHEST PRESENT round's count — not the last array element (rounds
    // may arrive unsorted) and not `totalRounds - 1` (only valid for contiguous
    // 1..N). The count index is bounded by the array length aggregateRounds
    // actually allocated.
    let lastRound = 0;
    for (const round of list) {
        if (!isValidRoundNumber(round?.round))
            continue;
        if (round.round > lastRound)
            lastRound = round.round;
    }
    const idx = Math.min(lastRound, findingsByRound.length) - 1;
    const lastRoundCount = idx >= 0 ? (findingsByRound[idx] ?? 0) : 0;
    // `lastRound === 0` means NO round carried an interpretable number: claiming
    // `converged` there would bless a report the core could not actually read.
    const converged = totalRounds > 0 && lastRound > 0 && lastRoundCount === 0;
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
        // NULL-PROTOTYPE map: a model-authored `dimension` of `__proto__` or
        // `constructor` would otherwise resolve against Object.prototype — the
        // `__proto__` setter silently discards a primitive value and `constructor`
        // string-concatenates the Object function — so the counter never
        // accumulated and the meta-review's DIMENSION_SUM check false-positived.
        // A null-prototype object has no inherited accessors, so every dimension
        // (including those three names) is a plain own data property and
        // JSON-serializes normally.
        byDimension: Object.create(null),
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
    const inputRounds = Array.isArray(input.rounds) ? input.rounds : [];
    const filteredRounds = inputRounds
        .map((r) => ({
        round: typeof r?.round === 'number' ? r.round : 0,
        findings: filterKnownIntentional(Array.isArray(r?.findings) ? r.findings : [], input.knownIntentional),
        readFiles: Array.isArray(r?.readFiles) ? r.readFiles : [],
    }))
        // Sort by round number so convergence math below (and the meta-review
        // audit, which reads the LAST element as the highest round) never depends
        // on the caller's array order. A resumed run that only passes [round 5]
        // must be audited as round 5, not as "one round with no number".
        .sort((a, b) => a.round - b.round);
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
    let lastRound = 0;
    for (const r of filteredRounds) {
        // Same validity rule as aggregateRounds: a fractional / NaN round is not
        // a round, so it must never be used as an index into `findingsByRound`
        // (Math.min(1.5, len) - 1 = 0.5 → reads `undefined` → counts as 0 new →
        // a round that really did report findings would be read as "converged").
        if (isValidRoundNumber(r.round) && r.round > lastRound)
            lastRound = r.round;
    }
    // `lastRound` can exceed the array length when over-cap rounds were FOLDED
    // into the last slot (see aggregateRounds). Read the same clamped index
    // computeConvergence uses, so a real over-cap round is never mis-read as 0
    // new findings (which would falsely report "converged").
    const idx = Math.min(lastRound, findingsByRound.length) - 1;
    const lastRoundCount = lastRound > 0 && idx >= 0 ? (findingsByRound[idx] ?? 0) : 0;
    const converged = filteredRounds.length > 0 && lastRound > 0 && lastRoundCount === 0;
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
        // Aggregate of every round's self-reported reads, so the meta-review
        // coverage gate can compare against the assigned inventory.
        readFiles: [].concat(...filteredRounds.map((r) => r.readFiles ?? [])),
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
            readFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Every file you actually opened with read_file while reviewing your assigned scope. Used to audit coverage; files you never opened count as un-reviewed.',
            },
        },
        required: ['findings', 'readFiles'],
    };
}
// ─── Output schema validation ──────────────────────────────────────────────
//
// `config.reviewer.output_schema_validation` (default true) turns on a
// deterministic schema gate at the `aggregate` boundary: reviewer subagent
// outputs are parsed as JSON by the orchestrator, but models sometimes return
// malformed findings (missing fields, wrong types, out-of-range severity).
// Before any finding reaches the deterministic core (dedupe/sort/report) —
// which would crash on e.g. a missing `summary` — we validate every entry
// against the same shape `findingsSchema()` describes and surface the issues
// so the workflow can retry that round (≤2 times) with a strict-JSON nudge.
// Schema-invalid findings are dropped from the report; the workflow never
// forwards them into fixes.
/** Fields every finding object MUST carry (mirrors findingsSchema().required). */
export const REQUIRED_FINDING_FIELDS = [
    'dimension',
    'file',
    'severity',
    'summary',
    'failure_scenario',
    'suggested_fix',
    'is_atomic',
];
/** Allowed severity values (mirrors the schema enum). */
export const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'];
/** String-typed finding fields (type check only, presence handled by REQUIRED). */
const STRING_FINDING_FIELDS = [
    'dimension',
    'file',
    'summary',
    'failure_scenario',
    'suggested_fix',
];
/**
 * Validate an arbitrary parsed value against the findings schema shape.
 * Accepts the `{findings: [...]}` wrapper OR a bare findings array, so callers
 * can validate either the raw reviewer output object or a round's findings.
 * Pure and deterministic — never touches the filesystem.
 */
export function validateFindingsSchema(input) {
    const raw = input?.findings ?? input;
    if (!Array.isArray(raw)) {
        return [
            {
                index: -1,
                field: 'findings',
                message: 'expected a JSON array of finding objects',
            },
        ];
    }
    const issues = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push({
                index: i,
                field: `findings[${i}]`,
                message: 'expected a finding object',
            });
            continue;
        }
        const f = item;
        for (const key of REQUIRED_FINDING_FIELDS) {
            if (f[key] === undefined || f[key] === null) {
                issues.push({
                    index: i,
                    field: `findings[${i}].${key}`,
                    message: `required field "${key}" is missing`,
                });
            }
        }
        for (const key of STRING_FINDING_FIELDS) {
            if (f[key] !== undefined && f[key] !== null && typeof f[key] !== 'string') {
                issues.push({
                    index: i,
                    field: `findings[${i}].${key}`,
                    message: `"${key}" must be a string`,
                });
            }
        }
        if (f.severity !== undefined &&
            f.severity !== null &&
            !SEVERITY_VALUES.includes(f.severity)) {
            issues.push({
                index: i,
                field: `findings[${i}].severity`,
                message: `severity must be one of: ${SEVERITY_VALUES.join(', ')}`,
            });
        }
        if (f.is_atomic !== undefined &&
            f.is_atomic !== null &&
            typeof f.is_atomic !== 'boolean') {
            issues.push({
                index: i,
                field: `findings[${i}].is_atomic`,
                message: 'is_atomic must be a boolean',
            });
        }
        if (f.line !== undefined &&
            f.line !== null &&
            (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < 0)) {
            issues.push({
                index: i,
                field: `findings[${i}].line`,
                message: 'line must be a non-negative integer (0 = whole-file)',
            });
        }
    }
    return issues;
}
/**
 * Validate every round's findings against the findings schema.
 * Round order matches the input `rounds` array.
 */
export function validateRoundsSchema(rounds) {
    return rounds.map((r) => {
        const issues = validateFindingsSchema(Array.isArray(r?.findings) ? r.findings : []);
        return { round: typeof r?.round === 'number' ? r.round : 0, valid: issues.length === 0, issues };
    });
}
/**
 * Drop schema-invalid findings before they reach the deterministic core.
 *
 * - With a non-null `schemaValidation` (validation enabled): drop every finding
 *   flagged by a schema issue; a round-level issue (index -1) empties the round.
 * - With `schemaValidation === null` (validation disabled): still drop entries
 *   that are not plain objects, which would crash `findingKey`/dedupe.
 *
 * Round order and round numbers are preserved so downstream convergence math
 * keeps working on the sanitized stream.
 */
export function sanitizeRounds(rounds, schemaValidation) {
    return rounds.map((r, i) => {
        // Defensive: malformed rounds must never crash the deterministic core.
        const findings = Array.isArray(r?.findings) ? r.findings : [];
        const roundNo = typeof r?.round === 'number' ? r.round : 0;
        const readFiles = Array.isArray(r?.readFiles) ? r.readFiles : [];
        if (schemaValidation) {
            const issues = schemaValidation[i]?.issues ?? [];
            if (issues.some((iss) => iss.index === -1))
                return { round: roundNo, findings: [], readFiles };
            const bad = new Set(issues.map((iss) => iss.index));
            return {
                round: roundNo,
                findings: findings.filter((_, fi) => !bad.has(fi)),
                readFiles,
            };
        }
        return {
            round: roundNo,
            findings: findings.filter((f) => Boolean(f) && typeof f === 'object' && !Array.isArray(f)),
            readFiles,
        };
    });
}
/**
 * Build the "attached visual context" instruction block for a reviewer prompt.
 *
 * ``path``/``data`` attachments (screenshots, mockups, failure repros) are
 * evidence a reviewer must weigh alongside the code — this clause names each
 * one and mandates that the reviewer inspect/consider it (e.g. by opening the
 * file with a vision-capable tool or the ``image_to_text`` bridge) before
 * judging. Pure string construction; returns ``""`` when there are none.
 */
export function attachmentClause(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const lines = [];
    for (const a of attachments) {
        if (!a || typeof a !== 'object')
            continue;
        if (typeof a.path === 'string' && a.path) {
            lines.push(`- ${a.path}${typeof a.caption === 'string' && a.caption ? ` (${a.caption})` : ''}`);
        }
        else if (typeof a.data === 'string' && a.data) {
            const kind = typeof a.media_type === 'string' && a.media_type ? a.media_type : 'image';
            lines.push(`- inline ${kind} image${typeof a.caption === 'string' && a.caption ? ` (${a.caption})` : ''}`);
        }
    }
    if (lines.length === 0)
        return '';
    return ('ATTACHED VISUAL CONTEXT (mandatory): the following image attachment(s) were provided ' +
        'with this review — each one is part of the evidence you must weigh:\n' +
        lines.join('\n') +
        '\nYou MUST inspect/consider EVERY attachment before judging your dimension (open it ' +
        'with a vision-capable tool, or use image_to_text if your model cannot see images). ' +
        'If an attachment is inaccessible, state that and judge solely on the code. Do not ' +
        'ignore an attachment just because it is not code.');
}
/**
 * Build the task prompt for one dimension's reviewer subagent.
 * In dry-run mode, pass `alreadyKnown` (the findings from earlier rounds) so the
 * reviewer hunts for NEW issues only — that is what makes "反复审查" converge.
 */
export function reviewerTaskPrompt(input) {
    const parts = [];
    parts.push(`You are the "${input.dimension}" reviewer for the iterate review.`, `Goal: ${input.goal}`, `Scope: ${input.scope === 'full' ? 'entire codebase' : 'changed files only'}.`);
    if (input.effort) {
        parts.push(`Reasoning effort for this review pass: ${input.effort}.`);
    }
    if (input.focus) {
        parts.push(`FOCUS: ${input.focus}`);
    }
    const attached = attachmentClause(input.attachments);
    if (attached) {
        parts.push(attached);
    }
    if (input.scopeFiles && input.scopeFiles.length > 0) {
        parts.push('COVERAGE RULE (mandatory): below is the exact file inventory you are ' +
            'assigned to review. You MUST open EVERY file in this inventory with ' +
            'the read_file tool before judging it — do not skip, skim-declare, or ' +
            'assume any file without reading it. Files you did not actually open ' +
            'are considered un-reviewed and will lower your coverage score. ' +
            'Return a `readFiles` array listing every file you actually opened.', 'Assigned file inventory:', input.scopeFiles.map((p) => `- ${p}`).join('\n'));
    }
    else if (input.scope === 'changed-only' &&
        input.changedFiles &&
        input.changedFiles.length > 0) {
        parts.push('Changed files to review (review ONLY these files; they are the diff against ' +
            'the target branch). You MUST open EVERY listed file with read_file ' +
            'before judging it — never skip or assume a file:', input.changedFiles.map((p) => `- ${p}`).join('\n'));
    }
    if (input.mode === 'dry-run') {
        parts.push('MODE: dry-run / pure review. You MUST NOT modify, create, or delete ANY file. Read-only analysis only.');
    }
    if (input.alreadyKnown && input.alreadyKnown.length > 0) {
        parts.push('Already-known findings from earlier rounds (do NOT re-report these; find NEW issues only):', JSON.stringify(input.alreadyKnown, null, 2));
    }
    else {
        parts.push('This is round 1 — report every issue you find in this dimension.');
    }
    parts.push('EVIDENCE RULE (mandatory): read every file you report on with the ' +
        'read_file tool BEFORE judging it. NEVER report a location you did not ' +
        'actually read — speculation about code you never inspected is a ' +
        'disqualifying failure, and fabricated line numbers are treated as ' +
        'poisoned evidence. Anchor every finding to real code.');
    parts.push(`Return a JSON object: {"findings": [...], "readFiles": [...]}.`, `Each finding: dimension (must be "${input.dimension}"), file (relative path), ` +
        'line (optional; the exact line you READ for a line-targeted issue; ' +
        '0 or omitted for whole-file/module-level issues), ' +
        'severity (critical/high/medium/low), summary (one line), ' +
        'failure_scenario (how/when it fails, backed by the code you actually ' +
        'read), suggested_fix (the concrete fix), ' +
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
    const configuredScope = input.config.review?.scope ?? 'full';
    const reasoningEffort = input.config.reasoning_effort === 'low' ||
        input.config.reasoning_effort === 'medium' ||
        input.config.reasoning_effort === 'high'
        ? input.config.reasoning_effort
        : null;
    const dimensions = Array.isArray(input.config.dimensions) ? input.config.dimensions : [];
    const maxLines = input.config.atomic?.max_lines ?? 20;
    const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
    // Defensive parse: keep only well-formed attachment entries (path or data).
    const attachments = Array.isArray(input.attachments)
        ? input.attachments.filter((a) => Boolean(a) &&
            typeof a === 'object' &&
            ((typeof a.path === 'string' && a.path.length > 0) ||
                (typeof a.data === 'string' && a.data.length > 0)))
        : [];
    // changed-only with zero detected changes → auto-fallback to full scope.
    const effectiveChangedOnly = configuredScope === 'changed-only' && changedFiles.length > 0;
    const scope = effectiveChangedOnly ? 'changed-only' : 'full';
    const fallbackToFull = configuredScope === 'changed-only' && changedFiles.length === 0;
    // Scope batching (coverage enforcement): changed-only is a single batch
    // owning the full delta; full scope splits the collected inventory into
    // per-chunk reviewer tasks when scopeFiles is supplied.
    const chunkSize = Number(input.config.reviewer?.scope_chunk_size);
    const perChunk = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_SCOPE_CHUNK_SIZE;
    let batches;
    if (effectiveChangedOnly) {
        batches = [undefined];
    }
    else if (input.scopeFiles && input.scopeFiles.length > 0) {
        batches = chunkFiles(input.scopeFiles, perChunk).filter((b) => b.length > 0);
    }
    else {
        batches = [undefined];
    }
    const dimensionTasks = [];
    // personalization.dimension_focus: [{dimension, focus}] — appended to the
    // matching dimension's reviewer prompt.
    const focusMap = new Map();
    const pf = input.config.personalization;
    if (pf && Array.isArray(pf.dimension_focus)) {
        for (const entry of pf.dimension_focus) {
            if (entry && typeof entry.dimension === 'string' && typeof entry.focus === 'string' && entry.focus) {
                focusMap.set(entry.dimension, entry.focus);
            }
        }
    }
    for (const d of dimensions) {
        batches.forEach((batch, index) => {
            const dimensionId = batches.length === 1 ? d : `${d}#${index + 1}`;
            dimensionTasks.push({
                id: dimensionId,
                reviewerPrompt: reviewerTaskPrompt({
                    dimension: d,
                    goal,
                    scope,
                    mode: input.mode,
                    alreadyKnown: [],
                    outputLanguage: language,
                    maxLines,
                    changedFiles: effectiveChangedOnly ? changedFiles : undefined,
                    scopeFiles: batch,
                    focus: focusMap.get(d),
                    attachments,
                    effort: reasoningEffort ?? undefined,
                }),
                findingsSchema: findingsSchema(),
            });
        });
    }
    return {
        mode: input.mode,
        goal,
        scope,
        dimensions: dimensionTasks,
        // Clamped with the SAME rule aggregateRounds honors, so the cap this plan
        // advertises is never a number the aggregation math would silently clamp.
        maxReviewRounds: clampMaxReviewRounds(input.maxReviewRounds),
        knownIntentional: input.knownIntentional ?? [],
        changedFiles: effectiveChangedOnly ? changedFiles : [],
        fallbackToFull,
        attachments,
        reasoningEffort,
    };
}
