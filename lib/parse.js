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
  // medium is used both for dots/fills and as TEXT (stat numbers, table
  // headers); #eab308 is illegible as text on light backgrounds (~1.6:1).
  // amber-600 (#d97706) ~3.2:1 — still short of AA; go darker for legibility.
  medium: '#b45309',
  low: '#6b7280',
}

// ─── Safe property access ────────────────────────────────────────────────────
// Session snapshots handed to the client UI can be cordis service proxies or
// contain proxy references (owner share objects). Reading an un-injected
// service name off such a proxy throws `cannot get property "x" without
// inject`. All deep scans below therefore read through these helpers so a
// hostile/proxied object degrades to "no match" instead of crashing the slot.

/** Read one property that may sit on a cordis service proxy; never throws. */
function safeGet(o, key) {
  try {
    return o[key]
  } catch {
    return undefined
  }
}

/** Keys of an object that may be a cordis service proxy; never throws. */
function safeKeys(o) {
  try {
    return Object.keys(o)
  } catch {
    return []
  }
}

// ─── Interruption / resume + image attachment detection ──────────────────────

/**
 * Deep-scan an object tree for a decision-log `resume` marker.
 * The normal-mode workflow appends a `resume` decision-log entry when it
 * continues a previous interrupted run:
 *   { type: "resume", data: { resumedFromRound, resumeCount } }
 * This is the durable client-side signal that a run was interrupted and
 * recovered. Returns the highest `resumeCount` observed, or 0 when none.
 *
 * @param {unknown} obj
 * @param {Set<unknown>} [seen]
 * @param {number} [maxDepth=20]
 * @returns {number}
 */
