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

import type {
  IterateConfig,
  KnownIntentional,
  ReviewAttachment,
  ReviewFinding,
  ReviewReport,
  ReviewRound,
} from './types.ts'
import { DEFAULT_SCOPE_CHUNK_SIZE, chunkFiles } from './review-scope.ts'

/** Severity ordering: lower rank = more severe. */
export const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Sort findings by severity (most severe first), then by file path. */
export function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    // Guard against an out-of-spec severity string (e.g. from a model that
    // bypassed the schema): treat it as the least severe so NaN never enters
    // the comparator and ordering stays deterministic.
    const rankA = SEVERITY_RANK[a.severity] ?? SEVERITY_RANK.low
    const rankB = SEVERITY_RANK[b.severity] ?? SEVERITY_RANK.low
    const bySeverity = rankA - rankB
    if (bySeverity !== 0) return bySeverity
    // Defensive coercion: `file`/`line` can be wrong-typed when schema
    // validation is disabled — String()/Number() keep the comparator total.
    const byFile = String(a.file ?? '').localeCompare(String(b.file ?? ''))
    if (byFile !== 0) return byFile
    return (Number(a.line) || 0) - (Number(b.line) || 0)
  })
}

/** Normalize a summary so near-identical duplicates collapse to one key. */
export function normalizeSummary(summary: string): string {
  return summary
    .trim()
    .toLowerCase()
    .replace(/[\s\n\t]+/g, ' ')
}

/**
 * Dedupe key: same file + same dimension + similar summary + explicit line.
 * Including the line keeps two genuine issues with identical wording at
 * different locations from collapsing into one (the line is omitted only when
 * neither side anchors one, i.e. whole-file findings).
 */
export function findingKey(f: ReviewFinding): string {
  const line = typeof f.line === 'number' && f.line > 0 ? f.line : 0
  return `${f.file}|${f.dimension}|${line}|${normalizeSummary(f.summary)}`
}

/**
 * Remove duplicate findings within a list.
 * Keeps the first occurrence of each dedupe key.
 */
