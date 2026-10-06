import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadEffectiveConfig, resolveProjectRootForExec } from '../config-loader.ts'
import { runWithJob } from '../jobs.ts'
import {
  buildReviewPlan,
  buildReviewReport,
  sanitizeRounds,
  validateRoundsSchema,
  MAX_REVIEW_ROUNDS_CAP,
} from '../review.ts'
import { buildFinalReviewReport, metaReviewReport } from '../meta-review.ts'
import { evidenceToPlain, resolveWithin, verifyFindings } from '../evidence.ts'
import { readKnownIntentional } from './triage.ts'
import { asNumber, asRecord, parseRenderedJson } from './present.ts'
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
 * Resolve the effective round cap at the TOOL boundary so `plan` and
 * `aggregate` can never disagree on it (the plan advertises a cap the
 * aggregate must then honor).
 *
 * Precedence: a FINITE caller value → a FINITE config value → the default (3).
 * A non-finite / non-numeric caller value does NOT collapse to 1 — it falls
 * through to the config value (the old doc comment claimed otherwise, which
 * the implementation never did). Only a finite `≤ 0` value collapses to 1,
 * the smallest sane cap.
 *
 * The resolved value is then clamped to `[1, MAX_REVIEW_ROUNDS_CAP]`, so an
 * absurd caller value (1e15) can no longer leak an unbounded cap into the
 * report's `maxReviewRounds` field (`buildReviewReport` echoes its input and
 * `aggregateRounds` sizes `findingsByRound` from it). Upper clamp mirrors
 * `clampMaxReviewRounds` in src/review.ts.
 */
export function resolveMaxReviewRounds(argsMax: unknown, configMax: unknown): number {
  const raw =
    typeof argsMax === 'number' && Number.isFinite(argsMax)
      ? argsMax
      : typeof configMax === 'number' && Number.isFinite(configMax)
        ? configMax
        : DEFAULT_MAX_REVIEW_ROUNDS
  return Math.min(MAX_REVIEW_ROUNDS_CAP, Math.max(1, Math.floor(raw)))
}

/**
 * Build the READ set backing the meta-review evidence verdict from the
 * report's self-reported `readFiles` (aggregated across rounds; falls back to
 * the per-round lists for older reports that predate the flat field).
 *
 * Entries are resolved the SAME way `verifyFinding` resolves a finding's
 * `file` (lexical, root-relative) so the Set membership check matches, and
 * entries escaping the project root are dropped. Returns `undefined` when
 * nothing was read — an absent read set keeps `readVerified` "not checkable"
 * (null ratio) instead of a misleading `0.0`.
 */
function buildReadSet(projectRoot: string, report: ReviewReport): Set<string> | undefined {
  const raw: unknown[] = []
  if (Array.isArray(report.readFiles)) {
    raw.push(...report.readFiles)
  } else if (Array.isArray(report.rounds)) {
    for (const r of report.rounds) {
      const files = (r as { readFiles?: unknown } | null | undefined)?.readFiles
      if (Array.isArray(files)) raw.push(...files)
    }
  }
  const set = new Set<string>()
  for (const p of raw) {
    if (typeof p !== 'string' || p === '') continue
    const abs = resolveWithin(projectRoot, p)
    if (abs !== null) set.add(abs)
  }
  return set.size > 0 ? set : undefined
}

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
/**
 * Card headline for an `aggregate` result: what the report found and where
 * convergence stands (#12). Defensive — returns `undefined` whenever the
 * payload is not the shape this tool renders, so the card is declined rather
 * than guessed at.
 */
function aggregateHeadline(value: Record<string, unknown>): string | undefined {
  const report = asRecord(value.report)
  const summary = report ? asRecord(report.summary) : undefined
  const total = summary ? asNumber(summary.totalFindings) : undefined
  if (total === undefined || !summary) return undefined
  const buckets = (['critical', 'high', 'medium', 'low'] as const)
    .map((k) => ({ label: k, n: asNumber(summary[k]) ?? 0 }))
    .filter((b) => b.n > 0)
    .map((b) => `${b.n} ${b.label}`)
  const convergence = report ? asRecord(report.convergence) : undefined
  // A mid-run aggregate legitimately has converged:false — say so instead of
  // implying the run is over.
  const status = convergence && convergence.converged === true ? 'converged' : 'not converged yet'
  return (
    `Review report: ${total} finding${total === 1 ? '' : 's'}` +
    (buckets.length > 0 ? ` (${buckets.join(', ')})` : '') +
    ` — ${status}`
  )
}

/**
 * Card headline for a `meta-review` result: the verdict plus what the audit
 * checked (#12). Same defensive contract as {@link aggregateHeadline}.
 */
