/**
 * src/session-record.ts — dsh session-linked run records (dsh ≥ 0.2.1-rc.1).
 *
 * Upstream capability (dsh `0.2.1-rc.1`, released 2026-10-17): the *Session
 * state-record API*. An experimental plugin may append its own record onto a
 * session's append-only log with `appendPluginRecord(session, type, data)` and
 * read it back with `pluginRecordOf(event)` (`@deepseek-ai/dsh-session`). The
 * record is marked `ignorable`, never enters the model-visible surface, and is
 * carried along by fork / resume / format migration.
 *
 * Why the plugin adopts it:
 *   The iterate run state has, until now, lived ONLY under `<projectRoot>/.iterate/`.
 *   That is correct for normal operation but has two blind spots the session
 *   log closes:
 *     1. **Loss recovery** — if `.iterate/` is deleted, moved, or the working
 *        directory changes, the observatory goes blank even though the session
 *        that produced the run is still open. A compact run record on the
 *        session log lets `iterate_transcript read` rehydrate the run summary
 *        instead of returning an empty view.
 *     2. **Session anchoring** — run provenance is tied to the *session* that
 *        produced it, not only to whatever directory the process happens to be
 *        in when someone looks afterwards.
 *
 * Design (fail-safe, never a hard dependency):
 *   - The API is loaded lazily via a dynamic `import()` and used structurally
 *     (no compile-time coupling to `PluginRecordMap`), so a host whose copy of
 *     `@deepseek-ai/dsh-session` predates the API simply reports
 *     `supported: false` instead of failing to load the plugin.
 *   - Every entry point returns a structured result; nothing throws. Writing a
 *     record is best-effort — a run must never fail because the session log
 *     could not accept a bookkeeping record.
 *   - `normalizeRunRecord` re-validates a restored payload, because a record
 *     read from a resumed session carries whatever JSON an earlier build wrote.
 */

/** The `plugin:` record type this plugin owns (grammar-checked by dsh). */
export const ITERATE_RUN_RECORD_TYPE = 'plugin:iterate/run'
/** Bump when the record payload shape changes incompatibly. */
export const ITERATE_RUN_RECORD_VERSION = 1

/** Compact, lossless-JSON summary of one iterate run at a point in time. */
export interface IterateRunRecord {
  version: number
  /** Project root the run belongs to (absolute at write time). */
  project: string
  goal: string
  mode: 'dry-run' | 'normal' | null
  taskMode: 'code' | 'iterate' | null
  /** Highest round reached. */
  round: number
  maxRounds: number
  /** False once the run recorded a terminal `stoppedReason`. */
  active: boolean
  stoppedReason: string | null
  /** Per-round NEW-finding counts, newest last (drives the F2 trend on recovery). */
  convergence: number[]
  findings: {
    total: number
    critical: number
    high: number
    medium: number
    low: number
  }
  /** Applied (successful) fixes recorded so far. */
  fixedCount: number
  /** Quality-gate verdict snapshotted at write time (`pending` when undecided). */
  qualityStatus: 'pass' | 'fail' | 'pending' | null
  /** ISO timestamp the record was written. */
  updatedAt: string
}

/** A run record read back from a session log, with its log position. */
export interface StoredRunRecord extends IterateRunRecord {
  /** Session-log sequence number the record occupies. */
  seq: number
  /** Unix epoch milliseconds at append (from the host). */
  time: number
}

/** Minimal structural view of the session-log API we consume. */
export interface SessionRecordApi {
  appendPluginRecord(session: unknown, type: string, data: unknown): number
  pluginRecordOf(event: unknown): { type: string; seq: number; time: number; data: unknown } | undefined
}

/** Minimal structural view of a dsh Session (only what this module reads). */
export interface SessionLike {
  ownEvents?(): readonly unknown[]
  snapshotEvents?(): readonly unknown[]
}

/** Result of a best-effort record append. */
export type AppendRecordResult =
  | { ok: true; supported: true; seq: number }
  | { ok: false; supported: boolean; error: string }

/** Result of reading the session's iterate run records. */
export interface ReadRecordsResult {
  supported: boolean
  /** Oldest → newest. */
  records: StoredRunRecord[]
  /** Present only when the read itself failed unexpectedly. */
  error?: string
}