export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>()
  const out: ReviewFinding[] = []
  for (const f of findings) {
    const key = findingKey(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/**
 * Filter out findings that match a `known_intentional` entry.
 * Match rule (mirrors SKILL.md Phase 1 FILTER):
 *  - same `file` AND same `dimension`, AND
 *  - entry `line` is 0/undefined (whole file) OR equals the finding's line.
 */
export function filterKnownIntentional(
  findings: ReviewFinding[],
  known: KnownIntentional[] | undefined,
): ReviewFinding[] {
  if (!known || known.length === 0) return findings
  return findings.filter((f) => {
    const matched = known.some((k) => {
      const sameFile = k.file === f.file
      const sameDim = k.dimension === f.dimension
      if (!sameFile || !sameDim) return false
      const wholeFile = k.line === undefined || k.line === 0
      if (wholeFile) return true
      return k.line === f.line
    })
    return !matched
  })
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
export function aggregateRounds(
  rounds: ReviewRound[],
  maxReviewRounds: number,
): {
  findings: ReviewFinding[]
  findingsByRound: number[]
  firstRoundByKey: Map<string, number>
} {
  const seen = new Set<string>()
  const firstRoundByKey = new Map<string, number>()
  const merged: ReviewFinding[] = []

  // Guard: round numbers are expected to be positive integers. Skip malformed
  // entries defensively rather than letting `firstRoundByKey` key on NaN/0 or
  // crashing on null / non-array findings.
  // Hard ceiling: round numbers are model-authored JSON; an absurd round (e.g.
  // 1e9) would otherwise allocate an array of that size below (OOM). Round
  // numbers above the configured cap are clamped to the cap.
  let maxRound = 0
  const roundCap = Math.max(1, maxReviewRounds)
  for (const round of rounds) {
    if (!round || typeof round !== 'object') continue
    if (typeof round.round !== 'number' || !Number.isInteger(round.round) || round.round < 1) continue
    const findings = Array.isArray(round.findings) ? round.findings : []
    if (round.round > maxRound) maxRound = round.round
    for (const f of findings) {
      const key = findingKey(f)
      if (seen.has(key)) continue
      seen.add(key)
      firstRoundByKey.set(key, round.round)
      merged.push(f)
    }
  }
  // Clamp the allocation bound so a hostile round number cannot OOM the tool.
  const effectiveMax = Math.min(maxRound, Math.max(1, roundCap * 2))

  const findingsByRound: number[] = []
  for (let r = 1; r <= effectiveMax; r++) {
    let count = 0
    for (const key of firstRoundByKey.keys()) {
      if (firstRoundByKey.get(key) === r) count++
    }
    findingsByRound.push(count)
  }

  return { findings: dedupeFindings(merged), findingsByRound, firstRoundByKey }
}

/**
 * Compute convergence statistics for a dry-run review.
 */
export function computeConvergence(
  rounds: ReviewRound[],
  maxReviewRounds: number,
): ReviewReport['convergence'] {
  const { findingsByRound } = aggregateRounds(rounds, maxReviewRounds)
  const totalRounds = rounds.length
  // `findingsByRound` is indexed by the actual round number (round r → index
  // r-1), sized to the highest present round (clamped). Convergence must read
  // the HIGHEST PRESENT round's count — not the last array element (rounds
  // may arrive unsorted) and not `totalRounds - 1` (only valid for contiguous
  // 1..N). The count index is bounded by the array length aggregateRounds
  // actually allocated.
  let lastRound = 0
  for (const round of rounds) {
    if (!round || typeof round.round !== 'number' || !Number.isInteger(round.round) || round.round < 1) continue
    if (round.round > lastRound) lastRound = round.round
  }
  const idx = Math.min(lastRound, findingsByRound.length) - 1
  const lastRoundCount = idx >= 0 ? (findingsByRound[idx] ?? 0) : 0
  const converged = totalRounds > 0 && lastRoundCount === 0
  return {
    totalRounds,
    findingsByRound,
    converged,
    stoppedReason:
      totalRounds === 0
        ? 'max_rounds_reached'
        : converged
          ? 'converged'
          : 'max_rounds_reached',
  }
}

/** Build a severity/summary breakdown map for the report. */
function summarize(findings: ReviewFinding[]): ReviewReport['summary'] {
  const summary: ReviewReport['summary'] = {
    totalFindings: findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    byDimension: {},
  }
  for (const f of findings) {
    if (f.severity === 'critical') summary.critical++
    else if (f.severity === 'high') summary.high++
    else if (f.severity === 'medium') summary.medium++
    else summary.low++
    summary.byDimension[f.dimension] = (summary.byDimension[f.dimension] ?? 0) + 1
  }
  return summary
}

/**
 * Assemble the final ReviewReport from raw per-round findings.
 * Applies known_intentional filtering, cross-round dedupe, severity sort,
 * and convergence stats in one deterministic pass. Shared by dry-run (pure
 * review) and normal (autonomous loop) modes — the mode only records intent;
 * the math is identical.
 */
export function buildReviewReport(input: {
  mode: 'dry-run' | 'normal'
  goal: string
  dimensions: string[]
  maxReviewRounds: number
  rounds: ReviewRound[]
  knownIntentional?: KnownIntentional[]
  /** Number of atomic fixes applied so far. Normal mode only; omitted in dry-run. */
  fixedCount?: number
}): ReviewReport {
  // 1. Filter known-intentional per round (before cross-round dedupe).
  const filteredRounds = input.rounds.map((r) => ({
    round: typeof r?.round === 'number' ? r.round : 0,
    findings: filterKnownIntentional(
      Array.isArray(r?.findings) ? r.findings : [],
      input.knownIntentional,
    ),
    readFiles: Array.isArray(r?.readFiles) ? r.readFiles : [],
  }))

  // 2. Cross-round dedupe + per-round "first seen" tracking.
  const { findings, findingsByRound } = aggregateRounds(
    filteredRounds,
    input.maxReviewRounds,
  )

  // 3. Severity sort the global result.
  const sorted = sortFindings(findings)

  // 4. Convergence. Must be identical to `computeConvergence`: `findingsByRound`
  //    is indexed by the actual round number (round r → index r-1) and sized to
  //    the highest round, so convergence reads the LAST PRESENT round's count
  //    using its reported round number — NOT `filteredRounds.length - 1`, which
  //    is only valid for contiguous 1..N round numbers (resumed iterations and
  //    non-contiguous round sets would otherwise read the wrong count).
  const lastRound =
    filteredRounds.length > 0 ? filteredRounds[filteredRounds.length - 1]!.round : 0
  const lastRoundCount =
    lastRound > 0 ? (findingsByRound[lastRound - 1] ?? 0) : 0
  const converged = filteredRounds.length > 0 && lastRoundCount === 0

  // Attach the normal-mode fix count to the summary (dry-run leaves it absent).
  const computed = summarize(sorted)
  if (input.mode === 'normal' && typeof input.fixedCount === 'number' && Number.isInteger(input.fixedCount)) {
    computed.fixedCount = input.fixedCount
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
    readFiles: ([] as string[]).concat(...filteredRounds.map((r) => r.readFiles ?? [])),
    convergence: {
      totalRounds: filteredRounds.length,
      findingsByRound,
      converged,
      stoppedReason:
        filteredRounds.length === 0
          ? 'max_rounds_reached'
          : converged
            ? 'converged'
            : 'max_rounds_reached',
    },
    summary: computed,
  }
}

/**
 * JSON Schema for reviewer subagent structured output.
 * Object-rooted (dsh `agent` opts.schema requires object-rooted schemas with
 * only type/properties/required/additionalProperties/items/enum/const/oneOf).
 */
export function findingsSchema(): Record<string, unknown> {
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
        description:
          'Every file you actually opened with read_file while reviewing your assigned scope. Used to audit coverage; files you never opened count as un-reviewed.',
      },
    },
    required: ['findings', 'readFiles'],
  }
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
] as const

