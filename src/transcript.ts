/**
 * src/transcript.ts — runtime-observatory transcript builder.
 *
 * Pure, deterministic, memory-bounded accumulator that turns normalized
 * iteration events into a serializable {@link TranscriptManifest} the client
 * renders. This is the data backbone for the observatory UI layer:
 *   - F1  — per-reviewer sub-agent message streams (threads per round/dimension).
 *   - F2  — per-round convergence series.
 *   - F3  — full finding list with file/line location for jump + triage.
 *   - F4  — applied-fix records (for diff + rollback).
 *   - F5  — checkpoint summary (resume).
 *   - F6  — nudge channel (steer the next round).
 *   - F7  — append-only decision timeline.
 *   - validations — per-round validation outcomes (command / exitCode /
 *     allowed) for the run console; see {@link TranscriptValidation}.
 *
 * It performs NO I/O and NEVER touches the filesystem — persistence lives in
 * the `iterate_transcript` tool. Inputs are defensively normalized so a
 * malformed event can never crash dedupe/sort or leak non-JSON state.
 *
 * Growth is bounded per field (threads/round capped, messages per thread
 * capped, timeline capped) so a very long run cannot blow up memory or the
 * client payload; the newest events win when a cap is hit.
 */

import type {
  TranscriptCheckpoint,
  TranscriptEntry,
  TranscriptFinding,
  TranscriptFix,
  TranscriptManifest,
  TranscriptNudge,
  TranscriptRound,
  TranscriptThread,
  TranscriptValidation,
} from './types.ts'

/** Manifest schema version (bump on incompatible shape change). */
export const TRANSCRIPT_VERSION = 1

/** Max threads recorded per round (extra dimensions/retries beyond this drop). */
const MAX_THREADS_PER_ROUND = 12

/** Max narration messages kept per thread (newest wins). */
const MAX_MESSAGES_PER_THREAD = 40

/** Max findings kept per thread. */
const MAX_FINDINGS_PER_THREAD = 100

/** Max global findings kept in the manifest. */
const MAX_FINDINGS_TOTAL = 2000

/** Max timeline entries kept (newest wins). */
export const MAX_TIMELINE = 500

/** Max applied-fix records kept (newest wins; bounded so a long run cannot
 *  grow the manifest payload without limit). */
const MAX_FIXES = 200

/** Max validation rows kept (newest wins; bounds a very long run's payload). */
const MAX_VALIDATIONS = 500

/** Max round number accepted by the builder. A model-authored/manifest-backed
 *  round value is attacker-influenced JSON: `roundStart(1e9)` / `snapshotConvergence`
 *  would otherwise preallocate arrays of that size and OOM the host.
 *  Exported so the capture/rehydrate FEED side can truncate before feeding
 *  (a value above the cap would otherwise be folded into the last slot). */
export const MAX_ROUNDS = 1000

/** Max threads restored per round from a persisted manifest (the live cap plus
 *  headroom for the single overflow thread). Shared by {@link ReviewTranscriptBuilder.restoreThread}
 *  and the read-side normalizer so both bound hostile manifests identically. */
export const MAX_THREADS_RESTORED = MAX_THREADS_PER_ROUND * 2 + 1

/** Thresholds applied when reducing a string list under a cap. */
function clampStringList(source: string[], cap: number): string[] {
  const out: string[] = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    out.push(trimmed)
    if (out.length >= cap) break
  }
  return out
}

/**
 * Deep-clone a decision-timeline payload so it is decoupled from the caller's
 * live object. structuredClone is available in every supported Node release;
 * on the off chance it is missing, fall back to a JSON round-trip (decision
 * payloads are JSON-serializable by construction).
 */
function cloneDecisionData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(data)
  } catch {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  }
}

/** Normalize a single finding, dropping malformed entries. */
function normalizeFinding(input: unknown): TranscriptFinding | null {
  if (!input || typeof input !== 'object') return null
  const f = input as Record<string, unknown>
  const dimension = typeof f.dimension === 'string' ? f.dimension : ''
  const file = typeof f.file === 'string' ? f.file : ''
  const summary = typeof f.summary === 'string' ? f.summary : ''
  if (!dimension || !file || !summary) return null
  const sev = f.severity
  const severity =
    sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low'
      ? sev
      : 'low'
  // Only a non-negative integer is a real line anchor; a fractional/malformed
  // value (e.g. 3.7 from a bypassed schema) must not leak into the manifest.
  const line =
    typeof f.line === 'number' && Number.isInteger(f.line) && f.line >= 0 ? f.line : 0
  return {
    dimension,
    file,
    line,
    severity,
    summary,
    failure_scenario: typeof f.failure_scenario === 'string' ? f.failure_scenario : undefined,
    suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : undefined,
    is_atomic: typeof f.is_atomic === 'boolean' ? f.is_atomic : undefined,
    acknowledged: typeof f.acknowledged === 'boolean' ? f.acknowledged : undefined,
  }
}

