/** Parsed iterate.config.yaml */
export interface IterateConfig {
  goal: string
  max_rounds: number
  language: 'zh' | 'en'
  dimensions: string[]
  review: { scope: 'full' | 'changed-only' }
  atomic: { max_lines: number; max_adjacent_methods: number }
  git: {
    target_branch: string
    use_worktree: boolean
    push_per_round: boolean
    auto_merge: boolean
  }
  validation: {
    command_whitelist: string[]
    commands: Record<string, string[]>
  }
  reviewer: { output_schema_validation: boolean }
  onboarding?: Record<string, unknown>
  personalization?: Record<string, unknown>
}

/** One entry in the append-only decision log */
export interface DecisionLogEntry {
  timestamp: string
  round: number
  type:
    | 'round_start'
    | 'review_result'
    | 'atomic_fix'
    | 'architectural_fix'
    | 'revert'
    | 'validation'
    | 'decision'
    | 'report'
  data: Record<string, unknown>
}

/** Result of running a validation command */
export interface ValidationResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/** A single finding from a dimension review */
export interface ReviewFinding {
  dimension: string
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  detail: string
  classification: 'atomic' | 'architectural'
}

/** Review report (dry-run or normal mode) */
export interface ReviewReport {
  mode: 'dry-run' | 'normal'
  goal: string
  dimensions: string[]
  maxReviewRounds: number
  rounds: ReviewRound[]
  /** Globally deduped, known-intentional-filtered, severity-sorted findings. */
  findings: ReviewFinding[]
  convergence: {
    totalRounds: number
    findingsByRound: number[]
    converged: boolean
    stoppedReason: 'converged' | 'max_rounds_reached'
  }
  summary: {
    totalFindings: number
    critical: number
    high: number
    medium: number
    low: number
    byDimension: Record<string, number>
  }
}

/** One round of review */
export interface ReviewRound {
  round: number
  findings: ReviewFinding[]
}

/** Known intentional entry (filtered out from findings) */
export interface KnownIntentional {
  file: string
  line?: number
  dimension: string
  reason: string
}