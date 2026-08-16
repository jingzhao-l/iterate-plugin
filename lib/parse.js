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

// ─── Finding filtering ──────────────────────────────────────────────────────

/**
 * Normalize a caller-supplied filter into a stable shape.
 * Unknown severity values are dropped; search is lower-cased + trimmed.
 *
 * @param {{ severities?: string[], dimensions?: string[], search?: string } | null | undefined} filter
 * @returns {{ severities: string[], dimensions: string[], search: string }}
 */
export function normalizeFindingFilter(filter) {
  const f = filter && typeof filter === 'object' ? filter : {}
  const severities = Array.isArray(f.severities)
    ? f.severities.filter((s) => SEVERITY_ORDER.includes(String(s)))
    : []
  const dimensions = Array.isArray(f.dimensions)
    ? f.dimensions.filter((d) => typeof d === 'string' && d.length > 0)
    : []
  const search = typeof f.search === 'string' ? f.search.trim().toLowerCase() : ''
  return { severities, dimensions, search }
}

/**
 * Whether a single finding matches a normalized filter.
 * An empty filter matches everything.
 *
 * @param {Record<string, unknown>} finding
 * @param {{ severities: string[], dimensions: string[], search: string }} filter
 * @returns {boolean}
 */
export function findingMatches(finding, filter) {
  const f = normalizeFindingFilter(filter)
  const sev = String(finding.severity ?? 'low')
  if (f.severities.length > 0 && !f.severities.includes(sev)) return false
  const dim = String(finding.dimension ?? '')
  if (f.dimensions.length > 0 && !f.dimensions.includes(dim)) return false
  if (f.search) {
    const haystack = [
      String(finding.file ?? ''),
      String(finding.summary ?? ''),
      String(finding.dimension ?? ''),
      String(finding.suggested_fix ?? ''),
    ].join(' ').toLowerCase()
    if (haystack.indexOf(f.search) < 0) return false
  }
  return true
}

/**
 * Filter a findings array, returning only the matches.
 *
 * @param {Array<Record<string, unknown>>} findings
 * @param {{ severities?: string[], dimensions?: string[], search?: string } | null | undefined} filter
 * @returns {Array<Record<string, unknown>>}
 */
export function filterFindings(findings, filter) {
  const f = normalizeFindingFilter(filter)
  return (Array.isArray(findings) ? findings : []).filter((finding) => findingMatches(finding, f))
}

/**
 * Filter a findings array, returning the matches together with their ORIGINAL
 * indices. Batch operations act on these indices so the triage state (keyed by
 * original index) stays consistent even when some findings are hidden.
 *
 * @param {Array<Record<string, unknown>>} findings
 * @param {{ severities?: string[], dimensions?: string[], search?: string } | null | undefined} filter
 * @returns {{ filtered: Array<Record<string, unknown>>, indices: number[] }}
 */
export function filterFindingsWithIndices(findings, filter) {
  const f = normalizeFindingFilter(filter)
  const list = Array.isArray(findings) ? findings : []
  const filtered = []
  const indices = []
  for (let i = 0; i < list.length; i++) {
    if (findingMatches(list[i], f)) {
      filtered.push(list[i])
      indices.push(i)
    }
  }
  return { filtered, indices }
}

/**
 * Build the severity + dimension filter options with per-option counts, so the
 * UI can render chips/selects and show how many findings each filters down to.
 *
 * @param {Array<Record<string, unknown>>} findings
 * @returns {{ severities: Array<{ value: string, count: number }>, dimensions: Array<{ value: string, count: number }> }}
 */
export function buildFilterOptions(findings) {
  const list = Array.isArray(findings) ? findings : []
  const severities = SEVERITY_ORDER.map((value) => ({ value, count: 0 }))
  /** @type {Record<string, number>} */
  const dimCounts = {}
  for (const f of list) {
    const sev = String(f.severity ?? 'low')
    const sv = severities.find((s) => s.value === sev)
    if (sv) sv.count++
    const dim = String(f.dimension ?? 'unknown')
    dimCounts[dim] = (dimCounts[dim] ?? 0) + 1
  }
  return {
    severities: severities.map((s) => ({ ...s })),
    dimensions: Object.keys(dimCounts).map((value) => ({ value, count: dimCounts[value] })),
  }
}