/**
 * Normalize one validation row (`capture` `validations` contract), dropping
 * rows that cannot identify WHAT was run and clamping the rest — the same
 * defensive style as the round/fix normalizers, because these values arrive
 * from a `type:'json'` argument a model authored.
 *
 *   - a non-object row, a missing/non-finite round (≤ 0 after flooring), or
 *     a missing/blank command → dropped (there is nothing to attribute);
 *   - `round` above the builder cap → clamped (never dropped: the row is real);
 *   - `exitCode` → integer, or `null` when absent/unknown/not a number;
 *   - `allowed` → strict boolean; an ABSENT flag degrades to `false` (fail
 *     closed: a row that cannot prove it was allow-listed reads as rejected);
 *   - `rejectReason` → trimmed string, omitted when blank.
 */
function normalizeValidation(input: unknown): TranscriptValidation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const v = input as Record<string, unknown>
  const rawRound = typeof v.round === 'number' && Number.isFinite(v.round) ? Math.floor(v.round) : 0
  if (rawRound <= 0) return null
  const command = typeof v.command === 'string' ? v.command.trim() : ''
  if (!command) return null
  const exitCode =
    typeof v.exitCode === 'number' && Number.isFinite(v.exitCode) ? Math.floor(v.exitCode) : null
  const rejectReason =
    typeof v.rejectReason === 'string' && v.rejectReason.trim() ? v.rejectReason.trim() : undefined
  return {
    round: Math.min(rawRound, MAX_ROUNDS),
    command,
    exitCode,
    allowed: v.allowed === true,
    ...(rejectReason ? { rejectReason } : {}),
  }
}

/** Stage an in-progress thread so the builder can append messages/reads/findings. */
interface LiveThread {
  dimension: string
  attempt: number
  messages: string[]
  readFiles: string[]
  findings: unknown[]
}

/** Stage an in-progress round. */
interface LiveRound {
  round: number
  threads: LiveThread[]
}

/**
 * Append one raw finding to a thread's list, bound to MAX_FINDINGS_PER_THREAD
 * with NEWEST-WINS eviction (drop the oldest findings once the cap is hit).
 * A single oversized fixer agent could otherwise OOM the client with an
 * unbounded finding dump inside one thread.
 */
function pushThreadFinding(thread: LiveThread, raw: unknown): void {
  thread.findings.push(raw)
  if (thread.findings.length > MAX_FINDINGS_PER_THREAD) {
    thread.findings.splice(0, thread.findings.length - MAX_FINDINGS_PER_THREAD)
  }
}

/** Merge a report snapshot's findings/readFiles into a thread by dimension. */
function mergeReportIntoThread(
  thread: LiveThread,
  findings: readonly unknown[],
  readFiles: readonly unknown[] | undefined,
): void {
  for (const raw of findings) {
    if (normalizeFinding(raw)) pushThreadFinding(thread, raw)
  }
  for (const r of readFiles ?? []) {
    if (typeof r === 'string') thread.readFiles.push(r)
  }
}

/**
 * The transcript builder. Create one per project run, feed normalized events,
 * then call {@link serialize}. Safe to call from any thread sequentially.
 */
export class ReviewTranscriptBuilder {
  private readonly project: string
  private readonly mode: 'dry-run' | 'normal' | null
  private readonly taskMode: 'code' | 'iterate' | null
  private readonly approval: 'ask' | 'deny' | 'allow'
  private goal = ''
  private readonly phases: string[] = []
  private round = 0
  private maxRounds = 0
  private active = true
  private stoppedReason: string | null = null
  private readonly rounds: LiveRound[] = []
  private readonly convergence: number[] = []
  private readonly globalFindings: TranscriptFinding[] = []
  private readonly globalSeenKeys = new Set<string>()
  private readonly fixes: TranscriptFix[] = []
  private readonly validations: TranscriptValidation[] = []
  private checkpoint: TranscriptCheckpoint | null = null
  private readonly timeline: TranscriptEntry[] = []
  private nudge: TranscriptNudge | null = null
  private updatedAt: string

