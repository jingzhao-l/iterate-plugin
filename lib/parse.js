/**
 * lib/parse.js — Pure logic for iterate client UI.
 *
 * Framework-agnostic, DOM-free, single-file, testable with Node.js assert.
 * Every scan / normalize / compute helper is exported for unit test coverage;
 * only micro plumbing stays module-private (the safeGet/safeKeys proxy-safe
 * readers, the guarded JSON string coercion, and the three one-line predicate
 * wrappers over findFirstInObject), each exercised through its caller.
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

/**
 * Coerce a possibly STRING-encoded node (tool results and message contents
 * arrive as raw JSON text) into its parsed object/array form. Only strings
 * whose trimmed body starts with `{` or `[` are parsed, so plain
 * conversational text is never fed to JSON.parse; unparseable text passes
 * through untouched and the caller decides what a still-raw string means.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
function coerceJsonNode(v) {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
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
  const consumed = new Set()
  let count = 0

  /** @param {unknown} obj */
  const walk = (obj, depth) => {
    if (depth <= 0 || !obj || typeof obj !== 'object') return
    if (seen.has(obj) || consumed.has(obj)) return
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
      // The ref node is already counted; mark it consumed so descending into it
      // (its own mediaType/attachmentId keys) does not double-count the image.
      consumed.add(ref)
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
        // Results may arrive as STRING-encoded JSON (arbitrary session text).
        const result = coerceJsonNode(safeGet(call, 'result'))
        if (result && typeof result === 'object') {
          const r = /** @type {Record<string, unknown>} */ (result)
          const report = safeGet(r, 'report')
          // Only a VALIDATED report wins here: a junk `result.report` must
          // neither reach normalizeReport nor shadow a real report nested
          // deeper in the same result (or an older, valid call).
          if (isReviewReport(report)) return report
          const found = findReportInObject(result)
          if (found) return found
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
      // Reverse: within a single assistant message the LAST tool call is the
      // most recent one — two parallel iterate_review results must resolve to
      // the newer report, not the older ("Prefers the most recent one").
      for (let j = calls.length - 1; j >= 0; j--) {
        const call = calls[j]
        if (!call) continue
        // Result surface (same shape the quality-gate / defense scanners read):
        // `{ name|tool, result }` message tool calls. Without this branch a
        // report carried on `tool_calls[].result` was only reachable through
        // the generic content fallback, so the dashboard could stay empty
        // while F8–F10 filled from the very same message.
        const callName = String(safeGet(call, 'name') ?? safeGet(call, 'tool') ?? '')
        if (callName === 'iterate_review' || callName.endsWith('iterate_review')) {
          for (const key of ['result', 'response', 'message']) {
            const node = coerceJsonNode(safeGet(call, key))
            if (!node || typeof node !== 'object') continue
            const r = /** @type {Record<string, unknown>} */ (node)
            const report = safeGet(r, 'report')
            if (isReviewReport(report)) return report
            const found = findReportInObject(node)
            if (found) return found
          }
        }
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
export function attachLive(manifest, source) {
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
 * @param {Set<unknown>} [seen]
 * @param {number} [depth]
 * @returns {Record<string, unknown> | null}
 */
export function extractTranscript(obj, seen, depth) {
  if (depth === undefined) depth = 0
  if (depth > 20) return null
  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj)
      return extractTranscript(parsed, seen, depth + 1)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object') return null
  if (!seen) seen = new Set()
  if (seen.has(obj)) return null
  seen.add(obj)

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
          const found = extractTranscript(item, seen, depth + 1)
          if (found) return attachLive(found, o)
        }
      } else {
        const found = extractTranscript(val, seen, depth + 1)
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
        // Reverse: the last tool call in one message is the most recent —
        // two parallel iterate_transcript results must resolve to the newer
        // manifest ("Prefers the most recent one").
        const callList = /** @type {Array<Record<string, unknown>>} */ (calls)
        for (let j = callList.length - 1; j >= 0; j--) {
          const call = callList[j]
          if (!call) continue
          // OpenAI-style calls nest the payload under `function.arguments`
          // (a JSON string) — the shape scanSessionForReport already reads.
          // Missing it here meant a manifest echoed only in that surface was
          // invisible to the observatory (F1–F7 stayed empty).
          const fn = safeGet(call, 'function')
          const candidates = [
            // Result surface first: `{ name|tool, result }` message tool calls
            // (the same shape scanSessionForQualityGate already accepts).
            safeGet(call, 'result'),
            safeGet(call, 'response'),
            safeGet(call, 'message'),
            safeGet(call, 'arguments'),
            fn && typeof fn === 'object' ? safeGet(/** @type {Record<string, unknown>} */ (fn), 'arguments') : undefined,
          ]
          for (const args of candidates) {
            if (args === undefined || args === null) continue
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
 * Normalize the `validations` array the transcript capture carries (contract:
 * `{round, command, exitCode, allowed, rejectReason?}` — one row per
 * validation command run in a round). Defensive like every other normalizer:
 * junk rows are dropped, missing fields degrade to safe defaults, and the
 * input is never mutated.
 *
 * @param {unknown} raw
 * @returns {Array<{ round: number, command: string, exitCode: number | null, allowed: boolean, rejectReason?: string }>}
 */
export function normalizeValidations(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const v of /** @type {unknown[]} */ (raw)) {
    if (!v || typeof v !== 'object') continue
    const rec = /** @type {Record<string, unknown>} */ (v)
    const roundRaw = Number(rec.round)
    const exitRaw = rec.exitCode
    const command = typeof rec.command === 'string' ? rec.command : String(rec.command ?? '')
    if (!command) continue
    const rejectReason = typeof rec.rejectReason === 'string' ? rec.rejectReason : ''
    out.push({
      round: Number.isFinite(roundRaw) && roundRaw > 0 ? Math.floor(roundRaw) : 0,
      command,
      exitCode: typeof exitRaw === 'number' && Number.isFinite(exitRaw) ? exitRaw : null,
      allowed: rec.allowed === true,
      ...(rejectReason ? { rejectReason } : {}),
    })
  }
  return out
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
  const tm = safeGet(src, 'taskMode')
  return {
    version: asNum(safeGet(src, 'version')),
    project: asStr(safeGet(src, 'project')),
    updatedAt: asStr(safeGet(src, 'updatedAt')),
    active: asBool(safeGet(src, 'active')),
    mode: asStr(safeGet(src, 'mode')) || null,
    // v3.0: harness task_mode (code/iterate), tolerated when absent.
    taskMode: tm === 'code' || tm === 'iterate' ? tm : null,
    goal: asStr(safeGet(src, 'goal')),
    phases: asArray(safeGet(src, 'phases')).map((p) => (typeof p === 'string' ? p : '')),
    round: asNum(safeGet(src, 'round')),
    maxRounds: asNum(safeGet(src, 'maxRounds')),
    // v3.5: why a FINISHED run stopped (converged / max_rounds_reached /
    // aborted_by_validation / aborted_by_config). Required for the
    // observatory badge to render the stop reason instead of a bare "已结束".
    stoppedReason: src.stoppedReason === null || src.stoppedReason === undefined
      ? null
      : asStr(safeGet(src, 'stoppedReason')) || null,
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
    // #6: per-round validation rows (command / exitCode / allowed), captured
    // by the workflow and persisted through `iterate_transcript capture`.
    validations: normalizeValidations(safeGet(src, 'validations')),
    nudge,
    approval: ap && typeof ap === 'object'
      ? { active: asBool(safeGet(ap, 'active')), policy: asStr(safeGet(ap, 'policy')) || 'ask' }
      : { active: false, policy: 'ask' },
  }
}

// ─── Quality command center session scans (v3.1+) ───────────────────────────
//
// The F8/F9/F10 observatory tabs render machine-readable data that the model
// already surfaces through `iterate_quality_gate` / `iterate_experience` /
// `iterate_defense_events`. Because the client cannot call harness tools, these
// scanners recover the LATEST result of each tool from the in-memory session
// stream (same reverse-chronological strategy as scanSessionForTranscript) and
// normalize it into a JSON-safe shape for rendering. Every field degrades to a
// safe default so a partial/malformed result never crashes the slot.

const DEFENSE_EVENT_TYPES = ['precondition_failed', 'rollback', 'invariant_violated', 'assumption_falsified']

/**
 * Check whether `obj` is a QualityGateSnapshot as produced by quality-store.ts.
 * Requires the three gate discriminators (overallStatus + overallScore +
 * dimensions array) so unrelated `{ snapshot: ... }` shapes never collide.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isQualityGateSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  const status = safeGet(o, 'overallStatus')
  return (
    (status === 'pass' || status === 'fail' || status === 'pending') &&
    typeof safeGet(o, 'overallScore') === 'number' &&
    Array.isArray(safeGet(o, 'dimensions'))
  )
}

/**
 * Check whether `obj` is an `iterate_experience` result node. `list`/`search`
 * carry an `entries` array; `get`/`add` carry a single `entry` object. Either
 * shape is enough to render the F9 experience bank.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isExperienceBankResult(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  const entry = safeGet(o, 'entry')
  return (
    (Array.isArray(safeGet(o, 'entries')) && typeof safeGet(o, 'count') === 'number') ||
    (!!entry && typeof entry === 'object' && typeof safeGet(o, 'operation') === 'string')
  )
}

/**
 * Check whether `obj` is an `iterate_defense_events` result node. `list` carries
 * an `events` array, `counts` / `record` carry a `counts` map. Either shape is
 * enough to render the F10 defense event stream.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isDefenseEventsResult(obj) {
  if (!obj || typeof obj !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (obj)
  const counts = safeGet(o, 'counts')
  return (
    (Array.isArray(safeGet(o, 'events')) && typeof safeGet(o, 'count') === 'number') ||
    (!!counts && typeof counts === 'object' && typeof safeGet(o, 'operation') === 'string')
  )
}

/**
 * Shared deep-find: first node in `obj` (circular + depth guarded) satisfying a
 * predicate, with the same traversal semantics as findReportInObject. String
 * nodes are parsed when they carry a JSON payload (`{...}` / `[...]`), so
 * STRING-encoded tool results / message contents are as visible to the
 * scanSessionFor* scanners as object nodes.
 *
 * @param {unknown} obj
 * @param {(o: Record<string, unknown>) => boolean} predicate
 * @param {Set<unknown>} [seen]
 * @param {number} [maxDepth=20]
 * @returns {Record<string, unknown> | null}
 */
export function findFirstInObject(obj, predicate, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null
  // Guarded JSON.parse for string nodes; a plain / unparseable string has
  // nothing to scan. Keeps the same depth (one hop per parse) and seen guards.
  if (typeof obj === 'string') {
    const parsed = coerceJsonNode(obj)
    if (parsed === obj) return null // not (parseable) JSON text
    return findFirstInObject(parsed, predicate, seen, maxDepth - 1)
  }
  if (!obj || typeof obj !== 'object') return null

  const s = seen || new Set()
  if (s.has(obj)) return null
  s.add(obj)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstInObject(item, predicate, s, maxDepth - 1)
      if (found) return found
    }
    return null
  }

  if (typeof obj === 'object') {
    const o = /** @type {Record<string, unknown>} */ (obj)
    if (predicate(o)) return o
    for (const key of safeKeys(o)) {
      const val = safeGet(o, key)
      if (val && typeof val === 'object') {
        const found = findFirstInObject(val, predicate, s, maxDepth - 1)
        if (found) return found
      }
    }
  }
  return null
}

/** Deep-find the first QualityGateSnapshot inside `obj`. */
function findQualityGateInObject(obj) {
  return findFirstInObject(obj, (o) => isQualityGateSnapshot(o))
}

/** Deep-find the first `iterate_experience` result node inside `obj`. */
function findExperienceResultInObject(obj) {
  return findFirstInObject(obj, (o) => isExperienceBankResult(o))
}

/** Deep-find the first `iterate_defense_events` result node inside `obj`. */
function findDefenseResultInObject(obj) {
  return findFirstInObject(obj, (o) => isDefenseEventsResult(o))
}

/**
 * Return the raw result/message node of the most recent execution of `toolName`
 * in a session snapshot whose subtree actually contains a match for `find`.
 * Scans `session.toolCalls` (reverse chronological, matching the harness's
 * in-memory stream shape), then `session.messages[].tool_calls` (assistant
 * tool-call blocks), then falls back to `session.messages[].content` — the
 * content fallback loops newest→oldest and only accepts a message whose
 * content embeds a match, so a conversational closing message can never
 * shadow an earlier message's embedded result. A junk LATEST result is
 * skipped (an older valid one still surfaces) because `find` gates every
 * candidate. Returns the raw node (object or string) or null.
 *
 * @param {unknown} session
 * @param {string} toolName
 * @param {(node: unknown) => Record<string, unknown> | null} find deep-find
 *   predicate identifying a usable match inside a candidate node
 * @returns {unknown}
 */
export function latestToolResultNode(session, toolName, find) {
  if (!session || typeof session !== 'object') return null

  const s = /** @type {Record<string, unknown>} */ (session)

  const toolCalls = safeGet(s, 'toolCalls')
  if (Array.isArray(toolCalls)) {
    const calls = /** @type {Array<Record<string, unknown>>} */ (toolCalls)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (!call) continue
      const tool = String(safeGet(call, 'tool') ?? '')
      if (tool !== toolName && !tool.endsWith(toolName)) continue
      const result = safeGet(call, 'result')
      if (result !== undefined && result !== null && find(result)) return result
      const message = safeGet(call, 'message')
      if (message !== undefined && message !== null && find(message)) return message
    }
  }

  const messages = safeGet(s, 'messages')
  if (Array.isArray(messages)) {
    const msgs = /** @type {Array<Record<string, unknown>>} */ (messages)
    // Assistant tool-call variant: the tool result may live on the call object
    // inside message.tool_calls rather than on session.toolCalls. Scan every
    // message for a matching call (newest-first) before falling back to the
    // raw contents — a conversational closing message must not shadow an
    // earlier message's real tool result.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const calls = safeGet(msg, 'tool_calls')
      if (!Array.isArray(calls)) continue
      const callList = /** @type {Array<Record<string, unknown>>} */ (calls)
      for (let j = callList.length - 1; j >= 0; j--) {
        const call = callList[j]
        if (!call) continue
        const name = String(safeGet(call, 'name') ?? safeGet(call, 'tool') ?? '')
        if (name !== toolName && !name.endsWith(toolName)) continue
        const result = safeGet(call, 'result') ?? safeGet(call, 'response') ?? safeGet(call, 'message')
        if (result !== undefined && result !== null && find(result)) return result
        // `function.arguments` is deliberately NOT consulted here: it holds the
        // CALL INPUT, and rendering an input as a stored result would show an
        // `iterate_experience add` payload as if it were bank content. Inputs
        // are not results — only result/response/message surfaces count.
      }
    }
    // Content fallback: loop messages newest→oldest and return the first
    // content whose subtree actually embeds a match (the deep-scan finders
    // see inside STRING-encoded JSON payloads too). An unmatched newest
    // message must not shadow an older message's embedded result.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const content = safeGet(msg, 'content')
      if (content === undefined || content === null) continue
      if (find(content)) return content
    }
  }

  return null
}