// ─── Pure payload construction / validation ─────────────────────────────────

/** Coerce an unknown to a finite non-negative integer, else `fallback`. */
function nonNegInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n >= 0 ? n : fallback
}

/** Extract a string, else `''`. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Extract one of the allowed literal values, else `null`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/** Severity counts recovered from an on-disk manifest summary. */
export interface RunRecordCounts {
  total: number
  critical: number
  high: number
  medium: number
  low: number
}

/**
 * Build a run record from the fields a persisted transcript manifest exposes.
 * Pure: the caller passes already-normalized values, so this is unit-testable
 * without touching disk or a session.
 */
export function buildRunRecord(input: {
  project?: unknown
  goal?: unknown
  mode?: unknown
  taskMode?: unknown
  round?: unknown
  maxRounds?: unknown
  active?: unknown
  stoppedReason?: unknown
  convergence?: unknown
  counts?: Partial<RunRecordCounts>
  fixedCount?: unknown
  qualityStatus?: unknown
  now?: string
}): IterateRunRecord {
  const convergence = Array.isArray(input.convergence)
    ? input.convergence
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
        .slice(-1000)
    : []
  const c = input.counts ?? {}
  const stopped = str(input.stoppedReason)
  return {
    version: ITERATE_RUN_RECORD_VERSION,
    project: str(input.project),
    goal: str(input.goal),
    mode: oneOf(input.mode, ['dry-run', 'normal'] as const),
    taskMode: oneOf(input.taskMode, ['code', 'iterate'] as const),
    round: nonNegInt(input.round),
    maxRounds: nonNegInt(input.maxRounds),
    active: input.active !== false,
    stoppedReason: stopped ? stopped : null,
    convergence,
    findings: {
      total: nonNegInt(c.total),
      critical: nonNegInt(c.critical),
      high: nonNegInt(c.high),
      medium: nonNegInt(c.medium),
      low: nonNegInt(c.low),
    },
    fixedCount: nonNegInt(input.fixedCount),
    qualityStatus: oneOf(input.qualityStatus, ['pass', 'fail', 'pending'] as const),
    updatedAt: str(input.now) || new Date().toISOString(),
  }
}

/**
 * Owner-side validation of a payload read back from a session log.
 * A restored record carries whatever JSON an earlier build of this plugin
 * wrote, so every field is re-checked; anything unrecognizable returns `null`
 * (the caller skips it) rather than surfacing junk to a renderer.
 */
export function normalizeRunRecord(data: unknown): IterateRunRecord | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  // A record written by a future/incompatible build is skipped rather than
  // coerced: the version gate is the contract that lets the payload evolve.
  // The check is exact (an integer compare, not a floor) so a payload stamped
  // `1.9` by a future build is rejected instead of rounded down to `1`.
  if (!Number.isInteger(d.version) || d.version !== ITERATE_RUN_RECORD_VERSION) return null
  const findings = (d.findings && typeof d.findings === 'object' && !Array.isArray(d.findings)
    ? (d.findings as Record<string, unknown>)
    : {}) as Record<string, unknown>
  return buildRunRecord({
    project: d.project,
    goal: d.goal,
    mode: d.mode,
    taskMode: d.taskMode,
    round: d.round,
    maxRounds: d.maxRounds,
    active: d.active,
    stoppedReason: d.stoppedReason,
    convergence: d.convergence,
    counts: {
      total: findings.total as number,
      critical: findings.critical as number,
      high: findings.high as number,
      medium: findings.medium as number,
      low: findings.low as number,
    },
    fixedCount: d.fixedCount,
    qualityStatus: d.qualityStatus,
    now: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
  })
}

// ─── Session access (lazy, fail-safe) ────────────────────────────────────────

/** Lazily-resolved production API; `undefined` = not yet attempted. */
let cachedApi: Promise<SessionRecordApi | null> | undefined
/** Test override; when set (including `null`) the dynamic import is bypassed. */
let testApiOverride: SessionRecordApi | null | undefined
/** Module loader; replaceable for tests to exercise import failure/late availability. */
let moduleImporter: () => Promise<unknown> = () => import('@deepseek-ai/dsh-session')

