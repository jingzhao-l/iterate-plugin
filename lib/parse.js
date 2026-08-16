/**
 * lib/parse.js — Pure logic for iterate client UI.
 *
 * Framework-agnostic, DOM-free, single-file, testable with Node.js assert.
 * Every function is exported for unit test coverage.
 *
 * @module iterate-ui/parse
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Severity ordering (lowest index = most severe). */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

/** Severity labels (short form for badges). */
export const SEVERITY_LABEL = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
}

/** Severity colors (CSS-compatible). */
export const SEVERITY_COLOR = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#6b7280',
}

// ─── ReviewReport detection ──────────────────────────────────────────────────

/**
 * Check whether `obj` is a valid ReviewReport-like object.
 * The minimum requirement: an object with `convergence` (object),
 * `findings` (array), and `rounds` (array).
 *
 * @param {unknown} obj
 * @returns {obj is Record<string, unknown>}
 */
export function isReviewReport(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  return (
    typeof o.convergence === 'object' &&
    o.convergence !== null &&
    Array.isArray(o.findings) &&
    Array.isArray(o.rounds)
  )
}

/**
 * Deep-scan an object tree for the first ReviewReport.
 *
 * - Uses a `seen` Set to avoid circular references.
 * - Respects `maxDepth` (default 20) to cap stack depth.
 * - Returns the first Report found (breadth-first precedence), or null.
 *
 * @param {unknown} obj
 * @param {Set<unknown>} [seen]
 * @param {number} [maxDepth=20]
 * @returns {Record<string, unknown> | null}
 */
export function findReportInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null
  if (!obj || typeof obj !== 'object') return null

  const s = seen || new Set()
  if (s.has(obj)) return null
  s.add(obj)

  // Check self
  if (isReviewReport(obj)) return /** @type {Record<string, unknown>} */ (obj)

  // Check arrays first (breadth-first within a node)
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findReportInObject(item, s, maxDepth - 1)
      if (found) return found
    }
    return null
  }

  // Check object values
  const o = /** @type {Record<string, unknown>} */ (obj)
  for (const key of Object.keys(o)) {
    const val = o[key]
    if (val && typeof val === 'object') {
      // Check leaf values that are arrays or objects
      const found = findReportInObject(val, s, maxDepth - 1)
      if (found) return found
    }
  }

  return null
}

/**
 * Scan a session snapshot (or any object) for the latest iterate_review tool
 * call result that contains a ReviewReport. Prefers the most recent one.
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForReport(session) {
  if (!session || typeof session !== 'object') return null

  // Try direct find first
  const direct = findReportInObject(session)
  if (direct) return direct

  // Try common session structures
  const s = /** @type {Record<string, unknown>} */ (session)

  // Common pattern: session.toolCalls[].result.report
  if (Array.isArray(s.toolCalls)) {
    const calls = /** @type {Array<Record<string, unknown>>} */ (s.toolCalls)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (!call) continue
      if (call.tool === 'iterate_review' || String(call.tool ?? '').endsWith('iterate_review')) {
        const result = call.result
        if (result && typeof result === 'object') {
          const r = /** @type {Record<string, unknown>} */ (result)
          if (r.report && typeof r.report === 'object') {
            return /** @type {Record<string, unknown>} */ (r.report)
          }
        }
      }
    }
  }

  // Common pattern: session.messages[].tool_calls[].function.arguments
  if (Array.isArray(s.messages)) {
    const msgs = /** @type {Array<Record<string, unknown>>} */ (s.messages)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg || !Array.isArray(msg.tool_calls)) continue
      const calls = /** @type {Array<Record<string, unknown>>} */ (msg.tool_calls)
      for (const call of calls) {
        if (!call) continue
        const fn = call.function
        if (fn && typeof fn === 'object') {
          const f = /** @type {Record<string, unknown>} */ (fn)
          if (String(f.name ?? '').endsWith('iterate_review')) {
            // Try to parse arguments
            try {
              const args = JSON.parse(String(f.arguments ?? '{}'))
              const found = findReportInObject(args)
              if (found) return found
            } catch {
              // Not JSON, skip
            }
          }
        }
      }
    }
  }

  return null
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a ReviewReport, filling in missing optional fields with computed
 * defaults. Never mutates the input.
 *
 * @param {Record<string, unknown>} report
 * @returns {Record<string, unknown>}
 */