/**
 * Normalize a QualityGateSnapshot into a JSON-safe object (see
 * normalizeTranscript for the defensive style contract).
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeQualityGateSnapshot(raw) {
  const src = raw && typeof raw === 'object'
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const asStr = (v) => (typeof v === 'string' ? v : '')
  const status = safeGet(src, 'overallStatus')
  const dims = Array.isArray(safeGet(src, 'dimensions')) ? safeGet(src, 'dimensions') : []
  return {
    timestamp: asStr(safeGet(src, 'timestamp')),
    overallStatus: status === 'pass' || status === 'fail' || status === 'pending' ? status : 'pending',
    overallScore: asNum(safeGet(src, 'overallScore')),
    verificationPassRate: asNum(safeGet(src, 'verificationPassRate')),
    totalChecks: asNum(safeGet(src, 'totalChecks')),
    passedChecks: asNum(safeGet(src, 'passedChecks')),
    failedChecks: asNum(safeGet(src, 'failedChecks')),
    failReason: asStr(safeGet(src, 'failReason')) || null,
    totalFindings: asNum(safeGet(src, 'totalFindings')),
    criticalCount: asNum(safeGet(src, 'criticalCount')),
    highCount: asNum(safeGet(src, 'highCount')),
    mediumCount: asNum(safeGet(src, 'mediumCount')),
    lowCount: asNum(safeGet(src, 'lowCount')),
    dimensions: (/** @type {unknown[]} */ (dims)).map((d) => {
      const rec = /** @type {Record<string, unknown>} */ (d && typeof d === 'object' ? d : {})
      const dimStatus = safeGet(rec, 'status')
      return {
        dimension: asStr(safeGet(rec, 'dimension')),
        convergenceRate: asNum(safeGet(rec, 'convergenceRate')),
        findingsCount: asNum(safeGet(rec, 'findingsCount')),
        fixedCount: asNum(safeGet(rec, 'fixedCount')),
        score: asNum(safeGet(rec, 'score')),
        status: dimStatus === 'pass' || dimStatus === 'warn' || dimStatus === 'fail' ? dimStatus : 'warn',
      }
    }),
  }
}