// ─── Triage batch operations ────────────────────────────────────────────────

/**
 * Count how many findings carry each verdict.
 *
 * @param {Record<string, 'keep' | 'skip' | 'ignore'>} triageState
 * @returns {{ keep: number, skip: number, ignore: number }}
 */
export function countVerdicts(triageState) {
  const counts = { keep: 0, skip: 0, ignore: 0 }
  for (const v of Object.values(triageState ?? {})) {
    if (v === 'keep' || v === 'skip' || v === 'ignore') counts[v]++
  }
  return counts
}

/**
 * Set the verdict for a list of finding indices. Returns a NEW state
 * (the input is never mutated).
 *
 * @param {Record<string, 'keep' | 'skip' | 'ignore'>} triageState
 * @param {number[]} indices
 * @param {'keep' | 'skip' | 'ignore'} verdict
 * @returns {Record<string, 'keep' | 'skip' | 'ignore'>}
 */
export function batchSetVerdict(triageState, indices, verdict) {
  if (verdict !== 'keep' && verdict !== 'skip' && verdict !== 'ignore') return triageState
  if (!Array.isArray(indices) || indices.length === 0) return triageState
  const next = { ...triageState }
  for (const idx of indices) {
    if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0) {
      next[String(idx)] = verdict
    }
  }
  return next
}

/**
 * Set the verdict for ALL findings (or only the given index whitelist).
 *
 * @param {Record<string, 'keep' | 'skip' | 'ignore'>} triageState
 * @param {'keep' | 'skip' | 'ignore'} verdict
 * @param {number[]} [indices]
 * @returns {Record<string, 'keep' | 'skip' | 'ignore'>}
 */
export function setAllVerdicts(triageState, verdict, indices) {
  const targets = Array.isArray(indices)
    ? indices
    : Object.keys(triageState ?? {}).map(Number)
  return batchSetVerdict(triageState, targets, verdict)
}

// ─── History & trend ────────────────────────────────────────────────────────

/**
 * Per-round finding counts (including severity breakdown), oldest first.
 * Derived from `report.rounds`.
 *
 * @param {Record<string, unknown>} report
 * @returns {Array<{ round: number, count: number, critical: number, high: number, medium: number, low: number }>}
 */
export function buildRoundHistory(report) {
  const rounds = Array.isArray(report.rounds) ? report.rounds : []
  return rounds.map((r) => {
    const rr = /** @type {Record<string, unknown>} */ (r)
    const findings = Array.isArray(rr.findings) ? rr.findings : []
    const sev = severityStats({ findings })
    return {
      round: typeof rr.round === 'number' ? rr.round : 0,
      count: findings.length,
      critical: sev.critical,
      high: sev.high,
      medium: sev.medium,
      low: sev.low,
    }
  })
}

/**
 * Findings-by-round trend points. Prefers the explicit
 * `convergence.findingsByRound` when present, otherwise derives from rounds.
 *
 * @param {Record<string, unknown>} report
 * @returns {Array<{ round: number, count: number }>}
 */
export function buildFindingTrend(report) {
  const conv = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  if (Array.isArray(conv.findingsByRound)) {
    return conv.findingsByRound.map((n, i) => ({ round: i + 1, count: typeof n === 'number' ? n : 0 }))
  }
  return buildRoundHistory(report).map((h) => ({ round: h.round, count: h.count }))
}

/**
 * Trend metrics for the dashboard chart + summary line.
 *
 * @param {Record<string, unknown>} report
 * @returns {{ points: Array<{ round: number, count: number }>, total: number, firstRound: number, lastRound: number, reductionPercent: number, converged: boolean }}
 */
export function computeTrendMetrics(report) {
  const conv = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const points = buildFindingTrend(report)
  const total = points.reduce((sum, p) => sum + p.count, 0)
  const firstRound = points.length > 0 ? points[0].count : 0
  const lastRound = points.length > 0 ? points[points.length - 1].count : 0
  const reductionPercent = firstRound > 0 ? Math.round(((firstRound - lastRound) / firstRound) * 100) : 0
  return {
    points,
    total,
    firstRound,
    lastRound,
    reductionPercent,
    converged: conv.converged === true,
  }
}

