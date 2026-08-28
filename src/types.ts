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
  /**
   * LLM reasoning effort for review passes ('low' | 'medium' | 'high').
   * Absent → follow the provider default. The harness forwards it into the
   * OpenAI-compatible request body; the plugin surfaces it in the settings
   * panel and review plan (dsh 0.1.1-rc.7+ exposes the same 'low' effort).
   */
  reasoning_effort?: 'low' | 'medium' | 'high'
  reviewer: {
    output_schema_validation: boolean
    evidence_validation: boolean
    coverage_validation: boolean
    scope_chunk_size: number
  }
  /**
   * Runtime observatory: live review-transcript capture and the destructive
   * tool approval gate. Absent → defaults (capture on, approval per `policy`).
   */
  observatory?: {
    /** Persist a review transcript to `.iterate/transcript.json` for the client observatory. */
    capture?: boolean
    /**
     * Approval policy for destructive iterate tools (iterate_fix /
     * iterate_rollback / iterate_prune with dryRun:false).
     * - 'ask': prompt the human through the dsh approval service before running.
     * - 'deny': refuse the call outright (fail-closed).
     * - 'allow': always run (debug/trusted). Default 'ask'.
     */
    approval?: 'ask' | 'deny' | 'allow'
  }
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
    | 'round_failed'
    | 'resume'
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

/**
 * An image (or other visual) attachment threaded into a review.
 *
 * The user/context can attach screenshots, UI mockups, or reproduced-failure
 * images that reviewers should weigh alongside the code. Only ``path`` or
 * ``data`` need be present; ``media_type`` describes ``data`` (base64);
 * ``caption`` supplies human context for the reviewer prompt.
 */
export interface ReviewAttachment {
  /** Local path to the image (resolved relative to the project root). */
  path?: string
  /** Base64-encoded image content (alternative to ``path``). */
  data?: string
  /** MIME type of ``data`` (e.g. image/png, image/jpeg, image/webp). */
  media_type?: string
  /** Short human caption explaining what the attachment shows and why it matters. */
  caption?: string
}

/** A single finding from a dimension review */
export interface ReviewFinding {
  dimension: string
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  failure_scenario: string
  suggested_fix: string
  /** true if the fix fits within atomic thresholds (single file, single function, ≤ max_lines). */
  is_atomic: boolean
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
  /**
   * Every file the reviewers self-reported opening (readFiles across rounds).
   * Consumed by the meta-review coverage gate. Optional for back-compat.
   */
  readFiles?: string[]
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
    /** Number of atomic fixes applied so far (normal mode only; absent in dry-run). */
    fixedCount?: number
  }
}

/** One round of review */
export interface ReviewRound {
  round: number
  findings: ReviewFinding[]
  /**
   * Files the reviewer subagents actually opened with read_file (from their
   * `readFiles` output). Threaded through aggregate → report → meta-review so
   * the coverage gate can compare self-reported reads against the assigned
   * inventory. Optional — older callers omit it.
   */
  readFiles?: string[]
}

/** Known intentional entry (filtered out from findings) */
export interface KnownIntentional {
  file: string
  line?: number
  dimension: string
  reason: string
}

/** ─── Fix system ──────────────────────────────────────────────────────────── */

/** A single fix record: one finding → one fix operation on one file. */
export interface FixRecord {
  id: string
  timestamp: string
  round: number
  finding: ReviewFinding
  backupPath: string
  diffSummary: string
  linesAdded: number
  linesRemoved: number
  success: boolean
  error?: string
}

/** Fix registry metadata (per-round summary). */
export interface FixRegistry {
  rounds: FixRoundRecord[]
}
export interface FixRoundRecord {
  round: number
  fixedCount: number
  failedCount: number
  records: FixRecord[]
}

/** Hunk-level diff for a single file. */
export interface FileDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

/** ─── Checkpoint / resume ─────────────────────────────────────────────────── */

export interface IterationCheckpoint {
  mode: 'dry-run' | 'normal'
  round: number
  maxRounds: number
  fixedCount: number
  architecturalCount: number
  /** How many times this checkpoint has been resumed after an interruption/abort. */
  resumeCount: number
  findings: ReviewFinding[]
  startedAt: string
  updatedAt: string
}

/** ─── Status summary ──────────────────────────────────────────────────────── */

export interface IterationStatus {
  mode: 'dry-run' | 'normal' | null
  currentRound: number
  totalRounds: number
  fixedCount: number
  architecturalCount: number
  findingsCount: number
  totalDecisionLogEntries: number
  hasCheckpoint: boolean
  /** True when a checkpoint is present — i.e. the previous run was interrupted before finishing. */
  interrupted: boolean
  /** How many times the current checkpoint has already been resumed. */
  resumeCount: number
  checkpoint: IterationCheckpoint | null
  lastUpdated: string | null
}

/** ─── Runtime observatory (transcript) ───────────────────────────────────── */

/** Keyboard-control-free direction to steer the running workflow's next round. */
export interface TranscriptNudge {
  /** ISO timestamp the nudge was written. */
  timestamp: string
  /** Free-form steering text injected at the front of the next round's prompt. */
  text: string
}

/** One finding rendered for the observatory (location + evidence kept for jump/triage). */
export interface TranscriptFinding {
  dimension: string
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  failure_scenario?: string
  suggested_fix?: string
  is_atomic?: boolean
  /** True when this finding was already marked known_intentional (filtered from active work). */
  acknowledged?: boolean
}

/** One reviewer sub-agent's visible stream within a round. */
export interface TranscriptThread {
  /** Target dimension the reviewer was asked to review. */
  dimension: string
  /** 1-based attempt within the round (schema-validation retries bump this). */
  attempt: number
  /** Natural-language narration the reviewer produced (F1 message stream). */
  messages: string[]
  /** Files the reviewer opened with read_file (F1 "what it read"). */
  readFiles: string[]
  /** Findings the reviewer produced in this thread. */
  findings: TranscriptFinding[]
}

/** A review round grouping its reviewer threads. */
export interface TranscriptRound {
  round: number
  threads: TranscriptThread[]
}

/** A recorded atomic fix shown in the observatory (F4). */
export interface TranscriptFix {
  id: string
  timestamp: string
  round: number
  file: string
  summary: string
  linesAdded: number
  linesRemoved: number
  success: boolean
}

/** A single decision-log entry in the timeline (F7). */
export interface TranscriptEntry {
  timestamp: string
  round: number
  type: string
  data: Record<string, unknown>
}

/** Checkpoint summary surfaced for resume actions (F5). */
export interface TranscriptCheckpoint {
  mode: 'dry-run' | 'normal'
  round: number
  maxRounds: number
  fixedCount: number
  resumeCount: number
  updatedAt: string
}

/**
 * Serializable runtime-observatory manifest the client renders. Every field is
 * `JsonValue`-safe; the builder caps growth so a long run cannot blow up memory.
 */
export interface TranscriptManifest {
  version: number
  project: string
  updatedAt: string
  active: boolean
  mode: 'dry-run' | 'normal' | null
  goal: string
  phases: string[]
  round: number
  maxRounds: number
  rounds: TranscriptRound[]
  convergence: number[]
  findings: TranscriptFinding[]
  fixes: TranscriptFix[]
  checkpoint: TranscriptCheckpoint | null
  timeline: TranscriptEntry[]
  nudge: TranscriptNudge | null
  approval: {
    active: boolean
    policy: 'ask' | 'deny' | 'allow'
  }
}