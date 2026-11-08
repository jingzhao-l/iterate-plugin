/**
 * src/client/run-compare.ts — cross-session run comparison (the observatory F2 tab).
 *
 * The F2 convergence tab compares ROUNDS *within* one session, but comparing
 * two ITERATIONS of the same project (before / after a refactor) used to be a
 * manual chore: export JSON for each run, open both files, line up the columns.
 * This module turns that into a first-class interaction. The current run is
 * reduced to a compact, serializable summary and saved to localStorage as the
 * comparison baseline; any later run can then be compared against it side by
 * side, with a per-metric delta and a directional "better / worse" tint.
 *
 * Design constraints (mirrors `i18n.ts` / `session-cache.ts`):
 *   - **Pure / dependency-free**: no React, no DOM, no Chinese literals (the
 *     bilingual labels live next to `t()` in index.ts, which is the layer the
 *     i18n dictionary-contract test scans). The summary builder and the
 *     compare reducer are unit-testable on their own.
 *   - **Versioned**: the stored payload carries a `version` so a future schema
 *     change can migrate or reject stale baselines instead of mis-reading them.
 *   - **Never fabricated**: every field is derived from real manifest fields
 *     with defensive optional chaining; a run with no findings simply reads 0.
 */

/** Current schema version of the persisted baseline. */
export const RUN_BASELINE_VERSION = 1

/** localStorage key holding the single comparison baseline (per browser). */
export const RUN_BASELINE_STORAGE_KEY = 'iterate.run-baseline'

/**
 * A compact, serializable summary of one run — everything the side-by-side
 * comparison needs, and nothing the client cannot already see in the manifest.
 */
export interface RunBaseline {
  version: 1
  /** ISO timestamp of when this baseline was saved (NOT the run end time). */
  savedAt: string
  /** Project root the run was anchored to (informational). */
  project?: string
  /** 'normal' | 'dry-run' — the mode that produced the run. */
  mode?: string
  /** Number of review rounds captured. */
  rounds: number
  /** Total findings raised across the run. */
  findings: number
  /** critical + high findings (the "must fix" surface). */
  criticalHigh: number
  /** Fixes that succeeded. */
  fixed: number
  /** Fixes that failed (rolled back / validation-rejected). */
  failedFixes: number
  /** Fraction of validation command runs that passed, 0-100, or null if none ran. */
  validationPassRate: number | null
  /** Number of validation command runs. */
  validationTotal: number
  /** 'pass' | 'fail' | null — the quality gate verdict, when it was computed. */
  qualityGateStatus: string | null
  /** Quality gate overall score (0-100) when computed. */
  qualityGateScore: number | null
  /** Why the run ended: converged / max_rounds_reached / aborted_by_validation. */
  stoppedReason: string | null
  /** Findings per round (the convergence series), for a side-by-side trend. */
  convergence: number[]
}

/** The manifest-shaped inputs the summary builder reads (defensively). */
export interface RunBaselineInput {
  project?: string
  mode?: string
  convergence?: number[]
  findings?: Array<{ severity?: string }>
  fixes?: Array<{ success?: boolean }>
  validations?: Array<{ allowed?: boolean }>
  qualityGateStatus?: string | null
  qualityGateScore?: number | null
  stoppedReason?: string | null
}

/**
 * Reduce a run manifest (plus the session-scanned quality gate) to a compact,
 * comparison-ready summary. Pure: `savedAt` is injected by the caller so this
 * stays deterministic and testable.
 */