  constructor(input: {
    project: string
    mode?: 'dry-run' | 'normal' | null
    taskMode?: 'code' | 'iterate' | null
    approval?: 'ask' | 'deny' | 'allow'
    goal?: string
    maxRounds?: number
    now?: () => string
  }) {
    this.project = input.project || ''
    this.mode =
      input.mode === 'dry-run' || input.mode === 'normal' ? input.mode : null
    // v3.0: task_mode indicator. An explicit valid value wins; otherwise a
    // run that exercises the review loop (any mode) defaults to "iterate".
    this.taskMode =
      input.taskMode === 'code' || input.taskMode === 'iterate'
        ? input.taskMode
        : input.mode !== null && input.mode !== undefined
          ? 'iterate'
          : null
    this.approval =
      input.approval === 'ask' || input.approval === 'deny' || input.approval === 'allow'
        ? input.approval
        : 'ask'
    this.goal = typeof input.goal === 'string' ? input.goal : ''
    this.maxRounds =
      typeof input.maxRounds === 'number' && Number.isFinite(input.maxRounds) && input.maxRounds >= 0
        ? Math.floor(input.maxRounds)
        : 0
    this.updatedAt = input.now ? input.now() : new Date().toISOString()
  }

  // ─── Run lifecycle ──────────────────────────────────────────────────────

