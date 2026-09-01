import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadEffectiveConfig, resolveProjectRootForExec } from '../config-loader.ts'
import { runWithJob } from '../jobs.ts'
import {
  buildReviewPlan,
  buildReviewReport,
  sanitizeRounds,
  validateRoundsSchema,
} from '../review.ts'
import { buildFinalReviewReport, metaReviewReport } from '../meta-review.ts'
import { evidenceToPlain, verifyFindings } from '../evidence.ts'
import {
  collectScopeFiles,
  computeCoverage,
  coverageToDict,
} from '../review-scope.ts'
import { resolveChangedFiles } from '../git-scope.ts'
import type { KnownIntentional, ReviewAttachment, ReviewFinding, ReviewReport, ReviewRound } from '../types.ts'
import type { CoverageResult } from '../review-scope.ts'

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
          description:
            'For `aggregate`: array of per-round findings, e.g. ' +
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
          description:
            'For `aggregate`: known-intentional entries to filter out, e.g. ' +
            '[{"file":"db/queries.py","line":42,"dimension":"security","reason":"..."}]. line=0/omitted = whole file.',
        },
        report: {
          type: 'json',
          description:
            'For `meta-review`: the ReviewReport JSON (as returned by `aggregate`) to audit for ' +
            'internal consistency and produce the final review report.',
        },
        attachments: {
          type: 'json',
          description:
            'Optional (plan only): image/visual attachments to thread into the review, e.g. ' +
            '[{"path":"screens/hits.png","caption":"reproduced layout bug"}]. Each entry: ' +
            '{path?, data?, media_type?, caption?} — path resolves relative to the project root, ' +
            'data is a base64 payload (media_type e.g. image/png), caption gives human context. ' +
            'Injected as a mandatory clause into every dimension reviewer prompt so screenshots/' +
            'mockups/failure repros are weighed alongside the code.',
        },
        fixedCount: {
          type: 'integer',
          description:
            'For `aggregate` (normal mode only): number of atomic fixes applied so far. ' +
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
            schemaValidation: {
              type: 'json',
              description:
                'For `aggregate`: per-round schema validation results (round, valid, issues). ' +
                'Present only when reviewer.output_schema_validation is enabled; the workflow ' +
                'retries rounds with valid=false (≤2 times) before forwarding findings.',
            },
            evidence: { type: 'json' },
            coverage: {
              type: 'json',
              description:
                'For `meta-review`: prompt-informative scope coverage result ' +
                '(assigned vs self-reported reads). Present only when ' +
                'reviewer.coverage_validation is enabled and readFiles were supplied.',
            },
            finalReport: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args, exec) {
        const { result } = await runWithJob(ctx, 'iterate-review', `iterate_review ${String(args.operation ?? '')} (${String(args.mode ?? 'dry-run')})`, async () => {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) {
          return { operation: args.operation, error: resolved.reason }
        }
        const projectRoot = resolved.root
        // Effective config = defaults merged with project overrides. Never
        // null, so `plan`/`aggregate` work even without a config file.
        const { config } = loadEffectiveConfig(projectRoot)
        const mode = args.mode ?? 'dry-run'

        if (args.operation === 'plan') {
          const maxReviewRounds = args.maxReviewRounds ?? config.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS
          const knownIntentional = (config.personalization as { known_intentional?: KnownIntentional[] } | undefined)
            ?.known_intentional
          // changed-only scope: resolve the changed-file set against
          // git.target_branch before building the plan so reviewers get the
          // concrete file list (and the plan auto-falls back to full when there
          // are no changes). git failures degrade to a full-scope plan.
          let changedFiles: string[] | undefined
          if (config.review?.scope === 'changed-only') {
            const gitScope = await resolveChangedFiles(projectRoot, config.git?.target_branch ?? 'main')
            changedFiles = gitScope.changedFiles
          }
          // Full-codebase review: pre-collect the source inventory so
          // buildReviewPlan can batch it into per-chunk reviewer tasks
          // (coverage enforcement).
          let scopeFiles: string[] | undefined
          if (config.review?.scope === 'full') {
            scopeFiles = collectScopeFiles(projectRoot, { scope: 'full' })
          }
          // Thread image/visual attachments (screenshots/mockups/failure repros)
          // into the plan so every reviewer prompt weighs them alongside code.
          const attachments = Array.isArray(args.attachments)
            ? (args.attachments as ReviewAttachment[]).filter(
                (a): a is ReviewAttachment =>
                  Boolean(a) &&
                  typeof a === 'object' &&
                  ((typeof a.path === 'string' && a.path.length > 0) ||
                    (typeof a.data === 'string' && a.data.length > 0)),
              )
            : []
          const plan = buildReviewPlan({ config, mode, maxReviewRounds, knownIntentional, changedFiles, scopeFiles, attachments })
          return { operation: 'plan', mode, found: true, plan: plan as unknown as JsonValue }
        }

        if (args.operation === 'aggregate') {
          const rawRounds = Array.isArray(args.rounds) ? args.rounds : []
          const rounds: ReviewRound[] = rawRounds
            .map((r) => {
              const rr = r as { round?: number; findings?: unknown; readFiles?: unknown }
              const findings = Array.isArray(rr?.findings) ? (rr.findings as ReviewFinding[]) : []
              const readFiles = Array.isArray(rr?.readFiles)
                ? (rr.readFiles as unknown[]).filter((f): f is string => typeof f === 'string')
                : []
              return { round: typeof rr?.round === 'number' ? rr.round : 0, findings, readFiles }
            })
            .filter((r: ReviewRound) => r.round > 0)

          if (rounds.length === 0) {
            return {
              operation: 'aggregate',
              mode,
              error: 'rounds must be a non-empty array of {round, findings}.',
            }
          }

          const maxReviewRounds = args.maxReviewRounds ?? config.max_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS
          const goal = args.goal ?? config.goal ?? ''
          const dimensions = config.dimensions ?? []

          // Output schema validation gate (reviewer.output_schema_validation,
          // default true): validate every round's findings against the findings
          // schema, then drop schema-invalid entries before the deterministic
          // core so malformed reviewer output can never crash dedupe/sort or
          // leak into fixes. The `schemaValidation` array is surfaced so the
          // workflow can retry failing rounds (≤2 times) with a strict-JSON
          // nudge. When disabled, non-object entries are still dropped for
          // crash-safety.
          const schemaEnabled = config.reviewer?.output_schema_validation !== false
          const schemaValidation = schemaEnabled ? validateRoundsSchema(rounds) : null
          const cleanRounds = sanitizeRounds(rounds, schemaValidation)

          const report = buildReviewReport({
            mode,
            goal,
            dimensions,
            maxReviewRounds,
            rounds: cleanRounds,
            knownIntentional: args.knownIntentional as KnownIntentional[] | undefined,
            fixedCount: typeof args.fixedCount === 'number' ? args.fixedCount : undefined,
          })
          return {
            operation: 'aggregate',
            mode,
            report: report as unknown as JsonValue,
            schemaValidation: (schemaValidation ?? null) as unknown as JsonValue | null,
          }
        }

        if (args.operation === 'meta-review') {
          const source = args.report as ReviewReport | undefined
          if (!source || typeof source !== 'object') {
            return {
              operation: 'meta-review',
              mode,
              error: 'report must be a ReviewReport JSON object (as returned by `aggregate`).',
            }
          }
          const audit = metaReviewReport(source)
          // Hard code-evidence gate (default on): every finding's file/line is
          // validated against real files on disk before folding into the final
          // verdict. Disable via config `reviewer.evidence_validation: false`.
          const evidenceEnabled = config.reviewer?.evidence_validation !== false
          const findings: ReviewFinding[] = Array.isArray(source.findings) ? source.findings : []
          const evidence = evidenceEnabled ? verifyFindings(projectRoot, findings) : null
          // Prompt-informative coverage: compare the reviewer's self-reported
          // reads against the assigned scope inventory (never flips the
          // verdict). Disable via config `reviewer.coverage_validation: false`.
          const coverageEnabled = config.reviewer?.coverage_validation !== false
          let coverage: CoverageResult | null = null
          if (coverageEnabled) {
            const assigned = collectScopeFiles(projectRoot, {
              scope: config.review?.scope === 'changed-only' ? 'changed-only' : 'full',
            })
            const readFiles = Array.isArray((source as unknown as { readFiles?: unknown }).readFiles)
              ? ((source as unknown as { readFiles?: unknown }).readFiles as string[])
              : null
            if (readFiles && readFiles.length > 0) {
              coverage = computeCoverage(assigned, readFiles)
            }
          }
          const finalReport = buildFinalReviewReport(source, { evidence, coverage })
          return {
            operation: 'meta-review',
            mode,
            found: true,
            report: audit as unknown as JsonValue,
            evidence: evidence ? (evidenceToPlain(evidence) as unknown as JsonValue) : null,
            coverage: coverage ? (coverageToDict(coverage) as unknown as JsonValue) : null,
            finalReport: finalReport as unknown as JsonValue,
          }
        }

        return {
          operation: args.operation,
          error: `Unknown operation "${args.operation}". Use "plan", "aggregate", or "meta-review".`,
        }
        })
        return result
      },
    }),
  )
}