export function scanSessionForResume(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return 0
  if (!obj || typeof obj !== 'object') return 0

  const s = seen || new Set()
  if (s.has(obj)) return 0
  s.add(obj)

  let best = 0

  // Direct marker: { type: "resume", data: { resumeCount } }.
  const direct = /** @type {Record<string, unknown>} */ (obj)
  if (safeGet(direct, 'type') === 'resume') {
    const data = /** @type {Record<string, unknown>} */ (safeGet(direct, 'data') || {})
    if (typeof safeGet(data, 'resumeCount') === 'number' && safeGet(data, 'resumeCount') > best) {
      best = safeGet(data, 'resumeCount')
    }
  }
  // Nested entry: { entry: { type: "resume", data: { resumeCount } } }.
  const directEntry = safeGet(direct, 'entry')
  if (directEntry && typeof directEntry === 'object') {
    const entry = /** @type {Record<string, unknown>} */ (directEntry)
    if (safeGet(entry, 'type') === 'resume') {
      const data = /** @type {Record<string, unknown>} */ (safeGet(entry, 'data') || {})
      if (typeof safeGet(data, 'resumeCount') === 'number' && safeGet(data, 'resumeCount') > best) {
        best = safeGet(data, 'resumeCount')
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = scanSessionForResume(item, s, maxDepth - 1)
      if (found > best) best = found
    }
    return best
  }

  for (const key of safeKeys(direct)) {
    const val = safeGet(direct, key)
    if (val && typeof val === 'object') {
      const found = scanSessionForResume(val, s, maxDepth - 1)
      if (found > best) best = found
    }
  }

  return best
}

/**
 * Count distinct user-attached images inside a session snapshot.
 * Matches dsh image blocks ({ type: "image", attachment: {...} }) and
 * raw attachment references ({ mediaType, width, height, bytes }). Dedupes by
 * `attachmentId` when present so the same image never counts twice.
 *
 * @param {unknown} session
 * @returns {number}
 */
export function countSessionImages(session) {
  if (!session || typeof session !== 'object') return 0

  const ids = new Set()
  let count = 0

  /** @param {unknown} obj */
  const walk = (obj, depth) => {
    if (depth <= 0 || !obj || typeof obj !== 'object') return
    if (seen.has(obj)) return
    seen.add(obj)
    const o = /** @type {Record<string, unknown>} */ (obj)

    // Image block: { type: "image", attachment: { ...ref } }.
    let ref = null
    if (safeGet(o, 'type') === 'image' && safeGet(o, 'attachment') && typeof safeGet(o, 'attachment') === 'object') {
      ref = /** @type {Record<string, unknown>} */ (safeGet(o, 'attachment'))
    }
    // Raw attachment reference shape.
    if (!ref && typeof safeGet(o, 'mediaType') === 'string' && String(safeGet(o, 'mediaType')).startsWith('image/')) {
      ref = o
    }
    if (ref) {
      const id = typeof safeGet(ref, 'attachmentId') === 'string' ? safeGet(ref, 'attachmentId') : null
      if (id) {
        if (!ids.has(id)) { ids.add(id); count += 1 }
      } else {
        count += 1
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth - 1)
      return
    }
    for (const key of safeKeys(o)) {
      const val = safeGet(o, key)
      if (val && typeof val === 'object') walk(val, depth - 1)
    }
  }

  const seen = new Set()
  walk(session, 12)
  return count
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
  const convergence = safeGet(o, 'convergence')
  return (
    typeof convergence === 'object' &&
    convergence !== null &&
    Array.isArray(safeGet(o, 'findings')) &&
    Array.isArray(safeGet(o, 'rounds'))
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
  for (const key of safeKeys(o)) {
    const val = safeGet(o, key)
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

  const s = /** @type {Record<string, unknown>} */ (session)

  // LATEST-first scan: walk the chronological structures in reverse before the
  // generic deep find, so a conversation with several reviews surfaces the
  // most recent report — the generic find would return the FIRST match.
  // Common pattern: session.toolCalls[].result.report
  const toolCalls = safeGet(s, 'toolCalls')
  if (Array.isArray(toolCalls)) {
    const calls = /** @type {Array<Record<string, unknown>>} */ (toolCalls)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (!call) continue
      if (safeGet(call, 'tool') === 'iterate_review' || String(safeGet(call, 'tool') ?? '').endsWith('iterate_review')) {
        const result = safeGet(call, 'result')
        if (result && typeof result === 'object') {
          const r = /** @type {Record<string, unknown>} */ (result)
          const report = safeGet(r, 'report')
          if (report && typeof report === 'object') {
            return /** @type {Record<string, unknown>} */ (report)
          }
        }
      }
    }
  }

  // Common pattern: session.messages[].tool_calls[].function.arguments
  const messages = safeGet(s, 'messages')
  if (Array.isArray(messages)) {
    const msgs = /** @type {Array<Record<string, unknown>>} */ (messages)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      const msgCalls = msg && Array.isArray(safeGet(msg, 'tool_calls')) ? safeGet(msg, 'tool_calls') : null
      if (!msg || !msgCalls) continue
      const calls = /** @type {Array<Record<string, unknown>>} */ (msgCalls)
      for (const call of calls) {
        if (!call) continue
        const fn = safeGet(call, 'function')
        if (fn && typeof fn === 'object') {
          const f = /** @type {Record<string, unknown>} */ (fn)
          if (String(safeGet(f, 'name') ?? '').endsWith('iterate_review')) {
            // Try to parse arguments
            try {
              const args = JSON.parse(String(safeGet(f, 'arguments') ?? '{}'))
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

// ─── Runtime-observatory transcript detection ────────────────────────────────

/**
 * Check whether `obj` is a valid runtime-observatory TranscriptManifest.
 * Discriminators vs a ReviewReport: `convergence` is a NUMBER ARRAY (the
 * findings-per-round trend), not an object like ReviewReport.convergence, and
 * `version` is a number. Requires `version` + `rounds` (array) + `convergence`
 * (array) so a ReviewReport never collides with a manifest.
 *
 * @param {unknown} obj
 * @returns {obj is Record<string, unknown>}
 */
export function isTranscriptManifest(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  return (
    typeof safeGet(o, 'version') === 'number' &&
    Array.isArray(safeGet(o, 'rounds')) &&
    Array.isArray(safeGet(o, 'convergence'))
  )
}

/**
 * Attach the outer `live` array (sibling of `transcript` in an
 * iterate_transcript result: `{ operation, found, live:[...], transcript }`) to
 * a found manifest, so the secondary-subagent activity stream rides along with
 * the manifest. Builds a defensive shallow copy (never mutates a possibly
 * shared/proxied manifest). Returns the manifest unchanged when the source has
 * no `live` array or the manifest already carries one.
 *
 * @param {Record<string, unknown> | null} manifest
 * @param {unknown} source
 * @returns {Record<string, unknown> | null}
 */
function attachLive(manifest, source) {
  if (!manifest || typeof manifest !== 'object') return manifest
  const live = source && typeof source === 'object' ? safeGet(source, 'live') : undefined
  if (!Array.isArray(live)) return manifest
  const m = /** @type {Record<string, unknown>} */ (manifest)
  if (safeGet(m, 'live') !== undefined) return manifest
  const copy = /** @type {Record<string, unknown>} */ ({})
  for (const k of safeKeys(m)) copy[k] = safeGet(m, k)
  copy.live = live
  return copy
}

/**
 * Pull a manifest out of a single tool-result node. Accepts either the raw
 * manifest object, `{ operation: 'capture', transcript: manifest }`, a
 * string-wrapped JSON payload, or a plain wrapper (e.g. `{ message: ... }`).
 * Falls back to a shallow deep-find (findTranscriptInObject) so a nested
 * manifest buried inside an arbitrary result still surfaces. Never throws.
 *
 * @param {unknown} obj
 * @returns {Record<string, unknown> | null}
 */
function extractTranscript(obj) {
  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj)
      return extractTranscript(parsed)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object') return null

  // Direct manifest.
  if (isTranscriptManifest(obj)) return /** @type {Record<string, unknown>} */ (obj)

  const o = /** @type {Record<string, unknown>} */ (obj)

  // { operation: 'capture', transcript: manifest, live: [...] }.
  if (safeGet(o, 'operation') === 'capture') {
    const t = safeGet(o, 'transcript')
    if (t && typeof t === 'object' && isTranscriptManifest(t)) {
      return attachLive(/** @type {Record<string, unknown>} */ (t), o)
    }
  }

  // Wrapper shapes the harness may emit: { message: ... }, { result: ... },
  // { content: [...] } (an assistant tool-call block).
  for (const key of ['message', 'result', 'content']) {
    const val = safeGet(o, key)
    if (val !== undefined) {
      if (Array.isArray(val)) {
        for (const item of val) {
          const found = extractTranscript(item)
          if (found) return attachLive(found, o)
        }
      } else {
        const found = extractTranscript(val)
        if (found) return attachLive(found, o)
      }
    }
  }

  // Generic deep find for resilience.
  return attachLive(findTranscriptInObject(o), o)
}

/**
 * Deep-scan an object tree for the first TranscriptManifest (same traversal
 * semantics as `findReportInObject`: circular-reference + depth guards).
 *
 * @param {unknown} obj
 * @param {Set<unknown>} [seen]
 * @param {number} [maxDepth=20]
 * @returns {Record<string, unknown> | null}
 */
export function findTranscriptInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null
  if (!obj || typeof obj !== 'object') return null

  const s = seen || new Set()
  if (s.has(obj)) return null
  s.add(obj)

  if (isTranscriptManifest(obj)) return /** @type {Record<string, unknown>} */ (obj)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findTranscriptInObject(item, s, maxDepth - 1)
      if (found) return found
    }
    return null
  }

  const o = /** @type {Record<string, unknown>} */ (obj)
  for (const key of safeKeys(o)) {
    const val = safeGet(o, key)
    if (val && typeof val === 'object') {
      const found = findTranscriptInObject(val, s, maxDepth - 1)
      if (found) return found
    }
  }

  return null
}

/**
 * Scan a session snapshot (or any object) for the latest iterate_transcript
 * tool result that carries a runtime-observatory TranscriptManifest. Prefers
 * the most recent one (reverse chronological). Order of preference:
 *   1. session.toolCalls[].result/.message wrapping the manifest;
 *   2. session.messages[].content (assistant tool-call blocks / strings).
 * Must work from the in-memory session stream because the client cannot read
 * `.iterate/transcript.json` off disk.
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForTranscript(session) {
  if (!session || typeof session !== 'object') return null

  const s = /** @type {Record<string, unknown>} */ (session)

  // Common pattern: session.toolCalls[].result / .message.
  const toolCalls = safeGet(s, 'toolCalls')
  if (Array.isArray(toolCalls)) {
    const calls = /** @type {Array<Record<string, unknown>>} */ (toolCalls)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (!call) continue
      const tool = String(safeGet(call, 'tool') ?? '')
      if (tool !== 'iterate_transcript' && !tool.endsWith('iterate_transcript')) continue
      const found = extractTranscript(safeGet(call, 'result')) ||
        extractTranscript(safeGet(call, 'message'))
      if (found) return found
    }
  }

  // Common pattern: assistant message content (tool-call blocks / strings).
  const messages = safeGet(s, 'messages')
  if (Array.isArray(messages)) {
    const msgs = /** @type {Array<Record<string, unknown>>} */ (messages)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      // Prefer the explicit tool-call surface first, then generic content.
      const calls = safeGet(msg, 'tool_calls')
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!call) continue
          const args = safeGet(call, 'arguments')
          if (typeof args === 'string') {
            const found = extractTranscript(args)
            if (found) return found
          }
        }
      }
      const found = extractTranscript(safeGet(msg, 'content'))
      if (found) return found
    }
  }

  return null
}