/** Allowed severity values (mirrors the schema enum). */
export const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const

/** String-typed finding fields (type check only, presence handled by REQUIRED). */
const STRING_FINDING_FIELDS = [
  'dimension',
  'file',
  'summary',
  'failure_scenario',
  'suggested_fix',
] as const

/** One schema violation for a single finding entry. */
export interface FindingSchemaIssue {
  /** Index into the findings array; -1 when the whole `findings` is malformed. */
  index: number
  /** Field path, e.g. "findings[2].severity". */
  field: string
  /** Human-readable reason. */
  message: string
}

/**
 * Validate an arbitrary parsed value against the findings schema shape.
 * Accepts the `{findings: [...]}` wrapper OR a bare findings array, so callers
 * can validate either the raw reviewer output object or a round's findings.
 * Pure and deterministic — never touches the filesystem.
 */
export function validateFindingsSchema(input: unknown): FindingSchemaIssue[] {
  const raw = (input as { findings?: unknown } | null)?.findings ?? input
  if (!Array.isArray(raw)) {
    return [
      {
        index: -1,
        field: 'findings',
        message: 'expected a JSON array of finding objects',
      },
    ]
  }

  const issues: FindingSchemaIssue[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({
        index: i,
        field: `findings[${i}]`,
        message: 'expected a finding object',
      })
      continue
    }
    const f = item as Record<string, unknown>

    for (const key of REQUIRED_FINDING_FIELDS) {
      if (f[key] === undefined || f[key] === null) {
        issues.push({
          index: i,
          field: `findings[${i}].${key}`,
          message: `required field "${key}" is missing`,
        })
      }
    }
    for (const key of STRING_FINDING_FIELDS) {
      if (f[key] !== undefined && f[key] !== null && typeof f[key] !== 'string') {
        issues.push({
          index: i,
          field: `findings[${i}].${key}`,
          message: `"${key}" must be a string`,
        })
      }
    }
    if (
      f.severity !== undefined &&
      f.severity !== null &&
      !SEVERITY_VALUES.includes(f.severity as (typeof SEVERITY_VALUES)[number])
    ) {
      issues.push({
        index: i,
        field: `findings[${i}].severity`,
        message: `severity must be one of: ${SEVERITY_VALUES.join(', ')}`,
      })
    }
    if (
      f.is_atomic !== undefined &&
      f.is_atomic !== null &&
      typeof f.is_atomic !== 'boolean'
    ) {
      issues.push({
        index: i,
        field: `findings[${i}].is_atomic`,
        message: 'is_atomic must be a boolean',
      })
    }
    if (
      f.line !== undefined &&
      f.line !== null &&
      (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < 0)
    ) {
      issues.push({
        index: i,
        field: `findings[${i}].line`,
        message: 'line must be a non-negative integer (0 = whole-file)',
      })
    }
  }
  return issues
}