  /** Mark the run started (clears the transcript for a fresh session). */
  begin(goal?: string, maxRounds?: number): void {
    if (typeof goal === 'string' && goal) this.goal = goal
    if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds >= 0) {
      this.maxRounds = Math.floor(maxRounds)
    }
    this.active = true
    this.touch()
  }

  /** Record a workflow phase name (plan / review / fix / validate / report …). */
  phase(name: string): void {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n) return
    if (this.phases[this.phases.length - 1] !== n) this.phases.push(n)
    this.touch()
  }

  /**
   * End the run (stops the "active" pulsing in the UI). `reason` records WHY
   * it ended, so a run stopped by max-rounds or validation is never mistaken
   * for a live run NOR for a clean convergence.
   */
  finish(reason?: string): void {
    this.active = false
    if (typeof reason === 'string' && reason.trim()) this.stoppedReason = reason.trim()
    this.touch()
  }

  /** Open a review round, capturing the current round index. */
  roundStart(round: number, maxRounds?: number): void {
    const r = typeof round === 'number' && Number.isFinite(round) ? Math.floor(round) : 1
    // Clamp to MAX_ROUNDS: `this.rounds.length < this.round` below preallocates
    // an array of size `round` — an unbounded model-controlled value (e.g. 1e9)
    // would OOM the host. Values above the cap are folded into the cap so the
    // real rounds are never silently dropped.
    this.round = Math.min(r > 0 ? r : 1, MAX_ROUNDS)
    if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds >= 0) {
      this.maxRounds = Math.min(Math.floor(maxRounds), MAX_ROUNDS)
    }
    while (this.rounds.length < this.round) {
      this.rounds.push({ round: this.rounds.length + 1, threads: [] })
    }
    this.touch()
  }

  /**
   * Advance the CURRENT-round marker to `round` WITHOUT creating round rows.
   *
   * `roundStart` pre-allocates empty rows up to `round` (legitimate while a
   * round is opening — reviewers write into those rows). At capture time,
   * though, `roundsExecuted` may legitimately exceed the rounds we actually
   * captured data for: calling `roundStart(roundsExecuted)` there fabricated
   * phantom EMPTY round rows the reviewers never produced. This setter only
   * moves the marker — and only FORWARD (never rewinds past a row capture
   * already recorded) — so `manifest.round` still reports how far the run got
   * while `manifest.rounds` keeps only rounds with captured content.
   */
  advanceRound(round: number, maxRounds?: number): void {
    const r =
      typeof round === 'number' && Number.isFinite(round) && round > 0
        ? Math.min(Math.floor(round), MAX_ROUNDS)
        : 0
    if (r > this.round) this.round = r
    if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds >= 0) {
      this.maxRounds = Math.min(Math.floor(maxRounds), MAX_ROUNDS)
    }
    this.touch()
  }

  // ─── Reviewer threads (F1) ──────────────────────────────────────────────

  /** Start a reviewer sub-agent's thread for the current round. */
  reviewerStart(dimension: string, attempt = 1): void {
    const dim = typeof dimension === 'string' ? dimension.trim() : 'review'
    const att = typeof attempt === 'number' && Number.isFinite(attempt) ? Math.floor(attempt) : 1
    this.roundStart(this.round)
    const live = this.rounds[this.round - 1]! as LiveRound | undefined
    if (!live) return
    if (this.threadCount(live) < MAX_THREADS_PER_ROUND) {
      live.threads.push({
        dimension: dim || 'review',
        attempt: att > 0 ? att : 1,
        messages: [],
        readFiles: [],
        findings: [],
      })
    } else {
      // Thread cap reached: route the extra dimension/retry into ONE shared
      // "other" overflow thread instead of silently dropping it. A dropped
      // reviewerStart used to leave `currentThread()` pointing at the PREVIOUS
      // dimension's thread, so its findings were mis-attributed to that
      // dimension. The overflow thread stays bounded (at most ONE extra thread
      // per round) while keeping over-cap findings attributable to "other".
      let overflow = live.threads.find((t) => t.dimension === 'other')
      if (!overflow) {
        overflow = {
          dimension: 'other',
          attempt: att > 0 ? att : 1,
          messages: [],
          readFiles: [],
          findings: [],
        }
        live.threads.push(overflow)
      }
    }
    this.touch()
  }

  /**
   * Restore ONE persisted thread during rehydration, preserving the message
   * ARRAY boundaries (a rehydrated manifest is re-serialized on the next nudge
   * edit, so collapsed messages would silently rewrite the evidence) and the
   * thread's own dimension (never merging it into a previous dimension's
   * thread). Bypasses the live per-round cap — the manifest already enforced
   * it at capture time — but every restored field is hard-bounded so a hostile
   * hand-edited manifest can never blow up memory.
   */
  restoreThread(
    round: number,
    thread: {
      dimension?: unknown
      attempt?: unknown
      messages?: unknown
      readFiles?: unknown
      findings?: unknown
    },
  ): void {
    const r =
      typeof round === 'number' && Number.isFinite(round)
        ? Math.min(Math.floor(round), MAX_ROUNDS)
        : 1
    this.roundStart(r)
    const live = this.rounds[this.round - 1]
    if (!live) return
    if (!thread || typeof thread !== 'object') return
    // Hostile-manifest guard: keep the live hard bound (with headroom for the
    // single overflow thread) and newest-first truncate beyond it.
    if (live.threads.length >= MAX_THREADS_RESTORED) return
    const dim =
      typeof thread.dimension === 'string' && thread.dimension.trim()
        ? thread.dimension.trim()
        : 'review'
    const att =
      typeof thread.attempt === 'number' && Number.isFinite(thread.attempt)
        ? Math.floor(thread.attempt)
        : 1
    const t: LiveThread = {
      dimension: dim,
      attempt: att > 0 ? att : 1,
      messages: [],
      readFiles: [],
      findings: [],
    }
    const messages = Array.isArray(thread.messages) ? thread.messages : []
    for (const m of messages.slice(0, MAX_MESSAGES_PER_THREAD)) {
      if (typeof m === 'string' && m.trim()) t.messages.push(m)
    }
    if (Array.isArray(thread.readFiles)) {
      t.readFiles.push(...dedupePaths(thread.readFiles as string[]))
    }
    if (Array.isArray(thread.findings)) {
      for (const f of thread.findings) {
        if (normalizeFinding(f)) pushThreadFinding(t, f)
      }
    }
    live.threads.push(t)
    this.touch()
  }

  /** Append narration (assistant text) to the current reviewer thread. */
  reviewerMessage(text: string): void {
    if (typeof text !== 'string' || !text.trim()) return
    const thread = this.currentThread()
    if (!thread) return
    thread.messages.push(text)
    if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
      thread.messages.splice(0, thread.messages.length - MAX_MESSAGES_PER_THREAD)
    }
    this.touch()
  }

  /** Record files the current reviewer opened (read_file). */
  reviewerRead(files: readonly unknown[]): void {
    const thread = this.currentThread()
    if (!thread) return
    for (const f of files ?? []) {
      if (typeof f === 'string') thread.readFiles.push(f)
    }
    this.touch()
  }

  /** Record findings the current reviewer produced (both raw and normalized). */
  reviewerFindings(findings: readonly unknown[]): void {
    const thread = this.currentThread()
    if (!thread) return
    if (Array.isArray(findings)) {
      for (const raw of findings) {
        const f = normalizeFinding(raw)
        if (f) {
          pushThreadFinding(thread, raw)
          this.addGlobal(f)
        }
      }
    }
    this.touch()
  }

  /** Merge a round-level report snapshot (findings + readFiles) into a thread. */
  reviewerSnapshot(dimension: string, findings: readonly unknown[], readFiles?: readonly unknown[]): void {
    this.reviewerStart(dimension)
    const thread = this.currentThread()
    if (!thread) return
    mergeReportIntoThread(thread, findings, readFiles)
    for (const raw of findings) {
      const f = normalizeFinding(raw)
      if (f) this.addGlobal(f)
    }
    this.touch()
  }

  // ─── Convergence (F2) ───────────────────────────────────────────────────

  /** Record a round's new-finding count for the convergence series. */
  snapshotConvergence(round: number, newCount: number): void {
    const rawR = typeof round === 'number' && Number.isFinite(round) ? Math.floor(round) : 1
    // Clamp (mirrors roundStart): the loop below preallocates `r` slots, so an
    // unbounded model-controlled round number would OOM the host.
    const r = Math.min(rawR > 0 ? rawR : 1, MAX_ROUNDS)
    const n = typeof newCount === 'number' && Number.isFinite(newCount) ? newCount : 0
    while (this.convergence.length < r) this.convergence.push(-1)
    this.convergence[r - 1] = Math.floor(n)
    this.touch()
  }

  // ─── Fixes (F4) ─────────────────────────────────────────────────────────

  /** Record an applied atomic fix. */
  fix(record: Partial<TranscriptFix>): void {
    if (!record || typeof record !== 'object') return
    const id = typeof record.id === 'string' ? record.id : ''
    const file = typeof record.file === 'string' ? record.file : ''
    if (!id || !file) return
    this.fixes.push({
      id,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : isoNow(),
      round:
        typeof record.round === 'number' && Number.isFinite(record.round)
          ? Math.floor(record.round)
          : this.round,
      file,
      summary: typeof record.summary === 'string' ? record.summary : '',
      linesAdded:
        typeof record.linesAdded === 'number' ? Math.floor(record.linesAdded) : 0,
      linesRemoved:
        typeof record.linesRemoved === 'number' ? Math.floor(record.linesRemoved) : 0,
      success: record.success !== false,
    })
    if (this.fixes.length > MAX_FIXES) {
      this.fixes.splice(0, this.fixes.length - MAX_FIXES)
    }
    this.touch()
  }

  /** Flag a fix as rolled back (kept in the list so the UI shows the reversal). */
  markFixRolledBack(id: string): void {
    for (const f of this.fixes) {
      if (f.id === id) f.success = false
    }
    this.touch()
  }

  // ─── Validations (F6/F8 console) ────────────────────────────────────────

  /**
   * Record one validation command outcome. Normalizes defensively (bad rows
   * are dropped, out-of-cap rounds clamped) and keeps the NEWEST rows under
   * MAX_VALIDATIONS, mirroring {@link fix}. A malformed row can never crash
   * the capture nor leak non-JSON state into the manifest.
   */
  validation(input: unknown): void {
    const record = normalizeValidation(input)
    if (!record) return
    this.validations.push(record)
    if (this.validations.length > MAX_VALIDATIONS) {
      this.validations.splice(0, this.validations.length - MAX_VALIDATIONS)
    }
    this.touch()
  }

  // ─── Checkpoint (F5) ────────────────────────────────────────────────────

  /** Record the current checkpoint summary (null clears it). */
  recordCheckpoint(state: TranscriptCheckpoint | null): void {
    if (!state || typeof state !== 'object') {
      this.checkpoint = null
      this.touch()
      return
    }
    this.checkpoint = {
      mode: state.mode === 'dry-run' || state.mode === 'normal' ? state.mode : 'normal',
      round: typeof state.round === 'number' ? state.round : 0,
      maxRounds: typeof state.maxRounds === 'number' ? state.maxRounds : 0,
      fixedCount: typeof state.fixedCount === 'number' ? state.fixedCount : 0,
      resumeCount: typeof state.resumeCount === 'number' ? state.resumeCount : 0,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : isoNow(),
    }
    this.touch()
  }

  // ─── Decision timeline (F7) ─────────────────────────────────────────────

  /** Append one decision-log entry to the timeline (newest wins under the cap). */
  decision(entry: Partial<TranscriptEntry>): void {
    if (!entry || typeof entry !== 'object') return
    const type = typeof entry.type === 'string' ? entry.type : 'decision'
    this.timeline.push({
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : isoNow(),
      round:
        typeof entry.round === 'number' && Number.isFinite(entry.round)
          ? Math.floor(entry.round)
          : this.round,
      type,
      data:
        entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
          // Deep clone so a caller mutating its own object later can never
          // alias into the timeline (serialize would then emit the mutated
          // values instead of what was actually decided). Decision-log payloads
          // are small JSON, so the clone cost is negligible.
          ? cloneDecisionData(entry.data as Record<string, unknown>)
          : {},
    })
    if (this.timeline.length > MAX_TIMELINE) {
      this.timeline.splice(0, this.timeline.length - MAX_TIMELINE)
    }
    this.touch()
  }

  // ─── Nudge (F6) ─────────────────────────────────────────────────────────

  /** Write steering text for the next round (null clears it). */
  setNudge(text: string | null): void {
    if (typeof text === 'string' && text.trim()) {
      this.nudge = { timestamp: isoNow(), text: text.trim() }
    } else {
      this.nudge = null
    }
    this.touch()
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  /** Produce the current serializable manifest. */
  serialize(): TranscriptManifest {
    const rounds: TranscriptRound[] = this.rounds.map((r, idx) => ({
      round: r.round,
      threads: r.threads.map((t) => ({
        dimension: t.dimension,
        attempt: t.attempt,
        messages: clampStringList(t.messages, MAX_MESSAGES_PER_THREAD),
        readFiles: dedupePaths(t.readFiles),
        findings: t.findings
          .map((x) => normalizeFinding(x))
          .filter((x): x is TranscriptFinding => x !== null),
      })),
    }))
    return {
      version: TRANSCRIPT_VERSION,
      project: this.project,
      updatedAt: this.updatedAt,
      active: this.active,
      mode: this.mode,
      taskMode: this.taskMode,
      goal: this.goal,
      phases: this.phases,
      round: this.round,
      maxRounds: this.maxRounds,
      rounds,
      convergence: this.convergence,
      // addGlobal maintains the newest-wins cap incrementally, so the array is
      // already ≤ MAX_FINDINGS_TOTAL — no post-hoc slice needed.
      findings: this.globalFindings,
      fixes: this.fixes,
      validations: this.validations,
      checkpoint: this.checkpoint,
      timeline: this.timeline,
      nudge: this.nudge,
      stoppedReason: this.stoppedReason,
      approval: {
        active: this.approval !== 'allow',
        policy: this.approval,
      },
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Bump the manifest's updatedAt to reflect a fresh mutation. */
  private touch(): void {
    this.updatedAt = isoNow()
  }

  /** Current round's most recent thread, if any. */
  private currentThread(): LiveThread | null {
    const live = this.rounds[this.round - 1] as LiveRound | undefined
    if (!live) return null
    const thread = live.threads[live.threads.length - 1]
    return thread ?? null
  }

  /** Count threads already recorded for a round. */
  private threadCount(live: LiveRound): number {
    return live.threads.length
  }

  /**
   * Insert one deduplicated finding into the compact global list.
   * NEWEST-WINS: when the global cap (MAX_FINDINGS_TOTAL) is hit, the oldest
   * kept finding is evicted so fresh, still-relevant findings survive — this
   * is the documented contract. Amortized O(1): dedupe via a seen-key set and
   * eviction is one `shift` per overflow insert.
   */
  private addGlobal(f: TranscriptFinding): void {
    const key = `${f.file}\u0000${f.line ?? 0}\u0000${f.dimension}\u0000${f.summary}`
    if (this.globalSeenKeys.has(key)) return
    this.globalSeenKeys.add(key)
    this.globalFindings.push(f)
    if (this.globalFindings.length > MAX_FINDINGS_TOTAL) {
      const evicted = this.globalFindings.shift()
      if (evicted) {
        this.globalSeenKeys.delete(
          `${evicted.file}\u0000${evicted.line ?? 0}\u0000${evicted.dimension}\u0000${evicted.summary}`,
        )
      }
    }
  }
}

/** Dedupe + bound an ordered string list of file paths. */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue
    const k = p.trim()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** ISO timestamp helper (kept injectable in tests via the builder's now). */
function isoNow(): string {
  return new Date().toISOString()
}

// ─── Read-side normalization ────────────────────────────────────────────────

/** Clamp an unknown round marker into [0, MAX_ROUNDS] (0 = never recorded). */
function clampRoundValue(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(Math.floor(v), 0), MAX_ROUNDS)
    : 0
}

/** Clamp an unknown non-negative counter (0 when absent/garbage). */
function clampCountValue(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** Re-run one persisted thread row through the builder's per-row bounds. */
function normalizeThreadRow(input: unknown): TranscriptThread {
  const t = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const dim = typeof t.dimension === 'string' && t.dimension.trim() ? t.dimension.trim() : 'review'
  const att = typeof t.attempt === 'number' && Number.isFinite(t.attempt) ? Math.floor(t.attempt) : 1
  const messages = Array.isArray(t.messages) ? (t.messages as unknown[]) : []
  const readFiles = Array.isArray(t.readFiles) ? (t.readFiles as unknown[]) : []
  const rawFindings = Array.isArray(t.findings) ? (t.findings as unknown[]) : []
  const findings = rawFindings
    .map((f) => normalizeFinding(f))
    .filter((f): f is TranscriptFinding => f !== null)
  return {
    dimension: dim,
    attempt: att > 0 ? att : 1,
    // Same reductions serialize() applies: messages newest-capped + trimmed,
    // readFiles deduped, per-thread findings newest-capped.
    messages: clampStringList(messages as string[], MAX_MESSAGES_PER_THREAD),
    readFiles: dedupePaths(readFiles as string[]),
    findings:
      findings.length > MAX_FINDINGS_PER_THREAD
        ? findings.slice(-MAX_FINDINGS_PER_THREAD)
        : findings,
  }
}

/** Re-run one persisted fix row through the builder's fix() requirements. */
function normalizeFixRow(input: unknown): TranscriptFix | null {
  if (!input || typeof input !== 'object') return null
  const f = input as Record<string, unknown>
  const id = typeof f.id === 'string' ? f.id : ''
  const file = typeof f.file === 'string' ? f.file : ''
  if (!id || !file) return null
  return {
    id,
    file,
    // No fabricated "now" on read: a corrupt/absent timestamp stays blank
    // instead of masquerading as a fix that just happened.
    timestamp: typeof f.timestamp === 'string' ? f.timestamp : '',
    round: clampRoundValue(f.round),
    summary: typeof f.summary === 'string' ? f.summary : '',
    linesAdded: clampCountValue(f.linesAdded),
    linesRemoved: clampCountValue(f.linesRemoved),
    success: f.success !== false,
  }
}

/** Re-run one persisted timeline row through the builder's decision() shape. */
function normalizeTimelineRow(input: unknown): TranscriptEntry | null {
  if (!input || typeof input !== 'object') return null
  const e = input as Record<string, unknown>
  return {
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
    round: clampRoundValue(e.round),
    type: typeof e.type === 'string' && e.type ? e.type : 'decision',
    data:
      e.data && typeof e.data === 'object' && !Array.isArray(e.data)
        ? (e.data as Record<string, unknown>)
        : {},
  }
}

/** Re-run a persisted checkpoint through the builder's recordCheckpoint rules. */
function normalizeCheckpointRow(input: unknown): TranscriptCheckpoint | null {
  if (!input || typeof input !== 'object') return null
  const c = input as Record<string, unknown>
  const round = typeof c.round === 'number' && Number.isFinite(c.round) ? c.round : 0
  if (round <= 0) return null
  return {
    mode: c.mode === 'dry-run' || c.mode === 'normal' ? c.mode : 'normal',
    round: clampRoundValue(c.round),
    maxRounds: clampCountValue(c.maxRounds),
    fixedCount: clampCountValue(c.fixedCount),
    resumeCount: clampCountValue(c.resumeCount),
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '',
  }
}

/** Re-run a persisted nudge through the builder's setNudge rules. */
function normalizeNudgeRow(input: unknown): TranscriptNudge | null {
  if (!input || typeof input !== 'object') return null
  const n = input as Record<string, unknown>
  const text = typeof n.text === 'string' ? n.text.trim() : ''
  if (!text) return null
  return { timestamp: typeof n.timestamp === 'string' ? n.timestamp : '', text }
}

/**
 * Defensive read-side normalization of a persisted manifest.
 *
 * `.iterate/transcript.json` is hand-editable JSON handed straight to the
 * client/model by `iterate_transcript.read`: the tool gates the ROOT shape,
 * but row-level bounds (threads, messages, findings, timeline, fixes …) used
 * to pass through untouched, so a hostile or corrupted file could leak an
 * unbounded payload or junk field values (fractional lines, non-string
 * phases, negative counters) that a capture could never have written.
 *
 * Every field is re-run through the SAME normalizers and caps the builder
 * uses at capture time. Deliberately NOT implemented as
 * `rehydrateBuilder(...).serialize()`: that drops fields the builder cannot
 * rebuild (phases, the run identity, the round marker), so a plain read would
 * silently rewrite history. Unknown inputs degrade instead of throwing — this
 * runs after the tool's structural gate but must stay safe on its own.
 */
export function normalizeManifestBounds(value: TranscriptManifest): TranscriptManifest {
  const m = (value && typeof value === 'object' ? value : {}) as Partial<TranscriptManifest>

  const rounds: TranscriptRound[] = (Array.isArray(m.rounds) ? m.rounds : [])
    .slice(0, MAX_ROUNDS)
    .map((r) => {
      const row = (r && typeof r === 'object' ? r : {}) as Partial<TranscriptRound>
      const threads = (Array.isArray(row.threads) ? row.threads : [])
        .slice(0, MAX_THREADS_RESTORED)
        .map((t) => normalizeThreadRow(t))
      return { round: Math.max(clampRoundValue(row.round), 1), threads }
    })

  const fixes = (Array.isArray(m.fixes) ? m.fixes : [])
    .map((f) => normalizeFixRow(f))
    .filter((f): f is TranscriptFix => f !== null)
  const timeline = (Array.isArray(m.timeline) ? m.timeline : [])
    .map((e) => normalizeTimelineRow(e))
    .filter((e): e is TranscriptEntry => e !== null)
  const globalFindings = (Array.isArray(m.findings) ? m.findings : [])
    .map((f) => normalizeFinding(f))
    .filter((f): f is TranscriptFinding => f !== null)
  const convergence = (Array.isArray(m.convergence) ? m.convergence : [])
    .slice(0, MAX_ROUNDS)
    .map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : -1))
  const validations = Array.isArray(m.validations)
    ? m.validations
        .map((v) => normalizeValidation(v))
        .filter((v): v is TranscriptValidation => v !== null)
        .slice(-MAX_VALIDATIONS)
    : undefined

  const policy =
    m.approval?.policy === 'deny' || m.approval?.policy === 'allow' ? m.approval.policy : 'ask'
  const out: TranscriptManifest = {
    version: typeof m.version === 'number' && Number.isFinite(m.version) ? m.version : TRANSCRIPT_VERSION,
    project: typeof m.project === 'string' ? m.project : '',
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : '',
    active: m.active === true,
    mode: m.mode === 'dry-run' || m.mode === 'normal' ? m.mode : null,
    goal: typeof m.goal === 'string' ? m.goal : '',
    // A phase list is free-form narration names — strings only, bounded.
    phases: clampStringList(Array.isArray(m.phases) ? (m.phases as string[]) : [], 100),
    round: clampRoundValue(m.round),
    maxRounds: clampCountValue(m.maxRounds),
    rounds,
    convergence,
    findings:
      globalFindings.length > MAX_FINDINGS_TOTAL
        ? globalFindings.slice(-MAX_FINDINGS_TOTAL)
        : globalFindings,
    fixes: fixes.slice(-MAX_FIXES),
    checkpoint: normalizeCheckpointRow(m.checkpoint),
    timeline: timeline.slice(-MAX_TIMELINE),
    nudge: normalizeNudgeRow(m.nudge),
    approval: {
      active: typeof m.approval?.active === 'boolean' ? m.approval.active : policy !== 'allow',
      policy,
    },
  }
  if (validations !== undefined) out.validations = validations
  if (m.taskMode === 'code' || m.taskMode === 'iterate' || m.taskMode === null) out.taskMode = m.taskMode
  if (typeof m.stoppedReason === 'string' || m.stoppedReason === null) out.stoppedReason = m.stoppedReason
  return out
}