/**
 * Normalize a TranscriptManifest into a plain, JSON-safe object so rendering
 * never touches a live cordis proxy (which can throw on property reads). Every
 * optional/missing field degrades to a safe default; the input is never
 * mutated and unknown extra fields are dropped.
 *
 * @param {Record<string, unknown> | null | undefined} manifest
 * @returns {Record<string, unknown>}
 */
export function normalizeTranscript(manifest) {
  const src = manifest && typeof manifest === 'object'
    ? /** @type {Record<string, unknown>} */ (manifest)
    : {}
  const asNum = (v) => (typeof v === 'number' ? v : 0)
  const asStr = (v) => (typeof v === 'string' ? v : '')
  const asBool = (v) => v === true
  const asCount = (v) => (typeof v === 'number' ? v : 0)
  const asArray = (v) => (Array.isArray(v) ? /** @type {Array<Record<string, unknown>>} */ (v) : [])

  const rounds = asArray(safeGet(src, 'rounds')).map((r) => ({
    round: asNum(safeGet(r, 'round')),
    threads: asArray(safeGet(r, 'threads')).map((t) => ({
      dimension: asStr(safeGet(t, 'dimension')),
      attempt: asNum(safeGet(t, 'attempt')),
      messages: asArray(safeGet(t, 'messages')).map((m) => (typeof m === 'string' ? m : '')),
      readFiles: asArray(safeGet(t, 'readFiles')).map((f) => (typeof f === 'string' ? f : '')),
      findings: asArray(safeGet(t, 'findings')).map((f) => ({ ...f })),
    })),
  }))

  const cp = safeGet(src, 'checkpoint')
  const checkpoint = cp && typeof cp === 'object'
    ? {
        mode: asStr(safeGet(cp, 'mode')),
        round: asNum(safeGet(cp, 'round')),
        maxRounds: asNum(safeGet(cp, 'maxRounds')),
        fixedCount: asNum(safeGet(cp, 'fixedCount')),
        resumeCount: asNum(safeGet(cp, 'resumeCount')),
        updatedAt: asStr(safeGet(cp, 'updatedAt')),
      }
    : null

  const ng = safeGet(src, 'nudge')
  const nudge = ng && typeof ng === 'object'
    ? { timestamp: asStr(safeGet(ng, 'timestamp')), text: asStr(safeGet(ng, 'text')) }
    : null

  const ap = safeGet(src, 'approval')
  return {
    version: asNum(safeGet(src, 'version')),
    project: asStr(safeGet(src, 'project')),
    updatedAt: asStr(safeGet(src, 'updatedAt')),
    active: asBool(safeGet(src, 'active')),
    mode: asStr(safeGet(src, 'mode')) || null,
    goal: asStr(safeGet(src, 'goal')),
    phases: asArray(safeGet(src, 'phases')).map((p) => (typeof p === 'string' ? p : '')),
    round: asNum(safeGet(src, 'round')),
    maxRounds: asNum(safeGet(src, 'maxRounds')),
    rounds,
    convergence: asArray(safeGet(src, 'convergence')).map((n) => asCount(n)),
    findings: asArray(safeGet(src, 'findings')).map((f) => ({ ...f })),
    fixes: asArray(safeGet(src, 'fixes')).map((f) => ({ ...f })),
    live: asArray(safeGet(src, 'live')).map((e) => ({
      ts: typeof safeGet(e, 'ts') === 'number' ? String(safeGet(e, 'ts')) : asStr(safeGet(e, 'ts')),
      type: asStr(safeGet(e, 'type')),
      tool: asStr(safeGet(e, 'tool')),
      target: asStr(safeGet(e, 'target')),
    })),
    checkpoint,
    timeline: asArray(safeGet(src, 'timeline')).map((t) => ({ ...t })),
    nudge,
    approval: ap && typeof ap === 'object'
      ? { active: asBool(safeGet(ap, 'active')), policy: asStr(safeGet(ap, 'policy')) || 'ask' }
      : { active: false, policy: 'ask' },
  }
}