export function normalizeReport(report) {
  const convergence = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const rounds = /** @type {Array<unknown>} */ (report.rounds ?? [])
  const findings = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? [])

  // Normalize convergence
  const totalRounds =
    typeof convergence.totalRounds === 'number'
      ? convergence.totalRounds
      : rounds.length

  const normalizedConvergence = {
    totalRounds,
    findingsByRound: Array.isArray(convergence.findingsByRound)
      ? convergence.findingsByRound
      : rounds.map((r) => {
          const rr = /** @type {Record<string, unknown>} */ (r)
          return Array.isArray(rr?.findings) ? rr.findings.length : 0
        }),
    converged: convergence.converged === true,
    stoppedReason: convergence.stoppedReason ?? (rounds.length < totalRounds ? 'converged' : 'max_rounds_reached'),
  }

  // Compute summary if missing. Always build a NEW object so the input's
  // summary (or any other field) is never mutated.
  let summary = report.summary
  if (!summary || typeof summary !== 'object') {
    summary = computeSummaryFromFindings(findings)
  } else {
    const s = /** @type {Record<string, unknown>} */ (summary)
    const computed = computeSummaryFromFindings(findings)
    summary = {
      totalFindings: typeof s.totalFindings === 'number' ? s.totalFindings : findings.length,
      critical: typeof s.critical === 'number' ? s.critical : computed.critical,
      high: typeof s.high === 'number' ? s.high : computed.high,
      medium: typeof s.medium === 'number' ? s.medium : computed.medium,
      low: typeof s.low === 'number' ? s.low : computed.low,
      byDimension: s.byDimension && typeof s.byDimension === 'object'
        ? s.byDimension
        : computed.byDimension,
    }
  }

  return {
    mode: report.mode ?? 'dry-run',
    goal: report.goal ?? '',
    dimensions: Array.isArray(report.dimensions) ? report.dimensions : [],
    maxReviewRounds: report.maxReviewRounds ?? totalRounds,
    rounds,
    findings,
    convergence: normalizedConvergence,
    summary,
  }
}

/**
 * Compute summary stats from findings array.
 *
 * @param {Array<Record<string, unknown>>} findings
 * @returns {{ totalFindings: number, critical: number, high: number, medium: number, low: number, byDimension: Record<string, number> }}
 */
function computeSummaryFromFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  /** @type {Record<string, number>} */
  const byDimension = {}

  for (const f of findings) {
    const sev = String(f.severity ?? 'low')
    if (sev in counts) counts[sev]++
    const dim = String(f.dimension ?? 'unknown')
    byDimension[dim] = (byDimension[dim] ?? 0) + 1
  }

  return {
    totalFindings: findings.length,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    byDimension,
  }
}

export { computeSummaryFromFindings }

// ─── Convergence helpers ─────────────────────────────────────────────────────

/**
 * Compute progress percentage (0-100) from a normalized report.
 *
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function computeConvergenceProgress(report) {
  const convergence = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const totalRounds = typeof convergence.totalRounds === 'number'
    ? convergence.totalRounds
    : 1
  const currentRounds = /** @type {Array<unknown>} */ (report.rounds ?? []).length
  // Guard against an empty report (totalRounds <= 0) producing NaN.
  if (!(totalRounds > 0)) return 0
  return Math.min(100, Math.round((currentRounds / totalRounds) * 100))
}

/**
 * Get the current round number (1-indexed) from a report.
 *
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function getCurrentRound(report) {
  return (/** @type {Array<unknown>} */ (report.rounds ?? [])).length
}

/**
 * Get the total round count (max) from a report.
 *
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function getTotalRounds(report) {
  const convergence = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  return typeof convergence.totalRounds === 'number'
    ? convergence.totalRounds
    : 1
}

// ─── Severity stats ──────────────────────────────────────────────────────────

/**
 * Count findings by severity. Returns an object with `critical`, `high`,
 * `medium`, `low` keys.
 *
 * @param {Record<string, unknown>} report
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
export function severityStats(report) {
  const findings = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? [])
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) {
    const sev = String(f.severity ?? 'low')
    if (sev in counts) counts[sev]++
  }
  return counts
}

// ─── Dimension grouping ──────────────────────────────────────────────────────

/**
 * Group findings by dimension. Returns a Record<string, Array<finding>>.
 *
 * @param {Record<string, unknown>} report
 * @returns {Record<string, Array<Record<string, unknown>>>}
 */