/** Resolve the `@deepseek-ai/dsh-session` record API, or `null` when absent. */
export function loadSessionRecordApi(): Promise<SessionRecordApi | null> {
  if (testApiOverride !== undefined) return Promise.resolve(testApiOverride)
  if (cachedApi === undefined) {
    // `Promise.resolve().then(...)` (not a bare call) so a loader that throws
    // SYNCHRONOUSLY still lands in the `.catch` instead of escaping.
    cachedApi = Promise.resolve()
      .then(() => moduleImporter())
      .then((mod) => {
        const m = mod as unknown as Partial<SessionRecordApi>
        if (typeof m.appendPluginRecord !== 'function' || typeof m.pluginRecordOf !== 'function') {
          return null
        }
        return {
          appendPluginRecord: m.appendPluginRecord.bind(mod),
          pluginRecordOf: m.pluginRecordOf.bind(mod),
        }
      })
      .catch(() => null)
    // A `null` resolution (module/API absent, or a transient import failure) is
    // NOT memoized: it is cleared so the next call retries. Otherwise one
    // unlucky first import would disable session linking for the whole process.
    void cachedApi.then((api) => {
      if (!api) cachedApi = undefined
    })
  }
  return cachedApi
}

/**
 * Replace the module loader for tests (to exercise the import-failure and
 * late-availability paths). Pass `undefined` to restore the real dynamic import.
 */
export function setSessionRecordImporterForTests(loader: (() => Promise<unknown>) | undefined): void {
  moduleImporter = loader ?? (() => import('@deepseek-ai/dsh-session'))
  cachedApi = undefined
}

/**
 * Override the session-record API for tests. Pass `undefined` to restore the
 * real dynamic import, or an object / `null` to force a deterministic result.
 */
export function setSessionRecordApiForTests(api: SessionRecordApi | null | undefined): void {
  testApiOverride = api
}

/** Extract the session from a tool execution (`exec.agent.session`), defensively. */
export function sessionOf(exec: unknown): SessionLike | undefined {
  try {
    const agent = (exec as { agent?: { session?: unknown } } | null | undefined)?.agent
    const session = agent?.session
    if (!session || typeof session !== 'object') return undefined
    const s = session as SessionLike
    if (typeof s.ownEvents === 'function' || typeof s.snapshotEvents === 'function') return s
    return undefined
  } catch {
    return undefined
  }
}

/** Read every event a session exposes (own events preferred, snapshot fallback). */
function eventsOf(session: SessionLike): readonly unknown[] {
  try {
    if (typeof session.ownEvents === 'function') return session.ownEvents() ?? []
  } catch {
    // fall through to snapshot
  }
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() ?? []
  } catch {
    // no readable log
  }
  return []
}

/**
 * Best-effort append of one run record to the session log.
 * Never throws: an absent API, a degraded session, or a rejected payload all
 * surface as `{ ok: false }` so the surrounding tool call can continue.
 */
export async function appendRunRecord(
  session: SessionLike | undefined,
  record: IterateRunRecord,
): Promise<AppendRecordResult> {
  const api = await loadSessionRecordApi()
  if (!api) return { ok: false, supported: false, error: 'session record API unavailable' }
  if (!session) return { ok: false, supported: true, error: 'no session in scope' }
  try {
    const seq = api.appendPluginRecord(session, ITERATE_RUN_RECORD_TYPE, record)
    return { ok: true, supported: true, seq }
  } catch (err) {
    return {
      ok: false,
      supported: true,
      error: `session rejected the run record: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Read every iterate run record from the session log (oldest → newest). */
export async function readRunRecords(session: SessionLike | undefined): Promise<ReadRecordsResult> {
  const api = await loadSessionRecordApi()
  if (!api) return { supported: false, records: [] }
  if (!session) return { supported: true, records: [] }
  try {
    const records: StoredRunRecord[] = []
    for (const event of eventsOf(session)) {
      const rec = api.pluginRecordOf(event)
      if (!rec || rec.type !== ITERATE_RUN_RECORD_TYPE) continue
      const normalized = normalizeRunRecord(rec.data)
      if (!normalized) continue
      records.push({ ...normalized, seq: nonNegInt(rec.seq), time: nonNegInt(rec.time) })
    }
    return { supported: true, records }
  } catch (err) {
    return {
      supported: true,
      records: [],
      error: `failed to read session records: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