// ─── Run-summary / meta-review verdict detection ─────────────────────────────

/**
 * Check whether `obj` is an iterate dry-run run-summary object (the structured
 * object returned by the workflow at the end of a dry-run). It wraps the
 * ReviewReport and carries the meta-review verdict:
 *   { mode, goal, rounds, converged, ..., report, metaReview, finalReport }
 * The discriminator is `finalReport.verdict`, which only the meta-review
 * closing step produces ("approved" | "needs_revision"). This shape is distinct
 * from a ReviewReport (which has `convergence`/`findings`/`rounds`), so it never
 * collides with `isReviewReport`.
 *
 * @param {unknown} obj
 * @returns {obj is Record<string, unknown>}
 */
export function isRunSummary(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  const final = safeGet(o, 'finalReport')
  return !!final &&
    typeof final === 'object' &&
    (safeGet(final, 'verdict') === 'approved' || safeGet(final, 'verdict') === 'needs_revision')
}

/**
 * Deep-scan an object tree for the first iterate run-summary (same traversal
 * semantics as `findReportInObject`, with circular-reference + depth guards).
 *
 * @param {unknown} obj
 * @param {Set<unknown>} [seen]
 * @param {number} [maxDepth=20]
 * @returns {Record<string, unknown> | null}
 */