export function groupByDimension(report) {
  const findings = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? [])
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const groups = {}
  for (const f of findings) {
    const dim = String(f.dimension ?? 'unknown')
    if (!groups[dim]) groups[dim] = []
    groups[dim].push(f)
  }
  return groups
}

// ─── Triage state ────────────────────────────────────────────────────────────

/** Triage verdict values */
export const TRIAGE_VERDICTS = /** @type {const} */ (['keep', 'skip', 'ignore'])

/**
 * Build initial triage state for a report. Each finding gets a default verdict
 * of 'keep'. Returns a Map where key = finding index (string), value = verdict.
 *
 * @param {Record<string, unknown>} report
 * @returns {Record<string, 'keep' | 'skip' | 'ignore'>}
 */
export function buildTriageState(report) {
  const findings = /** @type {Array<unknown>} */ (report.findings ?? [])
  /** @type {Record<string, 'keep' | 'skip' | 'ignore'>} */
  const state = {}
  for (let i = 0; i < findings.length; i++) {
    state[String(i)] = 'keep'
  }
  return state
}

// ─── Report hashing (for localStorage key) ────────────────────────────────────

/**
 * Create a deterministic hash string from a report's key fields.
 * Used as localStorage key for persisting triage verdicts.
 *
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function hashReport(report) {
  const convergence = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const totalRounds = String(convergence.totalRounds ?? '')
  const findingsCount = String((/** @type {Array<unknown>} */ (report.findings ?? [])).length)
  const firstFinding = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? [])[0]
  const firstSummary = firstFinding ? String(firstFinding.summary ?? '') : ''
  const mode = String(report.mode ?? '')
  // Use mode + totalRounds + findingsCount + first 20 chars of first finding summary
  return `iterate-triage-${mode}-${totalRounds}-${findingsCount}-${firstSummary.slice(0, 20)}`
}

// ─── Known-intentional YAML builder ──────────────────────────────────────────

/**
 * Convert triage entries with verdict 'ignore' to a YAML-compatible text
 * snippet for known_intentional entries.
 *
 * @param {Array<{ file: string, line?: number, dimension: string, reason: string }>} entries
 * @returns {string}
 */
export function toKnownIntentionalYaml(entries) {
  if (!entries || entries.length === 0) return ''

  const lines = ['known_intentional:']
  for (const e of entries) {
    lines.push(`  - file: ${JSON.stringify(e.file)}`)
    if (e.line !== undefined && e.line > 0) {
      lines.push(`    line: ${e.line}`)
    }
    lines.push(`    dimension: ${JSON.stringify(e.dimension)}`)
    lines.push(`    reason: ${JSON.stringify(e.reason)}`)
  }
  return lines.join('\n')
}

/**
 * Build a text instruction that the user can paste to the model to trigger
 * `iterate_triage` tool call. Works even if the user hasn't yet configured
 * an `iterate_triage` tool — the instruction tells the model what to do.
 *
 * @param {Array<{ file: string, line?: number, dimension: string, reason: string }>} entries
 * @returns {string}
 */
export function buildApplyInstruction(entries) {
  if (!entries || entries.length === 0) return ''

  const payload = JSON.stringify(
    {
      operation: 'apply',
      entries: entries.map((e) => ({
        file: e.file,
        ...(e.line !== undefined ? { line: e.line } : {}),
        dimension: e.dimension,
        reason: e.reason,
      })),
    },
    null,
    2,
  )

  return (
    `Please call \`iterate_triage\` with the following payload to apply the triage verdicts:\n\n` +
    `\`\`\`json\n${payload}\n\`\`\``
  )
}

/**
 * Collect ignored entries from triage state + findings, returning the
 * structured data ready for `iterate_triage` tool call.
 *
 * @param {Record<string, 'keep' | 'skip' | 'ignore'>} triageState
 * @param {Array<Record<string, unknown>>} findings
 * @returns {Array<{ file: string, line?: number, dimension: string, reason: string }>}
 */
export function collectIgnoredEntries(triageState, findings) {
  const entries = []
  for (const [idx, verdict] of Object.entries(triageState)) {
    if (verdict !== 'ignore') continue
    const finding = findings[Number(idx)]
    if (!finding) continue
    entries.push({
      file: String(finding.file ?? ''),
      ...(typeof finding.line === 'number' && finding.line > 0
        ? { line: finding.line }
        : {}),
      dimension: String(finding.dimension ?? ''),
      reason: String(finding.summary ?? ''),
    })
  }
  return entries
}