/** Per-round schema validation outcome. */
export interface RoundSchemaValidation {
  round: number
  /** True when every finding in the round conforms to the schema. */
  valid: boolean
  issues: FindingSchemaIssue[]
}

/**
 * Validate every round's findings against the findings schema.
 * Round order matches the input `rounds` array.
 */
export function validateRoundsSchema(rounds: ReviewRound[]): RoundSchemaValidation[] {
  return rounds.map((r) => {
    const issues = validateFindingsSchema(Array.isArray(r?.findings) ? r.findings : [])
    return { round: typeof r?.round === 'number' ? r.round : 0, valid: issues.length === 0, issues }
  })
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
export function sanitizeRounds(
  rounds: ReviewRound[],
  schemaValidation: RoundSchemaValidation[] | null,
): ReviewRound[] {
  return rounds.map((r, i) => {
    // Defensive: malformed rounds must never crash the deterministic core.
    const findings = Array.isArray(r?.findings) ? r.findings : []
    const roundNo = typeof r?.round === 'number' ? r.round : 0
    const readFiles = Array.isArray(r?.readFiles) ? r.readFiles : []
    if (schemaValidation) {
      const issues = schemaValidation[i]?.issues ?? []
      if (issues.some((iss) => iss.index === -1)) return { round: roundNo, findings: [], readFiles }
      const bad = new Set(issues.map((iss) => iss.index))
      return {
        round: roundNo,
        findings: findings.filter((_, fi) => !bad.has(fi)),
        readFiles,
      }
    }
    return {
      round: roundNo,
      findings: findings.filter(
        (f): f is ReviewFinding =>
          Boolean(f) && typeof f === 'object' && !Array.isArray(f),
      ),
      readFiles,
    }
  })
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
export function attachmentClause(attachments: ReviewAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return ''
  const lines: string[] = []
  for (const a of attachments) {
    if (!a || typeof a !== 'object') continue
    if (typeof a.path === 'string' && a.path) {
      lines.push(`- ${a.path}${typeof a.caption === 'string' && a.caption ? ` (${a.caption})` : ''}`)
    } else if (typeof a.data === 'string' && a.data) {
      const kind = typeof a.media_type === 'string' && a.media_type ? a.media_type : 'image'
      lines.push(`- inline ${kind} image${typeof a.caption === 'string' && a.caption ? ` (${a.caption})` : ''}`)
    }
  }
  if (lines.length === 0) return ''
  return (
    'ATTACHED VISUAL CONTEXT (mandatory): the following image attachment(s) were provided ' +
    'with this review — each one is part of the evidence you must weigh:\n' +
    lines.join('\n') +
    '\nYou MUST inspect/consider EVERY attachment before judging your dimension (open it ' +
    'with a vision-capable tool, or use image_to_text if your model cannot see images). ' +
    'If an attachment is inaccessible, state that and judge solely on the code. Do not ' +
    'ignore an attachment just because it is not code.'
  )
}

/**
 * Build the task prompt for one dimension's reviewer subagent.
 * In dry-run mode, pass `alreadyKnown` (the findings from earlier rounds) so the
 * reviewer hunts for NEW issues only — that is what makes "反复审查" converge.
 */
export function reviewerTaskPrompt(input: {
  dimension: string
  goal: string
  scope: 'full' | 'changed-only'
  mode: 'normal' | 'dry-run'
  alreadyKnown?: ReviewFinding[]
  outputLanguage: string
  /** Atomic fix threshold from config.atomic. */
  maxLines: number
  /**
   * Files to review under `changed-only` scope (relative paths, resolved via
   * git diff against `git.target_branch`). Omitted/empty for `full` scope or
   * when no changes were detected (auto-fallback to full).
   */
  changedFiles?: string[]
  /**
   * The exact file inventory this reviewer is RESPONSIBLE for. When provided,
   * a mandatory COVERAGE RULE is injected: the reviewer must actually open
   * every listed file with read_file and return a `readFiles` array of what it
   * opened (the enforcement half of "每个子 agent 必须逐文件读取自己负责的审查
   * 范围"). Used for the chunked full-scope case; takes precedence over
   * `changedFiles`.
   */
  scopeFiles?: string[]
  /**
   * Per-dimension focus guidance (from personalization.dimension_focus, or the
   * skill's dimension definitions). Appended to the reviewer prompt so the
   * review concentrates on the areas the user cares about.
   */
  focus?: string
  /**
   * Image/visual attachments to weigh alongside the code (screenshots,
   * mockups, failure repros). Injected as a mandatory review-aware clause so
   * every dimension reviewer inspects/considers them before judging.
   */
  attachments?: ReviewAttachment[]
}): string {
  const parts: string[] = []
  parts.push(
    `You are the "${input.dimension}" reviewer for the iterate review.`,
    `Goal: ${input.goal}`,
    `Scope: ${input.scope === 'full' ? 'entire codebase' : 'changed files only'}.`,
  )
  if (input.focus) {
    parts.push(`FOCUS: ${input.focus}`)
  }
  const attached = attachmentClause(input.attachments)
  if (attached) {
    parts.push(attached)
  }
  if (input.scopeFiles && input.scopeFiles.length > 0) {
    parts.push(
      'COVERAGE RULE (mandatory): below is the exact file inventory you are ' +
        'assigned to review. You MUST open EVERY file in this inventory with ' +
        'the read_file tool before judging it — do not skip, skim-declare, or ' +
        'assume any file without reading it. Files you did not actually open ' +
        'are considered un-reviewed and will lower your coverage score. ' +
        'Return a `readFiles` array listing every file you actually opened.',
      'Assigned file inventory:',
      input.scopeFiles.map((p) => `- ${p}`).join('\n'),
    )
  } else if (
    input.scope === 'changed-only' &&
    input.changedFiles &&
    input.changedFiles.length > 0
  ) {
    parts.push(
      'Changed files to review (review ONLY these files; they are the diff against ' +
        'the target branch). You MUST open EVERY listed file with read_file ' +
        'before judging it — never skip or assume a file:',
      input.changedFiles.map((p) => `- ${p}`).join('\n'),
    )
  }
  if (input.mode === 'dry-run') {
    parts.push(
      'MODE: dry-run / pure review. You MUST NOT modify, create, or delete ANY file. Read-only analysis only.',
    )
  }
  if (input.alreadyKnown && input.alreadyKnown.length > 0) {
    parts.push(
      'Already-known findings from earlier rounds (do NOT re-report these; find NEW issues only):',
      JSON.stringify(input.alreadyKnown, null, 2),
    )
  } else {
    parts.push('This is round 1 — report every issue you find in this dimension.')
  }
  parts.push(
    'EVIDENCE RULE (mandatory): read every file you report on with the ' +
      'read_file tool BEFORE judging it. NEVER report a location you did not ' +
      'actually read — speculation about code you never inspected is a ' +
      'disqualifying failure, and fabricated line numbers are treated as ' +
      'poisoned evidence. Anchor every finding to real code.',
  )
  parts.push(
    `Return a JSON object: {"findings": [...], "readFiles": [...]}.`,
    `Each finding: dimension (must be "${input.dimension}"), file (relative path), ` +
      'line (optional; the exact line you READ for a line-targeted issue; ' +
      '0 or omitted for whole-file/module-level issues), ' +
      'severity (critical/high/medium/low), summary (one line), ' +
      'failure_scenario (how/when it fails, backed by the code you actually ' +
      'read), suggested_fix (the concrete fix), ' +
      `is_atomic (true if the fix is <= ${input.maxLines} lines within a SINGLE file/function, else false).`,
    `Write summaries and details in ${input.outputLanguage}.`,
  )
  return parts.join('\n')
}

/**
 * Build a review plan: how many rounds, which dimensions, and the reviewer
 * prompt template for each dimension. Used by the `iterate_review` tool's
 * `plan` operation to give the orchestrator a canonical spec.
 */
export function buildReviewPlan(input: {
  config: IterateConfig
  mode: 'normal' | 'dry-run'
  maxReviewRounds: number
  knownIntentional?: KnownIntentional[]
  /**
   * Files changed against `git.target_branch` (relative paths), resolved by the
   * tool when `review.scope` is `changed-only`. When the configured scope is
   * `changed-only` but no changes are detected, the plan auto-falls back to
   * `full` (mirrors SKILL.md: "无改动文件时自动 fallback 为 full").
   */
  changedFiles?: string[]
  /**
   * Pre-collected source inventory for a `full`-scope review. When provided,
   * it is split into `config.reviewer.scope_chunk_size` batches and every
   * (dimension × batch) pair gets its own reviewer task owning a bounded,
   * complete inventory it must open file-by-file.
   */
  scopeFiles?: string[]
  /**
   * Image/visual attachments to thread into the review. Injected as a
   * mandatory clause into every dimension's reviewer prompt and surfaced on
   * the returned plan so the orchestrator/report can reference them.
   */
  attachments?: ReviewAttachment[]
}): {
  mode: 'normal' | 'dry-run'
  goal: string
  scope: 'full' | 'changed-only'
  dimensions: { id: string; reviewerPrompt: string; findingsSchema: Record<string, unknown> }[]
  maxReviewRounds: number
  knownIntentional: KnownIntentional[]
  /** Files reviewed under `changed-only` scope (empty for `full` / fallback). */
  changedFiles: string[]
  /** True when scope was `changed-only` but no changes were found. */
  fallbackToFull: boolean
  /** The attachments threaded into every reviewer prompt (empty when none). */
  attachments: ReviewAttachment[]
} {
  // Defensive reads: a malformed config (e.g. `dimensions` as a non-array, or
  // `review`/`atomic` missing) must degrade to sane defaults instead of
  // throwing an uncaught TypeError inside the tool's `execute`.
  const language = input.config.language === 'zh' ? 'Chinese (中文)' : 'English'
  const goal = input.config.goal ?? ''
  const configuredScope = input.config.review?.scope ?? 'full'
  const dimensions = Array.isArray(input.config.dimensions) ? input.config.dimensions : []
  const maxLines = input.config.atomic?.max_lines ?? 20
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : []
  // Defensive parse: keep only well-formed attachment entries (path or data).
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.filter(
        (a): a is ReviewAttachment =>
          Boolean(a) &&
          typeof a === 'object' &&
          ((typeof a.path === 'string' && a.path.length > 0) ||
            (typeof a.data === 'string' && a.data.length > 0)),
      )
    : []
  // changed-only with zero detected changes → auto-fallback to full scope.
  const effectiveChangedOnly = configuredScope === 'changed-only' && changedFiles.length > 0
  const scope: 'full' | 'changed-only' = effectiveChangedOnly ? 'changed-only' : 'full'
  const fallbackToFull = configuredScope === 'changed-only' && changedFiles.length === 0

  // Scope batching (coverage enforcement): changed-only is a single batch
  // owning the full delta; full scope splits the collected inventory into
  // per-chunk reviewer tasks when scopeFiles is supplied.
  const chunkSize = Number(input.config.reviewer?.scope_chunk_size)
  const perChunk = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_SCOPE_CHUNK_SIZE
  let batches: (string[] | undefined)[]
  if (effectiveChangedOnly) {
    batches = [undefined]
  } else if (input.scopeFiles && input.scopeFiles.length > 0) {
    batches = chunkFiles(input.scopeFiles, perChunk).filter((b) => b.length > 0)
  } else {
    batches = [undefined]
  }

  const dimensionTasks: {
    id: string
    reviewerPrompt: string
    findingsSchema: Record<string, unknown>
  }[] = []
  // personalization.dimension_focus: [{dimension, focus}] — appended to the
  // matching dimension's reviewer prompt.
  const focusMap = new Map<string, string>()
  const pf = input.config.personalization as { dimension_focus?: { dimension?: string; focus?: string }[] } | undefined
  if (pf && Array.isArray(pf.dimension_focus)) {
    for (const entry of pf.dimension_focus) {
      if (entry && typeof entry.dimension === 'string' && typeof entry.focus === 'string' && entry.focus) {
        focusMap.set(entry.dimension, entry.focus)
      }
    }
  }
  for (const d of dimensions) {
    batches.forEach((batch, index) => {
      const dimensionId = batches.length === 1 ? d : `${d}#${index + 1}`
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
        }),
        findingsSchema: findingsSchema(),
      })
    })
  }

  return {
    mode: input.mode,
    goal,
    scope,
    dimensions: dimensionTasks,
    maxReviewRounds: input.maxReviewRounds,
    knownIntentional: input.knownIntentional ?? [],
    changedFiles: effectiveChangedOnly ? changedFiles : [],
    fallbackToFull,
    attachments,
  }
}