export function findRunSummaryInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null
  if (!obj || typeof obj !== 'object') return null

  const s = seen || new Set()
  if (s.has(obj)) return null
  s.add(obj)

  if (isRunSummary(obj)) return /** @type {Record<string, unknown>} */ (obj)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRunSummaryInObject(item, s, maxDepth - 1)
      if (found) return found
    }
    return null
  }

  const o = /** @type {Record<string, unknown>} */ (obj)
  for (const key of safeKeys(o)) {
    const val = safeGet(o, key)
    if (val && typeof val === 'object') {
      const found = findRunSummaryInObject(val, s, maxDepth - 1)
      if (found) return found
    }
  }

  return null
}

/**
 * Scan a session snapshot (or any object) for the latest iterate dry-run
 * run-summary that exposes a meta-review verdict. Prefers the most recent.
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForRunSummary(session) {
  if (!session || typeof session !== 'object') return null

  const s = /** @type {Record<string, unknown>} */ (session)

  // LATEST-first: walk chronological structures in reverse before the generic
  // deep find (which would return the FIRST match, i.e. the oldest run).
  // Common pattern: session.toolCalls[].result contains a run summary.
  const toolCalls = safeGet(s, 'toolCalls')
  if (Array.isArray(toolCalls)) {
    const calls = /** @type {Array<Record<string, unknown>>} */ (toolCalls)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (!call) continue
      if (safeGet(call, 'tool') === 'workflow' || String(safeGet(call, 'tool') ?? '').endsWith('workflow')) {
        const found = findRunSummaryInObject(safeGet(call, 'result'), undefined, 24)
        if (found) return found
      }
    }
  }

  // Common pattern: assistant message content holding the workflow return.
  const messages = safeGet(s, 'messages')
  if (Array.isArray(messages)) {
    const msgs = /** @type {Array<Record<string, unknown>>} */ (messages)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const found = findRunSummaryInObject(safeGet(msg, 'content'))
      if (found) return found
    }
  }

  return null
}

