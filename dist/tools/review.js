import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadEffectiveConfig, resolveProjectRoot } from "../config-loader.js";
import { buildReviewPlan, buildReviewReport } from "../review.js";
import { buildFinalReviewReport, metaReviewReport } from "../meta-review.js";
/** Default round cap when neither the arg nor config provides one. */
const DEFAULT_MAX_REVIEW_ROUNDS = 3;
/**
 * Register the `iterate_review` tool.
 *
 * Two operations:
 *  - `plan`:      deterministic review plan for a mode (normal | dry-run).
 *                 Returns the goal, scope, per-dimension reviewer prompts,
 *                 the findings schema, and the max round cap. The orchestrator
 *                 uses this instead of inventing prompts ad hoc.
 *  - `aggregate`: deterministic aggregation of raw per-round findings.
 *                 Applies known_intentional filtering, cross-round dedupe,
 *                 severity sort, and convergence stats; returns a ReviewReport.
 *                 Purely computational — NEVER touches the filesystem.
 */
export function registerReviewTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_review',
        description: 'Deterministic review engine for the iterate workflow. ' +
            'Use `plan` to generate the review plan (dimensions, reviewer prompts, findings schema, round cap) ' +
            'for normal or dry-run mode. Use `aggregate` to merge raw per-round findings into a deduped, ' +
            'severity-sorted report with multi-round convergence statistics, and to audit that report ' +
            '(`meta-review`) producing a final review report. ' +
            '`aggregate`/`meta-review` are purely computational — they never modify any file.',
        parameters: {
            operation: {
                type: 'string',
                required: true,
                description: '"plan" to build the review plan, "aggregate" to merge findings, "meta-review" to audit a report.',
                enum: ['plan', 'aggregate', 'meta-review'],
            },
            mode: {
                type: 'string',
                description: 'Review mode: "dry-run" (pure review, no fixes) or "normal" (autonomous loop). Default: dry-run.',
                enum: ['dry-run', 'normal'],
            },
            rounds: {
                type: 'json',
                description: 'For `aggregate`: array of per-round findings, e.g. ' +
                    '[{"round":1,"findings":[...]},{"round":2,"findings":[...]}]. Each finding: ' +
                    '{dimension,file,line?,severity,summary,failure_scenario,suggested_fix,is_atomic}.',
            },
            maxReviewRounds: {
                type: 'integer',
                description: 'Round cap for dry-run convergence. Default: config.max_rounds, else 3.',
            },
            goal: {
                type: 'string',
                description: 'Optional goal override for `aggregate` (defaults to config goal).',
            },
            knownIntentional: {
                type: 'json',
                description: 'For `aggregate`: known-intentional entries to filter out, e.g. ' +
                    '[{"file":"db/queries.py","line":42,"dimension":"security","reason":"..."}]. line=0/omitted = whole file.',
            },
            report: {
                type: 'json',
                description: 'For `meta-review`: the ReviewReport JSON (as returned by `aggregate`) to audit for ' +
                    'internal consistency and produce the final review report.',
            },
            fixedCount: {
                type: 'integer',
                description: 'For `aggregate` (normal mode only): number of atomic fixes applied so far. ' +
                    'Surfaces a running "fixes applied" metric on the report summary.',
            },
            path: {
                type: 'string',
                description: 'Project root directory (default: current working directory).',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    operation: { type: 'string', required: true },
                    mode: { type: 'string' },
                    found: { type: 'boolean' },
                    plan: { type: 'json' },
                    report: { type: 'json' },
                    finalReport: { type: 'json' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(args) {
            const resolved = resolveProjectRoot(args.path);
            if (!resolved.ok) {
                return { operation: args.operation, error: resolved.reason };
            }
            const projectRoot = resolved.root;
            // Effective config = defaults merged with project overrides. Never
            // null, so `plan`/`aggregate` work even without a config file.
            const { config } = loadEffectiveConfig(projectRoot);
            const mode = args.mode ?? 'dry-run';
            if (args.operation === 'plan') {
                const maxReviewRounds = args.maxReviewRounds ?? config.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
                const knownIntentional = config.personalization
                    ?.known_intentional;
                const plan = buildReviewPlan({ config, mode, maxReviewRounds, knownIntentional });
                return { operation: 'plan', mode, found: true, plan: plan };
            }
            if (args.operation === 'aggregate') {
                const rawRounds = Array.isArray(args.rounds) ? args.rounds : [];
                const rounds = rawRounds
                    .map((r) => {
                    const rr = r;
                    const findings = Array.isArray(rr?.findings) ? rr.findings : [];
                    return { round: typeof rr?.round === 'number' ? rr.round : 0, findings };
                })
                    .filter((r) => r.round > 0);
                if (rounds.length === 0) {
                    return {
                        operation: 'aggregate',
                        mode,
                        error: 'rounds must be a non-empty array of {round, findings}.',
                    };
                }
                const maxReviewRounds = args.maxReviewRounds ?? config.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
                const goal = args.goal ?? config.goal ?? '';
                const dimensions = config.dimensions ?? [];
                const report = buildReviewReport({
                    mode,
                    goal,
                    dimensions,
                    maxReviewRounds,
                    rounds,
                    knownIntentional: args.knownIntentional,
                    fixedCount: typeof args.fixedCount === 'number' ? args.fixedCount : undefined,
                });
                return { operation: 'aggregate', mode, report: report };
            }
            if (args.operation === 'meta-review') {
                const source = args.report;
                if (!source || typeof source !== 'object') {
                    return {
                        operation: 'meta-review',
                        mode,
                        error: 'report must be a ReviewReport JSON object (as returned by `aggregate`).',
                    };
                }
                const audit = metaReviewReport(source);
                const finalReport = buildFinalReviewReport(source);
                return {
                    operation: 'meta-review',
                    mode,
                    found: true,
                    report: audit,
                    finalReport: finalReport,
                };
            }
            return {
                operation: args.operation,
                error: `Unknown operation "${args.operation}". Use "plan", "aggregate", or "meta-review".`,
            };
        },
    }));
}