export function buildRunBaseline(input: RunBaselineInput, savedAt: string): RunBaseline {
  const convergence = Array.isArray(input.convergence) ? input.convergence : []
  // Only object entries count — a null / primitive in a malformed manifest
  // must never be read as a finding / fix / validation (and skew the rate).
  const findings = (Array.isArray(input.findings) ? input.findings : []).filter(
    (f): f is { severity?: string } => typeof f === 'object' && f !== null,
  )
  const fixes = (Array.isArray(input.fixes) ? input.fixes : []).filter(
    (f): f is { success?: boolean } => typeof f === 'object' && f !== null,
  )
  const validations = (Array.isArray(input.validations) ? input.validations : []).filter(
    (v): v is { allowed?: boolean } => typeof v === 'object' && v !== null,
  )

  let criticalHigh = 0
  for (const f of findings) {
    const sev = String((f && f.severity) || '').toLowerCase()
    if (sev === 'critical' || sev === 'high') criticalHigh += 1
  }

  let fixed = 0
  let failedFixes = 0
  for (const x of fixes) {
    if (x && x.success === true) fixed += 1
    else if (x && x.success === false) failedFixes += 1
  }

  let passed = 0
  for (const v of validations) {
    if (v && v.allowed === true) passed += 1
  }
  const validationTotal = validations.length
  const validationPassRate = validationTotal > 0 ? Math.round((passed / validationTotal) * 100) : null

  return {
    version: RUN_BASELINE_VERSION,
    savedAt,
    ...(input.project ? { project: input.project } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    rounds: convergence.length,
    findings: findings.length,
    criticalHigh,
    fixed,
    failedFixes,
    validationPassRate,
    validationTotal,
    qualityGateStatus: input.qualityGateStatus || null,
    qualityGateScore: typeof input.qualityGateScore === 'number' ? input.qualityGateScore : null,
    stoppedReason: input.stoppedReason || null,
    convergence,
  }
}

/**
 * Parse a persisted baseline JSON string. Returns `null` for anything that is
 * not a well-formed, version-matched baseline — a stale/corrupt payload must
 * never be mis-read as a real run, and never throws.
 */
export function parseRunBaseline(raw: string | null): RunBaseline | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const b = parsed as Record<string, unknown>
  if (b.version !== RUN_BASELINE_VERSION) return null
  if (typeof b.savedAt !== 'string' || b.savedAt.length === 0) return null
  if (typeof b.findings !== 'number' || !Number.isFinite(b.findings)) return null
  // convergence must be a number array (defensive; a non-array becomes []).
  const convergence = Array.isArray(b.convergence)
    ? b.convergence.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : []
  return {
    version: RUN_BASELINE_VERSION,
    savedAt: b.savedAt,
    ...(typeof b.project === 'string' && b.project ? { project: b.project } : {}),
    ...(typeof b.mode === 'string' && b.mode ? { mode: b.mode } : {}),
    rounds: typeof b.rounds === 'number' && Number.isFinite(b.rounds) ? b.rounds : convergence.length,
    findings: b.findings,
    criticalHigh: typeof b.criticalHigh === 'number' && Number.isFinite(b.criticalHigh) ? b.criticalHigh : 0,
    fixed: typeof b.fixed === 'number' && Number.isFinite(b.fixed) ? b.fixed : 0,
    failedFixes: typeof b.failedFixes === 'number' && Number.isFinite(b.failedFixes) ? b.failedFixes : 0,
    validationPassRate:
      typeof b.validationPassRate === 'number' && Number.isFinite(b.validationPassRate) ? b.validationPassRate : null,
    validationTotal:
      typeof b.validationTotal === 'number' && Number.isFinite(b.validationTotal) ? b.validationTotal : 0,
    qualityGateStatus: typeof b.qualityGateStatus === 'string' && b.qualityGateStatus ? b.qualityGateStatus : null,
    qualityGateScore:
      typeof b.qualityGateScore === 'number' && Number.isFinite(b.qualityGateScore) ? b.qualityGateScore : null,
    stoppedReason: typeof b.stoppedReason === 'string' && b.stoppedReason ? b.stoppedReason : null,
    convergence,
  }
}

/**
 * One row of the side-by-side comparison.
 *
 * `higherIsBetter` tells the renderer how to tint the delta:
 *   - `true`  → a larger current value is an improvement (fixed, pass rate, score)
 *   - `false` → a smaller current value is an improvement (findings, failed fixes)
 *   - `null`  → neutral (rounds — fewer is usually faster but not always better)
 */
export interface RunCompareMetric {
  key: 'rounds' | 'findings' | 'criticalHigh' | 'fixed' | 'failedFixes' | 'validationPassRate' | 'qualityGateScore'
  baseline: number | null
  current: number | null
  higherIsBetter: boolean | null
}

/**
 * Compare a saved baseline against the current run. Both sides come from
 * `buildRunBaseline`, so `null` means "that side had no such measurement"
 * (e.g. a dry-run has no fixes; a run that never validated has no pass rate).
 */
export function compareRuns(baseline: RunBaseline, current: RunBaseline): RunCompareMetric[] {
  const num = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const rows: RunCompareMetric[] = [
    { key: 'rounds', baseline: num(baseline.rounds), current: num(current.rounds), higherIsBetter: null },
    { key: 'findings', baseline: num(baseline.findings), current: num(current.findings), higherIsBetter: false },
    { key: 'criticalHigh', baseline: num(baseline.criticalHigh), current: num(current.criticalHigh), higherIsBetter: false },
    { key: 'fixed', baseline: num(baseline.fixed), current: num(current.fixed), higherIsBetter: true },
    { key: 'failedFixes', baseline: num(baseline.failedFixes), current: num(current.failedFixes), higherIsBetter: false },
    { key: 'validationPassRate', baseline: num(baseline.validationPassRate), current: num(current.validationPassRate), higherIsBetter: true },
    { key: 'qualityGateScore', baseline: num(baseline.qualityGateScore), current: num(current.qualityGateScore), higherIsBetter: true },
  ]
  return rows
}