/**
 * Scan a session snapshot for the latest `iterate_quality_gate` result and
 * return its normalized QualityGateSnapshot (or null).
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForQualityGate(session) {
  const node = latestToolResultNode(session, 'iterate_quality_gate', findQualityGateInObject)
  if (node === null) return null
  const found = findQualityGateInObject(node)
  if (!found) return null
  return normalizeQualityGateSnapshot(found)
}

/**
 * Normalize an `iterate_experience` result node into a JSON-safe object.
 * `get`/`add` results (single `entry`) are folded into the `entries` array so
 * the F9 panel has one rendering path regardless of operation.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeExperienceBankResult(raw) {
  const src = raw && typeof raw === 'object'
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const asStr = (v) => (typeof v === 'string' ? v : '')
  const asArr = (v) => (Array.isArray(v) ? /** @type {unknown[]} */ (v) : [])
  const entry = safeGet(src, 'entry')
  const rawEntries = Array.isArray(safeGet(src, 'entries'))
    ? /** @type {unknown[]} */ (safeGet(src, 'entries'))
    : (entry && typeof entry === 'object' ? [entry] : [])
  return {
    operation: asStr(safeGet(src, 'operation')),
    count: asNum(safeGet(src, 'count')),
    totalHits: asNum(safeGet(src, 'totalHits')),
    added: safeGet(src, 'added') === true,
    entries: rawEntries.map((e) => {
      const rec = /** @type {Record<string, unknown>} */ (e && typeof e === 'object' ? e : {})
      return {
        id: asStr(safeGet(rec, 'id')),
        timestamp: asStr(safeGet(rec, 'timestamp')),
        dimension: asStr(safeGet(rec, 'dimension')),
        pattern: asStr(safeGet(rec, 'pattern')),
        description: asStr(safeGet(rec, 'description')),
        verifiedFix: asStr(safeGet(rec, 'verifiedFix')),
        findingSummary: asStr(safeGet(rec, 'findingSummary')),
        severity: asStr(safeGet(rec, 'severity')),
        hitCount: asNum(safeGet(rec, 'hitCount')),
        lastHitAt: asStr(safeGet(rec, 'lastHitAt')) || null,
        files: asArr(safeGet(rec, 'files')).map((f) => (typeof f === 'string' ? f : '')),
        tags: asArr(safeGet(rec, 'tags')).map((t) => (typeof t === 'string' ? t : '')),
      }
    }),
  }
}

