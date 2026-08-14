import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { loadConfig } from '../config-loader.ts'
import { buildReviewPlan, buildReviewReport } from '../review.ts'
import type { KnownIntentional, ReviewFinding, ReviewRound } from '../types.ts'

/** Default round cap when neither the arg nor config provides one. */
const DEFAULT_MAX_REVIEW_ROUNDS = 3

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
export function registerReviewTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_review',
      description:
        'Deterministic review engine for the iterate workflow. ' +
        'Use `plan` to generate the review plan (dimensions, reviewer prompts, findings schema, round cap) ' +
        'for normal or dry-run mode. Use `aggregate` to merge raw per-round findings into a deduped, ' +
        'severity-sorted report with multi-round convergence statistics. ' +
        '`aggregate` is purely computational — it never modifies any file.',

      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"plan" to build the review plan, "aggregate" to merge findings.',
          enum: ['plan', 'aggregate'],
        },
        mode: {
          type: 'string',
          description: 'Review mode: "dry-run" (pure review, no fixes) or "normal" (autonomous loop). Default: dry-run.',
          enum: ['dry-run', 'normal'],
        },
        rounds: {
          type: 'json',
          description:
            'For `aggregate`: array of per-round findings, e.g. ' +
            '[{"round":1,"findings":[...]},{"round":2,"findings":[...]}]. Each finding: ' +
            '{dimension,file,line?,severity,summary,detail,classification}.',
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
          description:
            'For `aggregate`: known-intentional entries to filter out, e.g. ' +
            '[{"file":"db/queries.py","line":42,"dimension":"security","reason":"..."}]. line=0/omitted = whole file.',
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
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args) {
        const projectRoot = args.path ?? process.cwd()
        const config = loadConfig(projectRoot)
        const mode = args.mode ?? 'dry-run'

        if (args.operation === 'plan') {
          if (!config) {
            return {
              operation: 'plan',
              mode,
              found: false,
              error: 'iterate.config.yaml not found or unparseable at project root.',
            }
          }
          const maxReviewRounds = args.maxReviewRounds ?? config.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS
          const knownIntentional = (config.personalization as { known_intentional?: KnownIntentional[] } | undefined)
            ?.known_intentional
          const plan = buildReviewPlan({ config, mode, maxReviewRounds, knownIntentional })
          return { operation: 'plan', mode, found: true, plan: plan as unknown as JsonValue }
        }

        if (args.operation === 'aggregate') {
          const rawRounds = Array.isArray(args.rounds) ? args.rounds : []
          const rounds: ReviewRound[] = rawRounds
            .map((r) => {
              const rr = r as { round?: number; findings?: unknown }
              const findings = Array.isArray(rr?.findings) ? (rr.findings as ReviewFinding[]) : []
              return { round: typeof rr?.round === 'number' ? rr.round : 0, findings }
            })
            .filter((r: ReviewRound) => r.round > 0)

          if (rounds.length === 0) {
            return {
              operation: 'aggregate',
              mode,
              error: 'rounds must be a non-empty array of {round, findings}.',
            }
          }

          const maxReviewRounds = args.maxReviewRounds ?? config?.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS
          const goal = args.goal ?? config?.goal ?? ''
          const dimensions = config?.dimensions ?? []
          const report = buildReviewReport({
            mode,
            goal,
            dimensions,
            maxReviewRounds,
            rounds,
            knownIntentional: args.knownIntentional as KnownIntentional[] | undefined,
          })
          return { operation: 'aggregate', mode, report: report as unknown as JsonValue }
        }

        return {
          operation: args.operation,
          error: `Unknown operation "${args.operation}". Use "plan" or "aggregate".`,
        }
      },
    }),
  )
}