/**
 * Peak count among trend points (for chart scaling). Never returns 0 so the
 * chart always has a sane baseline.
 *
 * @param {Array<{ round: number, count: number }>} points
 * @returns {number}
 */
export function trendMax(points) {
  let max = 1
  for (const p of Array.isArray(points) ? points : []) {
    if (typeof p.count === 'number' && p.count > max) max = p.count
  }
  return max
}

// ─── Completion notification ────────────────────────────────────────────────

/**
 * One-line completion summary for notifications ("已收敛 / 已达最大轮数").
 *
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function buildCompletionSummary(report) {
  const conv = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const rounds = getCurrentRound(report)
  const total = getTotalRounds(report)
  const stats = severityStats(report)
  const converged = conv.converged === true
  const reason = converged ? '已收敛' : `已达最大轮数 ${total}`
  const totalFindings = stats.critical + stats.high + stats.medium + stats.low
  return `iterate 评审完成 · ${rounds}/${total} 轮 · ${totalFindings} 项发现 · ${reason}`
}

// ─── Config edit guidance ───────────────────────────────────────────────────

/**
 * Editable config fields (key + label + hint), used by the settings guide.
 * @type {Array<{ key: string, label: string, hint: string }>}
 */
export const CONFIG_EDIT_FIELDS = [
  { key: 'goal', label: '目标', hint: '一句话描述本次迭代目标（字符串）' },
  { key: 'dimensions', label: '审查维度', hint: '数组，如 ["correctness","security"]' },
  { key: 'max_rounds', label: '最大轮数', hint: '正整数' },
  { key: 'review.scope', label: '审查范围', hint: '"full" 或 "changed-only"' },
  { key: 'atomic.max_lines', label: '原子修复上限行数', hint: '正整数' },
  { key: 'git.push_per_round', label: '每轮推送', hint: 'true / false' },
]

/**
 * Static copy-paste config editing guide (shown in the settings page).
 *
 * @returns {string}
 */
export function buildConfigEditGuide() {
  const lines = [
    'iterate 配置编辑指引',
    '---------------------',
    '配置文件：项目根目录 iterate.config.yaml。',
    '',
    '可编辑字段：',
    ...CONFIG_EDIT_FIELDS.map((f) => `- ${f.key}（${f.label}）：${f.hint}`),
    '',
    '让模型帮你改：',
    '1. 调用 iterate_config({ operation: "read" }) 查看当前配置；',
    '2. 说明想改的字段，例如「把 max_rounds 改成 5，dimensions 只保留 correctness 和 security」；',
    '3. 模型会调用 iterate_config({ operation: "write", updates: {...} }) 写入，写入前自动备份，失败自动回滚。',
  ]
  return lines.join('\n')
}

/**
 * Build a copy-paste instruction for a desired config change. The user picks
 * the fields they want to change; the resulting text is meant to be pasted to
 * the model to trigger an `iterate_config` write.
 *
 * @param {Record<string, unknown>} desiredChanges
 * @returns {string}
 */
export function buildConfigEditInstruction(desiredChanges) {
  const payload = JSON.stringify({ operation: 'write', updates: desiredChanges }, null, 2)
  return `请调用 \`iterate_config\` 写入以下配置更新：\n\n\`\`\`json\n${payload}\n\`\`\``
}

/**
 * Keyboard shortcut → triage verdict mapping (used by the triage panel).
 * @type {Record<string, 'keep' | 'skip' | 'ignore'>}
 */
export const VERDICT_SHORTCUTS = {
  y: 'keep',
  Y: 'keep',
  n: 'skip',
  N: 'skip',
  a: 'ignore',
  A: 'ignore',
}

/**
 * Map a keyboard event key to a triage verdict, or null when the key is not a
 * triage shortcut.
 *
 * @param {string} key
 * @returns {'keep' | 'skip' | 'ignore' | null}
 */
export function keyToVerdict(key) {
  return VERDICT_SHORTCUTS[key] ?? null
}