/**
 * Scan a session snapshot for the latest `iterate_experience` result and return
 * its normalized values (or null when the session has none).
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForExperienceBank(session) {
  const node = latestToolResultNode(session, 'iterate_experience', findExperienceResultInObject)
  if (node === null) return null
  const found = findExperienceResultInObject(node)
  if (!found) return null
  return normalizeExperienceBankResult(found)
}

/**
 * Normalize an `iterate_defense_events` result node into a JSON-safe object.
 * `record` results (single `event` + `counts`) fold into the same shape as
 * `list`/`counts` so the F10 panel has one rendering path.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeDefenseEventsResult(raw) {
  const src = raw && typeof raw === 'object'
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const asStr = (v) => (typeof v === 'string' ? v : '')
  const countsRaw = safeGet(src, 'counts') && typeof safeGet(src, 'counts') === 'object'
    ? /** @type {Record<string, unknown>} */ (safeGet(src, 'counts'))
    : {}
  const counts = /** @type {Record<string, number>} */ ({})
  for (const type of DEFENSE_EVENT_TYPES) {
    const n = safeGet(countsRaw, type)
    counts[type] = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  }
  const event = safeGet(src, 'event')
  const rawEvents = Array.isArray(safeGet(src, 'events'))
    ? /** @type {unknown[]} */ (safeGet(src, 'events'))
    : (event && typeof event === 'object' ? [event] : [])
  return {
    operation: asStr(safeGet(src, 'operation')),
    count: asNum(safeGet(src, 'count')),
    language: asStr(safeGet(src, 'language')),
    counts,
    events: rawEvents.map((e) => {
      const rec = /** @type {Record<string, unknown>} */ (e && typeof e === 'object' ? e : {})
      return {
        id: asStr(safeGet(rec, 'id')),
        timestamp: asStr(safeGet(rec, 'timestamp')),
        round: asNum(safeGet(rec, 'round')),
        type: asStr(safeGet(rec, 'type')),
        description: asStr(safeGet(rec, 'description')),
        defense: asStr(safeGet(rec, 'defense')),
        outcome: asStr(safeGet(rec, 'outcome')),
        file: asStr(safeGet(rec, 'file')) || null,
        line: asNum(safeGet(rec, 'line')) || null,
        severity: asStr(safeGet(rec, 'severity')),
      }
    }),
  }
}

/**
 * Scan a session snapshot for the latest `iterate_defense_events` result and
 * return its normalized values (or null when the session has none).
 *
 * @param {unknown} session
 * @returns {Record<string, unknown> | null}
 */
export function scanSessionForDefenseEvents(session) {
  const node = latestToolResultNode(session, 'iterate_defense_events', findDefenseResultInObject)
  if (node === null) return null
  const found = findDefenseResultInObject(node)
  if (!found) return null
  return normalizeDefenseEventsResult(found)
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
  // Session/model text is arbitrary: `findings` / `rounds` may arrive as a
  // NON-ARRAY junk value ({} / string / number) — coerce at every ingestion
  // point so downstream map/iteration never throws `... is not iterable`.
  const convergence = /** @type {Record<string, unknown>} */ (report.convergence ?? {})
  const rounds = /** @type {Array<unknown>} */ (Array.isArray(report.rounds) ? report.rounds : [])
  const findings = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(report.findings) ? report.findings : [])

  // Normalize convergence
  const totalRounds =
    typeof convergence.totalRounds === 'number'
      ? convergence.totalRounds
      : rounds.length

  // Why the run stopped: an explicit harness-provided reason always wins;
  // the derived fallback may only be stamped when the run is actually
  // FINISHED (flagged converged, or every budgeted round executed). An
  // in-progress run (rounds < totalRounds, not converged) must stay null —
  // stamping 'converged' mid-run would render a false finished badge.
  const explicitReason =
    typeof convergence.stoppedReason === 'string' && convergence.stoppedReason.trim()
      ? convergence.stoppedReason
      : null

  const normalizedConvergence = {
    totalRounds,
    findingsByRound: Array.isArray(convergence.findingsByRound)
      ? convergence.findingsByRound
      : rounds.map((r) => {
          const rr = /** @type {Record<string, unknown>} */ (r)
          return Array.isArray(rr?.findings) ? rr.findings.length : 0
        }),
    converged: convergence.converged === true,
    stoppedReason: explicitReason ??
      (convergence.converged === true
        ? 'converged'
        : rounds.length >= totalRounds
          ? 'max_rounds_reached'
          : null),
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
  // Coerce: a junk (non-array) findings value must degrade to "no findings",
  // not throw `... is not iterable` during React render.
  const list = Array.isArray(findings) ? findings : []
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  // NULL-PROTOTYPE map: `dimension` comes from arbitrary review/model text, so
  // a finding tagged `__proto__` / `constructor` / `toString` must count as an
  // ordinary bucket instead of reading (or assigning through) the prototype
  // chain. `{} ` would make `byDimension['__proto__'] ?? 0` return
  // Object.prototype and produce garbage counts — mirrors review.ts, which
  // already creates its summary map with Object.create(null).
  /** @type {Record<string, number>} */
  const byDimension = Object.create(null)

  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    const sev = String(f.severity ?? 'low')
    // OWN-property check: `'__proto__' in counts` is true via the prototype
    // chain, which would corrupt the tally with a non-number.
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev]++
    const dim = String(f.dimension ?? 'unknown')
    byDimension[dim] = (byDimension[dim] ?? 0) + 1
  }

  return {
    totalFindings: list.length,
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
  const currentRounds = currentRoundNumber(report)
  // Guard against an empty report (totalRounds <= 0) producing NaN.
  if (!(totalRounds > 0)) return 0
  return Math.min(100, Math.round((currentRounds / totalRounds) * 100))
}

/**
 * The actual current round (1-indexed) carried by a report. Uses the highest
 * per-round `round` field: a normal-mode aggregate ships ONLY the live round
 * (`rounds: [{round: r, ...}]`), so `rounds.length` would be stuck at 1 while
 * the run is on round 3. Dry-run aggregates ship the cumulative list, where
 * the round numbers and the array length agree anyway.
 *
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function currentRoundNumber(report) {
  // Coerce: `rounds` may be a non-array junk value in arbitrary session text —
  // `for...of {}` would throw `... is not iterable`.
  const rounds = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(report.rounds) ? report.rounds : [])
  let max = 0
  for (const r of rounds) {
    if (!r || typeof r !== 'object') continue
    const n = Number(r.round)
    if (Number.isFinite(n) && n > max) max = n
  }
  // Fallback: no usable round numbers → array length (covers all-0 rounds).
  return rounds.length > 0 && max === 0 ? rounds.length : max
}

/**
 * Get the current round number (1-indexed) from a report.
 *
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function getCurrentRound(report) {
  return currentRoundNumber(report)
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
  // Coerce at the ingestion point: non-array `findings` degrades to [].
  const findings = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(report.findings) ? report.findings : [])
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    const sev = String(f.severity ?? 'low')
    // OWN-property check: a junk severity of `__proto__`/`constructor` is not
    // a bucket and must not read through the prototype chain (`counts[sev]++`
    // would turn into NaN and try to reassign the prototype).
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev]++
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
  // Coerce at the ingestion point: non-array `findings` degrades to [].
  const findings = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(report.findings) ? report.findings : [])
  // NULL-PROTOTYPE buckets: `dimension` is arbitrary model text, so
  // `__proto__` would otherwise resolve to Object.prototype (truthy → skip the
  // bucket assignment) and crash on `.push` — or worse, mutate the prototype.
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const groups = Object.create(null)
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    const dim = String(f.dimension ?? 'unknown')
    if (!Object.prototype.hasOwnProperty.call(groups, dim)) groups[dim] = []
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
  // Coerce: non-array `findings` ({} / string) must not fabricate keys.
  const findings = /** @type {Array<unknown>} */ (Array.isArray(report.findings) ? report.findings : [])
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
  // Coerce: non-array `findings` degrades to [] instead of throwing on the
  // `for...of` below.
  const findings = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(report.findings) ? report.findings : [])
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
    `请调用 \`iterate_triage\` 应用下面的 known_intentional 条目（粘贴后由模型调用 ` +
    `\`iterate_triage\` 的 \`operation: "apply"\` 写入配置：自动去重、写入前备份、失败自动回滚）：\n\n` +
    `\`\`\`json\n${payload}\n\`\`\`\n\n` +
    `写入完成后请复制面板的「回读已写入条目」指令（\`iterate_triage\` \`operation: "list"\`）核对结果。`
  )
}