/**
 * Extract a compact, UI-friendly verdict from a run-summary object.
 * Returns null when the object is not a valid run-summary.
 *
 * @param {Record<string, unknown> | null | undefined} runSummary
 * @returns {{ verdict: 'approved' | 'needs_revision', reportIssues: number, checksRun: number, converged: boolean, totalRounds: number, totalFindings: number } | null}
 */
export function extractVerdict(runSummary) {
  if (!isRunSummary(runSummary)) return null
  const o = /** @type {Record<string, unknown>} */ (runSummary)
  const final = /** @type {Record<string, unknown>} */ (safeGet(o, 'finalReport'))
  const meta = safeGet(final, 'metaReview') && typeof safeGet(final, 'metaReview') === 'object'
    ? /** @type {Record<string, unknown>} */ (safeGet(final, 'metaReview'))
    : {}
  const issues = Array.isArray(safeGet(meta, 'issues')) ? safeGet(meta, 'issues') : []
  // `totalRounds` may be a bare number (dry-run returns `rounds`) or a count.
  const roundsVal = safeGet(o, 'rounds')
  const totalRounds = typeof roundsVal === 'number' ? roundsVal : (Array.isArray(roundsVal) ? roundsVal.length : 0)
  return {
    verdict: safeGet(final, 'verdict') === 'needs_revision' ? 'needs_revision' : 'approved',
    reportIssues: issues.length,
    checksRun: typeof safeGet(meta, 'checksRun') === 'number' ? safeGet(meta, 'checksRun') : 0,
    converged: safeGet(o, 'converged') === true,
    totalRounds,
    totalFindings: typeof safeGet(o, 'totalFindings') === 'number' ? safeGet(o, 'totalFindings') : 0,
  }
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
  // summary (or any other field) is never mutated. `fixedCount` (normal mode
  // only) is carried through so the dashboard fix-count metric survives
  // normalization.
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
      ...(typeof s.fixedCount === 'number' ? { fixedCount: s.fixedCount } : {}),
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
  const findings = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? [])
  // FNV-1a over EVERY finding (file|line|dimension|summary) so two different
  // reports never share a verdict store, while re-running the identical review
  // restores the same verdicts.
  let h = 0x811c9dc5
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  mix(`${String(report.mode ?? '')}|`)
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    mix(`${String(f.file ?? '')}|${typeof f.line === 'number' ? f.line : 0}|${String(f.dimension ?? '')}|${String(f.summary ?? '')}\n`)
  }
  return `iterate-triage-${h.toString(36)}`
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

// ─── Select-all keys ────────────────────────────────────────────────────────

/**
 * Every finding index in a triage state, sorted ascending.
 * Used by the select-all toggle so batch operations can target ALL findings
 * (not just the currently visible/filtered ones).
 *
 * @param {Record<string, 'keep' | 'skip' | 'ignore'> | null | undefined} triageState
 * @returns {number[]}
 */
export function allVerdictKeys(triageState) {
  const state = triageState && typeof triageState === 'object' ? triageState : {}
  return Object.keys(state)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
}

// ─── Runtime status guide ────────────────────────────────────────────────────

/**
 * Runtime artifacts produced under `<projectRoot>/.iterate/`.
 * @type {Array<{ key: string, label: string, hint: string }>}
 */
export const RUNTIME_ARTIFACTS = [
  {
    key: 'decision-log.jsonl',
    label: '决策日志',
    hint: '追加式 JSONL，记录每轮 plan / review / fix / revert / validation 决策',
  },
  {
    key: 'checkpoint.json',
    label: '迭代断点',
    hint: '长迭代的进度快照，中断后可恢复（iterate_checkpoint）',
  },
  {
    key: 'fixes/registry.json',
    label: '修复注册表',
    hint: '每个原子修复的 id / diff / 备份路径（iterate_fix / iterate_diff）',
  },
  {
    key: 'fixes/*.bak',
    label: '修复备份',
    hint: '每次修复前的原文件备份，回滚依赖（iterate_rollback）',
  },
]