function metaReviewHeadline(value: Record<string, unknown>): string | undefined {
  const finalReport = asRecord(value.finalReport)
  if (!finalReport) return undefined
  const verdict = typeof finalReport.verdict === 'string' && finalReport.verdict
    ? finalReport.verdict
    : undefined
  if (!verdict) return undefined
  const meta = asRecord(finalReport.metaReview)
  const issues = meta && Array.isArray(meta.issues) ? meta.issues.length : undefined
  const checks = meta ? asNumber(meta.checksRun) : undefined
  const bits = [
    issues !== undefined ? `${issues} issue${issues === 1 ? '' : 's'}` : '',
    checks !== undefined ? `${checks} check${checks === 1 ? '' : 's'} run` : '',
  ].filter(Boolean)
  return `Meta-review: ${verdict}` + (bits.length > 0 ? ` (${bits.join(', ')})` : '')
}

export function registerReviewTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_review',
      // Result card (#12): aggregate/meta-review results are large raw-JSON
      // bodies — give them a readable headline (finding counts + convergence /
      // verdict) instead of an unsummarized blob. Only these two operations
      // get a card; `plan` keeps the default. Pure: parsed from the rendered
      // result only (replay-safe); a shape miss declines the card.
      presentResult: (args, result) => {
        if (result.isError) return undefined
        const a = args as { operation?: unknown }
        const op = a.operation
        if (op !== 'aggregate' && op !== 'meta-review') return undefined
        const value = parseRenderedJson(result)
        if (!value) return undefined
        const title = op === 'aggregate' ? aggregateHeadline(value) : metaReviewHeadline(value)
        return title ? { card: 'generic', title } : undefined
      },
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
          const maxReviewRounds = resolveMaxReviewRounds(args.maxReviewRounds, config.max_rounds)
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
            // Boundary guard: convergence is keyed on `round - 1`, so a
            // fractional/zero/NaN round (`1.5`, `NaN` — all passable through
            // the `json` argument) must never reach the deterministic core.
            // Mirrors the core's own `Number.isInteger(round) && round >= 1`
            // filter; a non-integer round is simply "not a round" here.
            .filter((r: ReviewRound) => Number.isInteger(r.round) && r.round >= 1)

          if (rounds.length === 0) {
            return {
              operation: 'aggregate',
              mode,
              error: 'rounds must be a non-empty array of {round, findings}.',
            }
          }

          const maxReviewRounds = resolveMaxReviewRounds(args.maxReviewRounds, config.max_rounds)
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
            // `type:'json'` passes schema validation for ANY JSON value, so a
            // bare string/object used to reach filterKnownIntentional →
            // `known.some` TypeError that escaped execute. Every sibling json
            // arg is guarded the same way: a non-array means "no known
            // entries" (identical to omitting it). The element shape reuses
            // triage's guard — the same one behind the config-sourced list —
            // so config-provided and arg-provided rows stay interchangeable.
            knownIntentional: Array.isArray(args.knownIntentional)
              ? readKnownIntentional({
                  personalization: { known_intentional: args.knownIntentional },
                })
              : undefined,
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
          // READ set for the evidence verdict: `readVerified`/`readVerifiedRatio`
          // are only computable when the audit knows which files reviewers
          // actually opened, yet the tool never supplied one — so the skill
          // prompt's "every finding anchors to real, READ code" was
          // unverifiable (always null). The report already aggregates every
          // round's self-reported `readFiles`; wiring it through evidence.ts's
          // existing optional `readSet` needs no core change. An empty read
          // list keeps the "not checkable" (null) semantics instead of 0.0.
          const readSet = buildReadSet(projectRoot, source)
          const evidence = evidenceEnabled
            ? verifyFindings(projectRoot, findings, readSet ? { readSet } : {})
            : null
          // Prompt-informative coverage: compare the reviewer's self-reported
          // reads against the assigned scope inventory (never flips the
          // verdict). Disable via config `reviewer.coverage_validation: false`.
          const coverageEnabled = config.reviewer?.coverage_validation !== false
          let coverage: CoverageResult | null = null
          if (coverageEnabled) {
            // Build the assigned inventory the SAME way `plan` builds it: a
            // changed-only scope uses the resolved git-diff file set, and
            // falls back to the FULL walk when git is unavailable or nothing
            // changed (mirrors buildReviewPlan's effective-scope decision), so
            // the coverage ratio reflects the files reviewers were actually
            // told to read — never a vacuous 1.0 on an empty inventory.
            let assigned: string[]
            if (config.review?.scope === 'changed-only') {
              const gitScope = await resolveChangedFiles(projectRoot, config.git?.target_branch ?? 'main')
              assigned =
                gitScope.changedFiles.length > 0
                  ? collectScopeFiles(projectRoot, { scope: 'changed-only', changedFiles: gitScope.changedFiles })
                  : collectScopeFiles(projectRoot, { scope: 'full' })
            } else {
              assigned = collectScopeFiles(projectRoot, { scope: 'full' })
            }
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