/**
 * Copy-back instruction for the triage write-back loop: after an `apply`, the
 * user needs the stored entries echoed back so the panel's "待写回" count has a
 * confirmation step (copy → apply → read back).
 *
 * @returns {string}
 */
export function buildTriageReadbackInstruction() {
  return (
    '请调用 `iterate_triage` 回读当前已写入配置的 known_intentional 条目，' +
    '并把每条的 file / line / dimension / reason 原样列出来供我核对：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'list' }, null, 2)}\n` +
    '```'
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
  // Coerce: a non-array findings value must never index string characters.
  const list = Array.isArray(findings) ? findings : []
  const entries = []
  for (const [idx, verdict] of Object.entries(triageState)) {
    if (verdict !== 'ignore') continue
    const finding = list[Number(idx)]
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

// ─── Paste-able instruction payloads (copy-to-command contract) ─────────────
//
// The browser client cannot call harness tools, so every action button copies
// a text the user pastes back into the session. These builders are the SINGLE
// source of truth for those payloads (src/client/index.ts imports them), and
// every payload is written against the real parameter schema declared in
// src/tools/*.ts so test/parse.test.ts can assert field alignment.

/** Placeholder the model must replace with the NEW full file content. */
const CONTENT_PLACEHOLDER = '<由模型填写：修复后的完整文件内容>'
/** Placeholder the model must replace with the current iteration round. */
const ROUND_PLACEHOLDER = '<由模型填写：当前迭代轮次（≥1 的整数）>'

/**
 * Startup instructions copied by the empty-dashboard CTA.
 *
 * dsh exposes NO command / slash-command registration surface to plugins: the
 * cordis Context services are `tools`, `systemPrompt`, `sessions`, `jobs`,
 * `agents`, `llm`, `sandbox`, `sandboxPolicy`, `approval`, `sessionProjections`
 * and `ptcRuntime` — there is no `ctx.command` / prompt-command registry, and
 * `cordis.patch.yml` only inserts the bundle. So `/iterate` never existed as a
 * command; the CTA instead copies natural-language instructions that the model
 * resolves through the `workflow` tool exactly as the skill prompt teaches
 * ("When the user asks to review or iterate on the project … run an iterate
 * workflow by calling the `workflow` tool", mode normal / dry-run).
 *
 * @type {string}
 */
export const START_INSTRUCTION_FULL =
  '开始一次完整迭代（审查 → 修复 → 验证 → 复盘）：请调用 `workflow` 工具运行 iterate 工作流，' +
  'mode: "normal"，按系统提示的 Iterate Workflow 执行 plan → 多线程并行评审 → 分诊 → 原子修复 → 每轮验证 → 循环直至收敛或达到 max_rounds → 终报并 `iterate_transcript` capture。' +
  '开跑前先 `iterate_config({operation:"read"})` 检查 validation.commands：若为空，先停下来提示我用 `iterate_config` 写入验证命令，否则本轮迭代不受任何测试保护。'

/**
 * Dry-run (review-only) startup instruction — mirrors the skill prompt's
 * "review only / dry run / 不要改文件 → mode: dry-run" branch.
 *
 * @type {string}
 */
export const START_INSTRUCTION_REVIEW_ONLY =
  '开始一次仅评审（dry-run，不修改任何文件）：请调用 `workflow` 工具运行 iterate 工作流，' +
  'mode: "dry-run"，按系统提示的 Iterate Workflow 执行 plan → 多线程并行评审 → 分诊 → `iterate_review aggregate` / `meta-review` 终报并 `iterate_transcript` capture；' +
  '全程不要调用 `iterate_fix` / `iterate_rollback`。'

/** The registered startup instruction set the client CTA copies from. */
export const START_INSTRUCTIONS = {
  full: START_INSTRUCTION_FULL,
  reviewOnly: START_INSTRUCTION_REVIEW_ONLY,
}

/** Normalize an arbitrary finding-ish node into the payload field set. */
function fixFindingPayload(finding) {
  const f = finding && typeof finding === 'object' ? finding : {}
  const file = String(f.file ?? '')
  return {
    file,
    ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
    dimension: String(f.dimension ?? ''),
    severity: String(f.severity ?? ''),
    summary: String(f.summary ?? ''),
    ...(f.failure_scenario ? { failure_scenario: String(f.failure_scenario) } : {}),
    ...(f.suggested_fix ? { suggested_fix: String(f.suggested_fix) } : {}),
  }
}

/**
 * Staged `iterate_fix` instruction for ONE finding.
 *
 * The tool schema (`src/tools/fix.ts`) requires `file` / `content` / `finding`
 * / `round`; a raw JSON blob without `content` + `round` made the model guess
 * the two hardest values, so the payload now names every required field and
 * marks the two the model must fill in (`content` = the full NEW file, `round`
 * = the current round) instead of pretending to ship a complete call.
 *
 * @param {Record<string, unknown>} finding
 * @param {{ round?: number } | null} [opts] current round, when known by the UI
 * @returns {string}
 */
export function buildFixInstruction(finding, opts) {
  const payload = fixFindingPayload(finding)
  if (!payload.file) return ''
  const round = opts && Number.isInteger(opts.round) ? opts.round : null
  const call = {
    file: payload.file,
    content: CONTENT_PLACEHOLDER,
    finding: payload,
    round: round !== null ? round : ROUND_PLACEHOLDER,
  }
  return [
    '请修复下面这一个 finding。`iterate_fix` 一次只接受一个 finding，且 file / content / finding / round 四个参数全部必填：',
    `步骤 1：读取 \`${payload.file}\`，按 finding 生成修复后的【完整文件内容】（content 占位必须换成真实文件内容）。`,
    `步骤 2：调用 \`iterate_fix\`，把 content 与 round 填成真实值${round !== null ? `（本轮 round = ${round}）` : ''}：`,
    '```json',
    JSON.stringify(call, null, 2),
    '```',
    '需要超过 atomic 行数上限时，另加 "force": true。',
  ].join('\n')
}

/**
 * Batch assign instruction: N findings, but `iterate_fix` has NO array
 * parameter — the payload says so explicitly ("一次一个").
 *
 * @param {Array<Record<string, unknown>>} findings
 * @returns {string}
 */
export function buildAssignFixesInstruction(findings) {
  const list = (Array.isArray(findings) ? findings : [])
    .filter((f) => f && typeof f === 'object')
  if (list.length === 0) return ''
  const payload = list.map((f) => fixFindingPayload(f)).filter((p) => p.file)
  if (payload.length === 0) return ''
  return [
    `请修复下面这 ${payload.length} 个 findings。注意：\`iterate_fix\` 每次只处理【一个】finding（没有数组入参），请逐个调用 iterate_fix——一次一个 finding，处理完一个再发起下一个，绝不要把整批数组当作参数传入。`,
    '每个 finding 都走同样的两步：① 读取文件生成修复后的完整 content；② 调用 iterate_fix（file / content / finding / round 必填，content 与 round 由你填写）。',
    '待修复清单：',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

/**
 * Architectural-fix approval instruction: `force: true` exists on the tool,
 * but the four required fields still apply — the old text implied a lone
 * `force` flag was enough.
 *
 * @param {Array<Record<string, unknown>>} [findings] optional scoped findings
 * @returns {string}
 */
export function buildArchitecturalFixInstruction(findings) {
  const list = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f === 'object')
  const lines = [
    '请批准并执行架构型修复（允许超过 atomic 行数上限）：对每个架构型 finding 逐个调用 `iterate_fix`，一次一个 finding，并显式设置 `"force": true`；',
    'file / content / finding / round 四个必填参数一个都不能少（content = 修复后的完整文件内容，round = 当前迭代轮次，两者由你填写）。',
  ]
  if (list.length > 0) {
    lines.push('本项目剩余架构型 finding：', '```json', JSON.stringify(list.map((f) => fixFindingPayload(f)), null, 2), '```')
  }
  return lines.join('\n')
}

/**
 * `iterate_checkpoint` resume payload. The tool's `mode` / `round` /
 * `maxRounds` / `fixedCount` are SAVE-only inputs; `resume` takes nothing but
 * `operation`, and `maxRounds: null` was an invalid-integer field.
 *
 * @returns {string}
 */
export function buildCheckpointResumeInstruction() {
  return (
    '请调用 `iterate_checkpoint` 从断点恢复迭代（加载断点并把 resumeCount +1）：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'resume' }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_checkpoint` clear payload (stale checkpoint reset).
 *
 * @returns {string}
 */
export function buildCheckpointClearInstruction() {
  return (
    '请调用 `iterate_checkpoint` 清除当前断点：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'clear' }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_quality_gate` query instruction with explicit JSON args — the old
 * plain-prose version had no `operation` and occasionally lost the enum.
 *
 * @returns {string}
 */
export function buildQualityGateQueryInstruction() {
  return (
    '请调用 `iterate_quality_gate` 查询当前质量门禁状态（读取磁盘上持久化的证书）：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'read' }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_quality_gate` clear payload (reset a stale FAIL certificate).
 *
 * @returns {string}
 */
export function buildQualityGateClearInstruction() {
  return (
    '请调用 `iterate_quality_gate` 清除当前质量门禁证书：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'clear' }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_rollback` payload for one applied fix id.
 *
 * @param {string} id
 * @returns {string}
 */
export function buildRollbackInstruction(id) {
  return (
    '请调用 `iterate_rollback` 回滚以下修复：\n\n' +
    '```json\n' +
    `${JSON.stringify({ id: String(id || '') }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_experience` list instruction (F9 empty state + header button).
 *
 * @returns {string}
 */
export function buildExperienceListInstruction() {
  return (
    '请调用 `iterate_experience` 列出经验银行中的所有经验，并把完整返回结果回显到会话里：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'list' }, null, 2)}\n` +
    '```'
  )
}

/**
 * `iterate_defense_events` list instruction (F10 empty state + header button).
 *
 * @returns {string}
 */
export function buildDefenseEventsListInstruction() {
  return (
    '请调用 `iterate_defense_events` 列出全部防御事件，并把完整返回结果回显到会话里：\n\n' +
    '```json\n' +
    `${JSON.stringify({ operation: 'list' }, null, 2)}\n` +
    '```'
  )
}

/**
 * Disk snapshot pull instruction (#4): the browser client has no filesystem
 * access, so the only way to fill the panels from `.iterate/` is to ask the
 * model to call the read-side tools and echo their FULL results back into the
 * session stream (which is exactly what the session scanners consume).
 *
 * @returns {string}
 */
export function buildDiskSnapshotInstruction() {
  const lines = [
    '请从磁盘拉取 iterate 快照：逐个调用下面的只读工具，并把每个工具的【完整返回结果】原样回显到会话里（不要只给摘要——插件面板靠这些回显填充）：',
  ]
  DISK_SNAPSHOT_SOURCES.forEach((s, i) => {
    lines.push(`${i + 1}. \`${s.tool}\`（${s.label}）：${JSON.stringify(s.args)}`)
  })
  lines.push('回显后，观测台实时流 / F2 跨轮对比 / F5 断点 / F8 质量门禁 / F9 经验银行 / F10 防御事件会自动读取这些结果。')
  return lines.join('\n')
}

/**
 * Read-side tools whose results fill the client panels, with the exact
 * argument objects their schemas accept (all operations are optional-input).
 * @type {Array<{ tool: string, args: Record<string, unknown>, label: string }>}
 */
export const DISK_SNAPSHOT_SOURCES = [
  { tool: 'iterate_status', args: {}, label: '运行状态汇总' },
  { tool: 'iterate_transcript', args: { operation: 'read' }, label: 'transcript 观测清单' },
  { tool: 'iterate_quality_gate', args: { operation: 'read' }, label: '质量门禁证书' },
  { tool: 'iterate_experience', args: { operation: 'list' }, label: '经验银行' },
  { tool: 'iterate_defense_events', args: { operation: 'list' }, label: '防御事件流' },
  { tool: 'iterate_history', args: {}, label: '决策日志与修复注册表（跨轮/跨会话对比）' },
]

/**
 * Whether `toolName` has actually been called in this session snapshot — the
 * difference between "磁盘无数据" (we pulled it and it is empty) and "尚未拉取"
 * (we never asked the model to read it).
 *
 * @param {unknown} session
 * @param {string} toolName
 * @returns {boolean}
 */
export function toolCalledInSession(session, toolName) {
  if (!session || typeof session !== 'object' || typeof toolName !== 'string' || !toolName) return false
  const s = /** @type {Record<string, unknown>} */ (session)

  const toolCalls = safeGet(s, 'toolCalls')
  if (Array.isArray(toolCalls)) {
    for (const call of /** @type {unknown[]} */ (toolCalls)) {
      if (!call || typeof call !== 'object') continue
      const t = String(safeGet(/** @type {Record<string, unknown>} */ (call), 'tool') ?? '')
      if (t === toolName || t.endsWith(toolName)) return true
    }
  }

  const messages = safeGet(s, 'messages')
  if (Array.isArray(messages)) {
    for (const msg of /** @type {unknown[]} */ (messages)) {
      if (!msg || typeof msg !== 'object') continue
      const calls = safeGet(/** @type {Record<string, unknown>} */ (msg), 'tool_calls')
      if (!Array.isArray(calls)) continue
      for (const call of /** @type {unknown[]} */ (calls)) {
        if (!call || typeof call !== 'object') continue
        const c = /** @type {Record<string, unknown>} */ (call)
        const name = String(safeGet(c, 'name') ?? safeGet(c, 'tool') ?? '')
        if (name === toolName || name.endsWith(toolName)) return true
        const fn = safeGet(c, 'function')
        if (fn && typeof fn === 'object' && String(safeGet(/** @type {Record<string, unknown>} */ (fn), 'name') ?? '') === toolName) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Empty-state copy that separates the two very different "nothing here"
 * situations: the tool was never pulled from disk (call to action) vs. it was
 * pulled and the disk really has no data.
 *
 * @param {boolean} pulled whether the backing tool was called this session
 * @param {string} topic what is missing (e.g. "质量门禁证书")
 * @returns {string}
 */
export function diskEmptyStateText(pulled, topic) {
  const subject = topic || '数据'
  return pulled
    ? `已从磁盘拉取：${subject}暂无记录（磁盘无数据）。`
    : `尚未从磁盘拉取${subject}：数据存放在项目 .iterate/ 下，点「拉取磁盘快照」复制指令发回会话即可回填。`
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
  if (!finding || typeof finding !== 'object') return false
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
    // TriagePanel feeds report findings in unconditionally — ONE null / junk
    // element must not kill the whole filter bar with a TypeError.
    if (!f || typeof f !== 'object') continue
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
  // TRIAGE_VERDICTS is the source of truth for valid verdict keys — anything
  // outside it (unknown key, junk type) is rejected unchanged.
  if (!TRIAGE_VERDICTS.includes(verdict)) return triageState
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
  // Delegates to batchSetVerdict, whose TRIAGE_VERDICTS validation rejects an
  // unknown verdict key here as well (unchanged state is returned).
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
    if (!r || typeof r !== 'object') return { round: 0, count: 0, critical: 0, high: 0, medium: 0, low: 0 }
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

// ─── Stop reason badges (v3.5.5) ─────────────────────────────────────────────
//
// Every value the iterate loop can report as `stoppedReason` — including the
// schema-retry batch (schema_invalid / no_usable_reviewer_output / inconclusive)
// — maps to a concrete Chinese label. Unknown values still get a readable
// default instead of a bare "已结束". Kept in parse.js so both the client
// observatory badge and Node unit tests share one source of truth.

/**
 * Chinese badge label for a run's `stoppedReason`, or null/undefined-safe.
 *
 * @param {string | null | undefined} reason
 * @returns {string}
 */
export function stoppedReasonLabel(reason) {
  switch (reason) {
    case 'converged': return '已结束 · 已收敛（无新发现）'
    case 'max_rounds_reached': return '已结束 · 达到轮数上限'
    case 'aborted_by_validation': return '已结束 · 验证失败后回滚停止'
    case 'aborted_by_config': return '已结束 · 验证命令不在白名单（配置需修复）'
    case 'inconclusive': return '已结束 · 轮次结论不明（审查输出无效）'
    case 'schema_invalid': return '已结束 · 审查输出连续 schema 校验失败'
    case 'no_usable_reviewer_output': return '已结束 · 无可用审查输出'
    default: return reason ? `已结束 · ${reason}` : '已结束'
  }
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
  { key: 'reasoning_effort', label: '审查推理强度', hint: '"low" / "medium" / "high"，缺省跟随模型默认' },
  {
    key: 'validation.commands',
    label: '验证命令',
    hint: '数组，每项是一条白名单命令字符串，如 ["npm test","npm run lint"]；每轮验证逐条执行。留空数组 = 不验证（本轮迭代不受任何测试保护）',
  },
  {
    key: 'language',
    label: '界面语言',
    hint: '"zh" 或 "en"（默认 "en"）：控制审批理由、防御事件标签等面向人文案的语言',
  },
  {
    key: 'personalization.known_intentional',
    label: '已知有意问题',
    hint: '数组，每项 {file, line?, dimension, reason}；命中条目在评审中被跳过。可用分诊面板的「回读已写入条目」核对',
  },
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
    '⚠ 未配置 validation.commands 时迭代不被保护：每轮 validate 拿到空结果会被当作',
    '  “验证通过”，等于在没有任何测试保护的情况下继续收敛。第一次启动迭代前，',
    '  请先给 validation.commands 配上至少一条真实命令（如 npm test）。',
    '',
    '可编辑字段：',
    ...CONFIG_EDIT_FIELDS.map((f) => `- ${f.key}（${f.label}）：${f.hint}`),
    '',
    '让模型帮你改：',
    '1. 调用 iterate_config({ operation: "read" }) 查看当前配置；',
    '2. 说明想改的字段，例如「把 max_rounds 改成 5，validation.commands 加上 npm test」；',
    '3. 模型会调用 iterate_config({ operation: "write", updates: {...} }) 写入，写入前自动备份，失败自动回滚。',
    '',
    '也可以用设置页的“选字段 → 生成写入指令”直接复制第 3 步的指令粘贴给模型。',
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

/** Placeholder for a config value the user still has to supply. */
export const CONFIG_VALUE_PLACEHOLDER = '<由模型填写：该字段的新值>'

/**
 * Look up an editable config field by its dotted key (gap #8).
 *
 * @param {string} key
 * @returns {{ key: string, label: string, hint: string } | null}
 */
export function configFieldByKey(key) {
  if (typeof key !== 'string' || !key) return null
  return CONFIG_EDIT_FIELDS.find((f) => f.key === key) ?? null
}

/**
 * Gap #8: turn a single selected config field into a paste-able write
 * instruction. `value` may be omitted, in which case an explicit
 * "filled in by the model" placeholder is emitted so the user knows what to
 * complete (same convention as the other instruction builders).
 *
 * @param {string} key
 * @param {unknown} [value]
 * @returns {string}
 */
export function buildConfigFieldInstruction(key, value) {
  const field = configFieldByKey(key)
  const label = field ? field.label : key
  const hint = field ? field.hint : '见 iterate.config.yaml'
  const updates = { [key]: value === undefined ? CONFIG_VALUE_PLACEHOLDER : value }
  // Delegate the payload to `buildConfigEditInstruction` so the multi-field
  // builder stays a live code path (it used to be test-only dead code).
  const payload = buildConfigEditInstruction(updates)
  return [
    `配置字段 · ${label}（${key}）`,
    `字段说明：${hint}`,
    '',
    payload,
    '',
    '写入前请先 \`operation: "read"\` 展示当前值；写入由工具自动备份，失败自动回滚。',
  ].join('\n')
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
  const verdict = VERDICT_SHORTCUTS[key]
  // TRIAGE_VERDICTS is the verdict source of truth: a shortcut entry whose
  // value falls outside the verdict set is not a triage shortcut.
  return verdict !== undefined && TRIAGE_VERDICTS.includes(verdict) ? verdict : null
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
    '重置状态：中断后重新开始前，可分别让模型调用 iterate_checkpoint(operation:"clear")、',
    '  iterate_quality_gate(operation:"clear")、iterate_defense_events(operation:"clear")',
    '  清除陈旧断点、质量门禁证书与防御事件流。',
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
      let dataText = ''
      try {
        dataText = JSON.stringify(t.data ?? {})
      } catch {
        // A self-referential `data` reference would throw on stringify — degrade
        // to a string representation rather than crashing the search.
        dataText = t.data === undefined ? '{}' : String(t.data)
      }
      const hay = [String(t.type ?? ''), String(t.round ?? ''), dataText].join(' ').toLowerCase()
      if (hay.indexOf(q) < 0) return false
    }
    return true
  })
  return filtered
    .slice()
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
}

/**
 * Serialize the full observatory state (manifest + live feed + pulled disk
 * snapshots) into a JSON string the client can copy/export. Always includes an
 * `exportedAt` stamp and guards against non-serializable / oversized payloads
 * by falling back to the manifest only.
 *
 * Gap #11: `extra` lets the caller attach the disk-side artifacts
 * (qualityGate / experienceBank / defenseEvents / report) that the export
 * previously dropped, so the copy actually captures the on-disk state.
 *
 * @param {unknown} manifest
 * @param {unknown} live
 * @param {Record<string, unknown>} [extra]
 * @returns {string}
 */
export function serializeObservatoryExport(manifest, live, extra) {
  const payload = {
    exportedAt: new Date().toISOString(),
    manifest: manifest && typeof manifest === 'object' ? manifest : null,
    live: Array.isArray(live) ? live : [],
    ...pickExportExtras(extra),
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    // A cyclic / non-serializable manifest must not crash the copy action.
    return JSON.stringify({ exportedAt: payload.exportedAt, manifest: null, live: [] }, null, 2)
  }
}

/** Disk-side keys the export recognizes (gap #11). */
export const EXPORT_EXTRA_KEYS = ['qualityGate', 'experienceBank', 'defenseEvents', 'report']

/**
 * Copy only the known extra keys, dropping `undefined` so the export shape
 * stays stable when a snapshot has not been pulled yet.
 *
 * @param {unknown} extra
 * @returns {Record<string, unknown>}
 */
function pickExportExtras(extra) {
  const out = {}
  if (!extra || typeof extra !== 'object') return out
  for (const key of EXPORT_EXTRA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) continue
    const value = extra[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * Gap #13: build the cross-round comparison table for a single session.
 * One row per round: findings raised, findings fixed, severity mix and the
 * validation command outcomes recorded on the manifest.
 *
 * Cross-*session* comparison is intentionally out of scope — that is what the
 * #4 pull instruction is for (see `buildDiskSnapshotInstruction`).
 *
 * @param {unknown} report
 * @param {unknown} validations
 * @returns {Array<{round: number, findings: number, fixed: number, severities: Record<string, number>, validations: Array<{command: string, exitCode: number|null, allowed: boolean}>}>}
 */
export function buildRoundComparison(report, validations) {
  const rounds = new Map()
  const rowsFor = (round) => {
    const n = Number(round)
    const key = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    if (!rounds.has(key)) {
      rounds.set(key, { round: key, findings: 0, fixed: 0, severities: Object.create(null), validations: [] })
    }
    return rounds.get(key)
  }

  const list = report && Array.isArray(report.findings) ? report.findings : []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    const row = rowsFor(f.round)
    row.findings += 1
    const sev = typeof f.severity === 'string' && f.severity ? f.severity : 'unknown'
    row.severities[sev] = (row.severities[sev] || 0) + 1
    if (f.status === 'fixed') row.fixed += 1
  }

  const vals = Array.isArray(validations) ? validations : []
  for (const v of vals) {
    if (!v || typeof v !== 'object') continue
    const row = rowsFor(v.round)
    row.validations.push({
      command: typeof v.command === 'string' ? v.command : '',
      exitCode: typeof v.exitCode === 'number' ? v.exitCode : null,
      allowed: v.allowed === true,
    })
  }

  return [...rounds.values()]
    .filter((r) => r.round > 0)
    .sort((a, b) => a.round - b.round)
    .map((r) => ({ ...r, severities: { ...r.severities } }))
}

/**
 * Gap #5: decide what the convergence dashboard should say.
 *
 * - `running` — a manifest exists and the run has not stopped: show the live
 *   round/phase instead of the onboarding copy (gap #5's actual bug: the old
 *   check was `!transcript`, so a run in progress still rendered "how to start").
 * - `done`    — a manifest exists but the run is no longer active: show the
 *   outcome (with `stoppedReason` when the workflow recorded one).
 * - `empty`   — nothing has run yet: show the start-instruction prompt.
 *
 * @param {unknown} transcript normalized transcript (or a raw manifest)
 * @returns {{state: 'running'|'done'|'empty', round: number, phase: string, stoppedReason: string}}
 */
export function dashboardRunState(transcript) {
  const t = transcript && typeof transcript === 'object' ? transcript : null
  if (!t) return { state: 'empty', round: 0, phase: '', stoppedReason: '' }
  const rawRound = Number(t.round)
  const round = Number.isFinite(rawRound) && rawRound > 0 ? Math.floor(rawRound) : 1
  const stoppedReason = typeof t.stoppedReason === 'string' ? t.stoppedReason.trim() : ''
  return {
    state: t.active === true ? 'running' : 'done',
    round,
    phase: latestPhase(t.phases),
    stoppedReason,
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