/**
 * Copy-paste guide for inspecting / pruning the runtime state. Shown in the
 * settings "状态概览" card so the user knows exactly where artifacts live and
 * which tools inspect them.
 *
 * @returns {string}
 */
export function buildRuntimeStatusGuide() {
  const lines = [
    'iterate 运行时状态概览',
    '----------------------',
    '所有运行时产物位于项目根目录 .iterate/ 下：',
    '',
    ...RUNTIME_ARTIFACTS.map((a) => `- ${a.key}（${a.label}）：${a.hint}`),
    '',
    '查看状态：让模型调用 iterate_status（汇总）或 iterate_history（明细）。',
    '清理状态：让模型调用 iterate_prune（默认 dry-run，只报告不删除，显式 dryRun:false 才真正清理）。',
  ]
  return lines.join('\n')
}

// ─── Runtime-observatory UI pure helpers ─────────────────────────────────────

/**
 * Filter the live reviewer-activity feed by activity type. An empty/unknown
 * `type` matches everything; entries are returned in their original (newest
 * first) order. Purely defensive: non-array input yields [].
 *
 * @param {unknown} entries
 * @param {unknown} type
 * @returns {Array<Record<string, unknown>>}
 */
export function filterLiveEntries(entries, type) {
  const list = Array.isArray(entries) ? entries : []
  const t = typeof type === 'string' ? type.trim() : ''
  if (!t) return list.slice()
  return list.filter((e) => e && typeof e === 'object' && String(e.type ?? '') === t)
}

/**
 * Filter decision-timeline entries by type / round / free-text search, then
 * sort newest first by timestamp string (timeline entries are not guaranteed
 * to be reverse-ordered in the manifest).
 *
 * - `type`: exact `entry.type` match when non-empty.
 * - `round`: exact `entry.round` string match when non-empty.
 * - `search`: case-insensitive substring over type + round + JSON data.
 *
 * @param {unknown} entries
 * @param {{ type?: unknown, round?: unknown, search?: unknown } | null | undefined} opts
 * @returns {Array<Record<string, unknown>>}
 */
export function filterTimelineEntries(entries, opts) {
  const list = Array.isArray(entries) ? entries : []
  const o = opts && typeof opts === 'object' ? opts : {}
  const type = typeof o.type === 'string' ? o.type : ''
  const round = typeof o.round === 'string' ? o.round : ''
  const q = typeof o.search === 'string' ? o.search.trim().toLowerCase() : ''
  const filtered = list.filter((t) => {
    if (!t || typeof t !== 'object') return false
    if (type && String(t.type ?? '') !== type) return false
    if (round && String(t.round ?? '') !== round) return false
    if (q) {
      const hay = [String(t.type ?? ''), String(t.round ?? ''), JSON.stringify(t.data ?? {})].join(' ').toLowerCase()
      if (hay.indexOf(q) < 0) return false
    }
    return true
  })
  return filtered
    .slice()
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
}

/**
 * Serialize the full observatory state (manifest + live feed) into a JSON
 * string the client can copy/export. Always includes an `exportedAt` stamp and
 * guards against non-serializable / oversized payloads by falling back to the
 * manifest only.
 *
 * @param {unknown} manifest
 * @param {unknown} live
 * @returns {string}
 */
export function serializeObservatoryExport(manifest, live) {
  const payload = {
    exportedAt: new Date().toISOString(),
    manifest: manifest && typeof manifest === 'object' ? manifest : null,
    live: Array.isArray(live) ? live : [],
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    // A cyclic / non-serializable manifest must not crash the copy action.
    return JSON.stringify({ exportedAt: payload.exportedAt, manifest: null, live: [] }, null, 2)
  }
}

/**
 * Latest non-empty workflow phase name (plan / review / fix / validate /
 * report …) from the transcript manifest's phase list. The last recorded
 * phase is the one the run is currently in (or last finished).
 *
 * @param {unknown} phases
 * @returns {string}
 */
export function latestPhase(phases) {
  const list = Array.isArray(phases) ? phases : []
  let latest = ''
  for (const p of list) {
    if (typeof p === 'string' && p.trim()) latest = p.trim()
  }
  return latest
}