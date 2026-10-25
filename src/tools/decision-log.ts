/**
 * src/tools/decision-log.ts — the iterate loop's decision ledger.
 *
 * THE WRITE SIDE IS THE KERNEL'S SINCE THIS BATCH. `appendDecisionEntry` no longer
 * serialises the loop's own `{timestamp, round, type, data}` record: it transcribes that
 * record through `iterate-kernel/decision-log-transcribe` and appends a verified
 * hash-chain entry through `iterate-kernel/decision-log` — the same shape the Python
 * harness writes (`iterate_harness/iterate/decision_log.py`) and the same file format the
 * GlassPane fork already runs. Two ecosystems, one format on disk, one chain either side
 * can recompute:
 *
 *   line i        = canonical JSON of entry i (keys sorted, no whitespace)
 *   sequence      = i (genesis is 0, strictly +1)
 *   prevEntryHash = "" for i = 0, else sha256_hex(line i-1 as written)
 *
 * Chain fields are supplied by the LEDGER (`decisionLogHead` inside the kernel's append),
 * never by the caller — a caller that could pick `sequence` could rewrite history.
 *
 * The history that predates the flip is neither rewritten away nor ignored:
 *
 * - a file whose every line is still a legacy record is MIGRATED ON THE NEXT WRITE: each
 *   record transcribed in order using its OWN timestamp (which also mints its entry id, so
 *   two runs migrating the same history build the same chain), the new chain verified
 *   BEFORE anything is swapped in, and the original bytes kept beside it at mode 0600;
 * - `readDecisionLogDetailed` classifies every line and returns the RECORD VIEW for both
 *   shapes (`projectDecisionRecord`), which is what keeps `last_state`, `ci_report`,
 *   `html_report`, `replay`, history/checkpoint and the web client working unchanged:
 *   transcription rule 3 copies `data` into `payload` in full, so nothing a report reads
 *   is lost by the flip;
 * - a log where a legacy line FOLLOWS the chain is CONTESTED: refused, reported, and left
 *   for a human. Re-deriving a line that already carries a hash would forge its
 *   continuity, so neither the append path nor prune touches it — `archiveContestedDecisionLog`
 *   is the only legal move, and it is chosen, never automatic;
 * - a line that is neither shape is SKIPPED by the reader (a partial log beats no log) and
 *   counted in `invalidLines` so it never disappears silently.
 *
 * Refusals carry `code` + `remedy` — the kernel's own codes propagate verbatim
 * (`KERNEL_E_*`), plus the two cases only a file's history can produce
 * (`ITERATE_E_DECISION_LOG_INTERLEAVED` / `ITERATE_E_DECISION_LOG_MIGRATION`). They are
 * never a bare Error and never swallowed: `appendDecisionEntry` keeps its old
 * never-throws contract and returns the refusal structured, and the tool boundary answers
 * with the code and the remedy.
 */

import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  KernelDecisionLogError,
  appendDecisionLogEntry as kernelAppendLedgerEntry,
  buildDecisionLogEntry as kernelBuildLedgerEntry,
  decisionLogEntryHash as kernelLedgerEntryHash,
  newDecisionEntryId as kernelNewDecisionEntryId,
  serializeDecisionLogEntry as kernelSerializeLedgerEntry,
  verifyDecisionLogText as kernelVerifyLedgerText,
  type DecisionLogDraft,
} from 'iterate-kernel/decision-log'
import { DECISION_KIND_PATTERN as KERNEL_DECISION_KIND_PATTERN } from 'iterate-kernel/decision-log-entry'
import {
  KernelDecisionTranscribeError,
  decisionLogDraftFromRecord as kernelDraftFromRecord,
  isLegacyDecisionRecord as kernelIsLegacyRecord,
} from 'iterate-kernel/decision-log-transcribe'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { acquireProjectLockChecked } from '../file-lock.ts'
import { KNOWN_DECISION_KINDS, type DecisionLogEntry } from '../types.ts'

const LOG_DIR = '.iterate'
const LOG_FILE = 'decision-log.jsonl'

/** Absolute path of a project's ledger. Pure: never creates anything. */
export function decisionLogPath(projectRoot: string): string {
  return join(projectRoot, LOG_DIR, LOG_FILE)
}

// ─── Cross-process log mutex ────────────────────────────────────────────────
//
// Appends from two plugin processes against one project would otherwise interleave
// inside the kernel's read-head → write → read-back window and break the chain. The
// kernel DETECTS that (read-back + verify) and refuses to build on the damaged tail;
// the advisory lock keeps it from happening at all. Appends are BEST-EFFORT on
// contention: a timeout degrades to "proceed unlocked" (an audit line must never be
// lost to a wedged append) and the kernel's own detection is the backstop. Nothing
// here renames the log any more — the prune rewrite that needed the exclusive lock is
// gone, because renumbering a hash chain is not a thing a ledger can honestly do.

/** Lock name shared with the project lock registry (→ `.iterate/.decision-log.lock`). */
const LOG_LOCK_NAME = 'decision-log'

/**
 * Acquire the decision-log lock for `projectRoot`.
 * Returns a release function (always callable; a no-op when the lock could
 * not be taken — never wedge an append behind a vanished holder).
 *
 * `options.waitMs` / `options.staleMs` override the shared defaults (tests use
 * short waits so a live-holder timeout is exercised in milliseconds, not 5s).
 */
export function acquireLogLock(
  projectRoot: string,
  options: { waitMs?: number; staleMs?: number } = {},
): () => void {
  return acquireLogLockChecked(projectRoot, options).release
}

/**
 * {@link acquireLogLock} plus whether the lock was actually TAKEN. Appends stay
 * best-effort on contention; a caller that would mutate the ledger's identity (there is
 * no such caller in this module any more — archive-and-restart renames an UNVERIFIABLE
 * file only) needs the difference.
 *
 * Delegates to the shared `acquireProjectLockChecked` with lock name `decision-log`:
 * the decision-log mutex IS that generic project lock. One implementation, one set of
 * defaults, one ownership-checked release.
 */
export function acquireLogLockChecked(
  projectRoot: string,
  options: { waitMs?: number; staleMs?: number } = {},
): { acquired: boolean; release: () => void } {
  return acquireProjectLockChecked(projectRoot, LOG_LOCK_NAME, options)
}

// ─── Entry-count cache (avoid an O(n) full re-read per append) ─────────────

/**
 * Max distinct log paths tracked by the entry-count cache. The cache is keyed
 * by PATH (one entry per project's log) with no natural eviction — a long-lived
 * process touching many projects would otherwise grow it without bound. A
 * simple insertion-ordered LRU: a hit re-inserts (refreshing recency), a set
 * past the cap evicts the least-recently-used path. Small on purpose: the
 * hot path is one project's log.
 */
export const LOG_COUNT_CACHE_CAP = 64

const entryCountCache = new Map<string, { size: number; count: number }>()

/** LRU-ish get: refresh recency by re-inserting the key. */
function cacheGet(filePath: string): { size: number; count: number } | undefined {
  const hit = entryCountCache.get(filePath)
  if (hit) {
    entryCountCache.delete(filePath)
    entryCountCache.set(filePath, hit)
  }
  return hit
}

/** Insert (or refresh) a cache entry, evicting past LOG_COUNT_CACHE_CAP. */
function cacheSet(filePath: string, value: { size: number; count: number }): void {
  entryCountCache.delete(filePath)
  entryCountCache.set(filePath, value)
  while (entryCountCache.size > LOG_COUNT_CACHE_CAP) {
    const oldest = entryCountCache.keys().next().value
    if (oldest === undefined) break
    entryCountCache.delete(oldest)
  }
}

/** Current cache occupancy (exported for unit tests of the capacity bound). */
export function logCountCacheSize(): number {
  return entryCountCache.size
}

/**
 * Line-count the log file from scratch (entries = non-empty JSON lines).
 * Exported for unit tests.
 *
 * A read failure (file vanished, permission, replaced by a directory) returns
 * `{ ok: false }` with the last KNOWN cached count for this path — or 0 when
 * the path was never counted. The old code returned a fabricated `1` here,
 * which the caller then cached, poisoning the base count for every later
 * append. The `ok` flag lets the caller skip caching a failed read entirely.
 */
export function recountEntries(filePath: string): { count: number; ok: boolean } {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return { count: content.split('\n').filter((l) => l.trim().length > 0).length, ok: true }
  } catch {
    return { count: cacheGet(filePath)?.count ?? 0, ok: false }
  }
}

/**
 * Drop the cached entry count for a log file. The cache is keyed by the log
 * path and assumes "same byte size ⇒ same entry count"; any event that replaces
 * the file wholesale (a migration, an archive-and-restart) lands a DIFFERENT
 * number of entries under the same path, so only an explicit invalidation keeps
 * the fast path honest.
 */
export function invalidateLogCountCache(filePath: string): void {
  entryCountCache.delete(filePath)
}

// ─── Refusals: code + remedy, never a bare Error ────────────────────────────

/**
 * Harness-level refusal codes. The kernel's own codes (`KERNEL_E_*`) propagate
 * unchanged; these two name the cases only a file's HISTORY can produce, so a caller can
 * tell "this ledger is broken" from "a legacy record and the chain are interleaved and I
 * will not guess which side owns the tail". Names mirror the Python side verbatim.
 */
export const DECISION_LOG_ERROR_CODES = {
  interleaved: 'ITERATE_E_DECISION_LOG_INTERLEAVED',
  migration: 'ITERATE_E_DECISION_LOG_MIGRATION',
} as const

export type DecisionLogErrorCode = (typeof DECISION_LOG_ERROR_CODES)[keyof typeof DECISION_LOG_ERROR_CODES]

/** A decision that must not be recorded, carrying a code and an executable remedy. */
export class DecisionLogWriteRefusal extends Error {
  readonly code: string
  readonly remedy: string

  constructor(code: string, message: string, remedy: string) {
    super(`${code}: ${message}`)
    this.name = 'DecisionLogWriteRefusal'
    this.code = code
    this.remedy = remedy
  }
}

/**
 * Everything "this decision cannot be recorded" can raise, so a tool boundary can answer
 * with a code and a remedy instead of letting an exception reach the agent as a crash. The
 * kernel's own classes are in here too: their `code`/`remedy` attributes are the same shape
 * on purpose.
 */
export const DECISION_LOG_REFUSALS = [
  DecisionLogWriteRefusal,
  KernelDecisionLogError,
  KernelDecisionTranscribeError,
] as const

/** Flatten any refusal (ours or the kernel's) into the structured form callers expect. */
function refusalFields(error: unknown): { error: string; code: string; remedy: string } {
  if (
    error instanceof DecisionLogWriteRefusal ||
    error instanceof KernelDecisionLogError ||
    error instanceof KernelDecisionTranscribeError
  ) {
    const carried = error as unknown as { message?: unknown; code?: unknown; remedy?: unknown }
    return {
      error: typeof carried.message === 'string' ? carried.message : String(error),
      code: typeof carried.code === 'string' ? carried.code : 'ITERATE_E_DECISION_LOG_UNKNOWN',
      remedy: typeof carried.remedy === 'string'
        ? carried.remedy
        : 'preserve the ledger file and inspect it before writing again',
    }
  }
  return {
    error: `decision log write failed: ${String(error)}`,
    code: 'ITERATE_E_DECISION_LOG_WRITE',
    remedy: 'report this as a failed write instead of continuing as if the decision had been logged',
  }
}

/**
 * Whether `type` is a decision kind the kernel can carry — SHAPE, not membership.
 *
 * The pattern is the kernel's own export (`DECISION_KIND_PATTERN`,
 * `iterate-kernel/decision-log-entry`), so this module cannot drift from the contract it
 * implements; `test/decision-log.test.ts` pins the pattern's source text against the
 * string both shells were coded from, which is what ends the 8-vs-10 kind divergence.
 */
export const DECISION_KIND_PATTERN: RegExp = KERNEL_DECISION_KIND_PATTERN

export function isDecisionKind(value: unknown): value is string {
  return typeof value === 'string' && DECISION_KIND_PATTERN.test(value)
}

// ─── Line classification and the record projection ──────────────────────────

const CANONICAL_REQUIRED_KEYS = ['entryId', 'sequence', 'prevEntryHash', 'summary', 'outcome', 'createdAt'] as const

export type DecisionLogLineKind = 'legacy' | 'canonical' | 'unknown'

/**
 * `"legacy"` | `"canonical"` | `"unknown"` for one decoded JSONL line.
 *
 * Shape-based, like the kernel's `isLegacyDecisionRecord`: guessing "it has a timestamp"
 * would misclassify the fork's own ledger lines, which also carry one. Mirrors Python's
 * `_classify_line` exactly.
 */
export function classifyDecisionLine(decoded: unknown): DecisionLogLineKind {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return 'unknown'
  const record = decoded as Record<string, unknown>
  if (Object.keys(record).length === 0) return 'unknown'
  if (kernelIsLegacyRecord(record)) return 'legacy'
  const keys = new Set(Object.keys(record))
  return CANONICAL_REQUIRED_KEYS.every((k) => keys.has(k)) ? 'canonical' : 'unknown'
}

/** Every non-empty line of a ledger, paired with its decoded object (`null` when it does not decode). */
function decodedLines(filePath: string): Array<{ raw: string; decoded: unknown }> {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }
  const out: Array<{ raw: string; decoded: unknown }> = []
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue
    let decoded: unknown = null
    try {
      decoded = JSON.parse(raw)
    } catch {
      decoded = null
    }
    out.push({ raw, decoded })
  }
  return out
}

/** The 1-based line number of the first legacy record AFTER the chain began, else `null`. */
export function contestedLedgerLine(filePath: string): number | null {
  const kinds = decodedLines(filePath).map((l) => classifyDecisionLine(l.decoded))
  const firstCanonical = kinds.indexOf('canonical')
  if (firstCanonical === -1) return null
  const trailing = kinds.findIndex((kind, index) => index > firstCanonical && kind === 'legacy')
  return trailing === -1 ? null : trailing + 1
}

/** Project one line (legacy record or canonical entry) into the loop's record shape. */
export function projectDecisionRecord(decoded: unknown): DecisionLogEntry | null {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null
  const line = decoded as Record<string, unknown>
  const kind = classifyDecisionLine(line)

  if (kind === 'legacy') {
    const data = line['data']
    return {
      timestamp: typeof line['timestamp'] === 'string' ? line['timestamp'] : '',
      round: typeof line['round'] === 'number' ? line['round'] : 0,
      type: typeof line['type'] === 'string' ? line['type'] : '',
      data: data !== null && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>) }
        : {},
    }
  }

  if (kind !== 'canonical') return null
  // The inverse of the kernel's transcription on the fields readers actually use:
  // createdAt→timestamp, kind→type, payload→data (rule 3 copied `data` in full, so a
  // report that read a finding list before the flip reads the same list after it).
  const payload = line['payload']
  const round = typeof line['round'] === 'number' ? line['round'] : 0
  return {
    timestamp: typeof line['createdAt'] === 'string' ? line['createdAt'] : '',
    round,
    type: typeof line['kind'] === 'string' ? line['kind'] : '',
    data: payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {},
  }
}

// ─── Timestamps and drafts ──────────────────────────────────────────────────

/**
 * ISO-8601 with an EXPLICIT zone — the same rule both shells transcribe against
 * (`kernel_decision_record.ISO_8601_WITH_ZONE` on the Python side, rule 4 of
 * `iterate-kernel/decision-log-transcribe` on the kernel's).
 *
 * A PATTERN and not `Date.parse`: JS happily guesses US month/day order for a spelling
 * like `11/10/2026 02:28` that Python refuses outright. A ledger whose dates depend on
 * which runtime converted them is not evidence, and the two halves of this contract
 * would migrate the same history two different ways.
 */
const ISO_8601_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

/** Milliseconds since the epoch for a zone-stamped ISO-8601 instant, or `null`. */
export function timestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const m = ISO_8601_WITH_ZONE.exec(raw)
  if (!m) return null
  const [, y, mo, d, h, mi, s, frac, zone] = m
  if (y === undefined || mo === undefined || d === undefined || h === undefined ||
    mi === undefined || s === undefined || zone === undefined) return null
  const millis = (frac ?? '').slice(0, 3).padEnd(3, '0')
  const epochMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(millis))
  if (Number.isNaN(epochMs)) return null
  if (zone === 'Z') return epochMs
  const sign = zone[0] === '+' ? 1 : -1
  const offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  return epochMs - offsetMinutes * 60_000
}

/** Transcribe one record into a ledger draft, with an entry id minted from its OWN instant. */
function draftFor(record: DecisionLogEntry, context: string): DecisionLogDraft {
  const epochMs = timestampMs(record.timestamp)
  if (epochMs === null) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.migration,
      `a decision dated ${JSON.stringify(record.timestamp)} cannot be entered into the ledger (${context})`,
      'the kernel accepts ISO-8601 with an explicit zone; fix the producer\'s timestamp — ' +
        'an entry the ledger cannot date is un-auditable, and minting an id from this machine\'s ' +
        'clock would make the same history hash two different ways',
    )
  }
  // The id is time-ordered from the RECORD's own timestamp (never `Date.now()`), so two
  // runs migrating the same legacy history build the same chain and get the same hashes.
  return kernelDraftFromRecord(
    { timestamp: record.timestamp, round: record.round, type: record.type, data: record.data },
    kernelNewDecisionEntryId(epochMs),
  )
}

// ─── Migration and the contested state ──────────────────────────────────────

/** Write `bytes` to a fresh file at mode 0600, refusing to clobber (O_EXCL + explicit chmod). */
function writeExclusive0600(path: string, bytes: string | Uint8Array): void {
  // The mode argument is masked by the process umask, so `0o600` alone is not the mode it
  // looks like; fchmod after the open states it outright.
  const fd = openSync(path, 'wx', 0o600)
  try {
    fchmodSync(fd, 0o600)
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes)
    let written = 0
    while (written < buffer.length) written += writeSync(fd, buffer, written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** `20261020T010203004567Z` — sortable, zone-stamped, collision-unlikely suffix for archives/backups. */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\./g, '')
}

/**
 * Rewrite an all-legacy log as a verified chain, keeping the original bytes.
 *
 * Refuses rather than improvises: any record the kernel will not transcribe stops the
 * whole migration, because a ledger that silently omits the line it could not read is a
 * ledger whose gaps are invisible. The new text is verified BEFORE it replaces anything
 * (same order the Python side uses: build → verify → backup → swap).
 */
function migrateToLedger(filePath: string, records: DecisionLogEntry[]): void {
  let sequence = 0
  let prevHash = ''
  const lines: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as DecisionLogEntry
    try {
      const entry = kernelBuildLedgerEntry(draftFor(record, `line ${index + 1}`), {
        sequence,
        prevEntryHash: prevHash,
      })
      prevHash = kernelLedgerEntryHash(entry)
      sequence += 1
      lines.push(kernelSerializeLedgerEntry(entry))
    } catch (error) {
      if (error instanceof DecisionLogWriteRefusal) throw error
      const { code, error: message, remedy } = refusalFields(error)
      throw new DecisionLogWriteRefusal(
        code === 'ITERATE_E_DECISION_LOG_MIGRATION' ? code : DECISION_LOG_ERROR_CODES.migration,
        `line ${index + 1} of ${filePath} cannot be transcribed into the ledger: ${message}`,
        `the ledger will not start on top of a record it cannot read (${code}) — preserve the file, ` +
          `repair that line's timestamp/payload/kind, then write again. ${remedy}`,
      )
    }
  }

  const body = `${lines.map((line) => `${line}\n`).join('')}`
  const check = kernelVerifyLedgerText(body)
  if (!check.ok || check.entries.length !== records.length) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.migration,
      `the migrated chain does not verify (${check.reason ?? 'unknown reason'})`,
      `nothing was written; keep ${filePath} as it is and investigate line ${check.firstBrokenLine ?? '?'}`,
    )
  }

  // Verified first, backup second, swap last: an interrupted migration can always be
  // replayed from the 0600 original, and the file on disk is never an unverified chain.
  let original: Buffer
  try {
    original = readFileSync(filePath)
  } catch (error) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.migration,
      `the legacy ledger could not be read for backup: ${String(error)}`,
      `nothing was written; fix access to ${filePath} — this is evidence, so repair it rather than deleting it`,
    )
  }
  const backup = `${filePath.replace(/\.jsonl$/, '')}.pre-ledger-${utcStamp(new Date())}.jsonl.bak`
  try {
    writeExclusive0600(backup, original)
    const temp = `${filePath}.migrating-${process.pid}`
    writeExclusive0600(temp, body)
    renameSync(temp, filePath)
  } catch (error) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.migration,
      `the migrated chain could not be swapped in: ${String(error)}`,
      `the original is preserved at ${backup}; nothing was lost — repair the directory and write again`,
    )
  } finally {
    invalidateLogCountCache(filePath)
  }
}

/**
 * Move a ledger whose legacy lines follow the chain aside, without losing a byte.
 *
 * This is the HUMAN's action after the `…INTERLEAVED` refusal, and it is the only safe
 * one: the chain cannot be renumbered and the foreign lines cannot be left inside a file
 * the ledger has to verify. The archive keeps the original bytes at mode 0600 under a name
 * that says what it is, and the next `appendDecisionEntry` starts a fresh chain — a
 * restart of continuity somebody chose, rather than a silent repair this module could not
 * do honestly.
 *
 * Refuses when the log is NOT contested, because otherwise this would be a way to erase a
 * healthy chain by accident; an all-legacy log is refused too, because it migrates.
 */
export function archiveContestedDecisionLog(projectRoot: string): string {
  const filePath = decisionLogPath(projectRoot)
  const contested = contestedLedgerLine(filePath)
  if (contested === null) {
    const kinds = decodedLines(filePath).map((l) => classifyDecisionLine(l.decoded))
    const allLegacy = kinds.length > 0 && kinds.every((k) => k === 'legacy')
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.interleaved,
      `${filePath} is not a contested ledger`,
      allLegacy
        ? 'this log is ALL legacy records and nothing has to be settled: it migrates onto the chain on the next write, keeping a 0600 backup of the original'
        : 'archiving is only for a log whose legacy lines FOLLOW the chain (the first one is none here): a healthy ledger would lose its continuity to this call',
    )
  }
  const archive = `${filePath.replace(/\.jsonl$/, '')}.contested-${utcStamp(new Date())}.jsonl`
  try {
    renameSync(filePath, archive)
    chmodSync(archive, 0o600)
  } catch (error) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.interleaved,
      `the contested ledger could not be moved aside: ${String(error)}`,
      `nothing was deleted; ${filePath} is still in place — fix the directory permissions and choose archive-and-restart again`,
    )
  } finally {
    invalidateLogCountCache(filePath)
  }
  return archive
}

/** 1-based line of the first legacy record after the chain began, or `null` (exported for tools/tests). */
export function decisionLogContestedLine(projectRoot: string): number | null {
  return contestedLedgerLine(decisionLogPath(projectRoot))
}

/**
 * Resolve the log file path, creating the directory if needed.
 *
 * A directory this function creates is set to `0700` with an explicit `chmod`: the ledger
 * refuses a group/other-writable parent (anyone could replace the whole chain) and
 * `mkdir`'s mode argument is masked by the process umask, so passing `0o700` alone would
 * not be the mode it looks like.
 *
 * An ALREADY-EXISTING directory is only touched when it is group/other-WRITABLE, and then
 * just enough to clear those two write bits: that is the condition the kernel's own
 * location check refuses on, and the directory may also have been created by the project
 * lock helper (which mkdirs `.iterate/` itself), so "fresh" is not the only path to a
 * writable parent. Anything else — an owner's deliberate 0750 — is left alone.
 */
function logPath(projectRoot: string): string {
  const dir = join(projectRoot, LOG_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    try {
      chmodSync(dir, 0o700)
    } catch {
      // A chmod we cannot perform is reported by the kernel's own location check on the
      // next append (mode is still whatever the umask allowed); it must not become a
      // crash here, before the ledger has even been looked at.
    }
    return join(dir, LOG_FILE)
  }
  try {
    const mode = statSync(dir).mode & 0o777
    if ((mode & 0o022) !== 0) chmodSync(dir, mode & ~0o022)
  } catch {
    // Same reasoning as above: unreadable/unchmodable is the ledger's problem to report,
    // not this function's to crash on.
  }
  return join(dir, LOG_FILE)
}

/**
 * Migrate an all-legacy ledger and refuse a contested one, so the next kernel append
 * lands on a chain this file can verify. Any refusal is a `DecisionLogWriteRefusal`.
 */
function prepareLedger(filePath: string): void {
  const lines = decodedLines(filePath)
  const kinds = lines.map((l) => classifyDecisionLine(l.decoded))
  if (lines.length > 0 && kinds.every((k) => k === 'legacy')) {
    migrateToLedger(
      filePath,
      lines.map((l) => l.decoded as DecisionLogEntry),
    )
  }
  const contested = contestedLedgerLine(filePath)
  if (contested !== null) {
    throw new DecisionLogWriteRefusal(
      DECISION_LOG_ERROR_CODES.interleaved,
      `line ${contested} of ${filePath} is a legacy record appended after the chain began`,
      'this cannot be repaired in place: re-deriving a line that already carries a hash forges it, ' +
        'and leaving it means the ledger stays unverifiable. Either flip the writer that produced it, ' +
        'or archive the contested log losslessly and start the chain again — ' +
        '`iterate_decision_log({operation:"archive"})` / `archiveContestedDecisionLog(projectRoot)`. ' +
        'Nothing is deleted either way.',
    )
  }
}

/**
 * The structured form every `appendDecisionEntry` failure takes.
 *
 * The `failed to append decision log` prefix is the contract callers (fix, prune, the tool
 * boundary, the F8 tests) have always matched on; the kernel's own message rides inside it
 * together with its code and remedy, so a refusal is both greppable and actionable — never
 * a bare Error, never swallowed.
 */
function appendFailure(err: unknown, path: string): {
  count: number
  path: string
  error: string
  code: string
  remedy: string
} {
  const refusal = refusalFields(err)
  return {
    count: 0,
    path,
    error: `failed to append decision log: ${refusal.error}`,
    code: refusal.code,
    remedy: refusal.remedy,
  }
}

/**
 * Append one decision to the ledger as a canonical, hash-chained entry.
 *
 * Returns `{ count, path }` — `count` counts every readable line, legacy or canonical,
 * because that is what the reports iterate over. NEVER throws: a refusal (bad kind, an
 * un-migratable legacy line, a contested log, a broken tail, a torn write) comes back as
 * `{ error, code, remedy }`, and a disk failure is surfaced the same way so callers
 * (fix/prune) can report the audit-trail miss without failing the mutation they already
 * performed.
 *
 * The chain fields (`sequence`, `prevEntryHash`) are supplied by the LEDGER through the
 * kernel's append, never by the caller; the kernel reads back and re-verifies what it
 * wrote, so an interleaved second writer is DETECTED and reported rather than silently
 * chained onto.
 */
export function appendDecisionEntry(
  projectRoot: string,
  entry: DecisionLogEntry,
): { count: number; path: string; error?: string; code?: string; remedy?: string } {
  // Kind grammar BEFORE any disk access: a refusal must not leave a state directory
  // behind as the only evidence that something was attempted.
  if (!isDecisionKind(entry.type)) {
    return {
      count: 0,
      path: decisionLogPath(projectRoot),
      ...refusalFields(
        new DecisionLogWriteRefusal(
          'KERNEL_E_DECISION_KIND',
          `${JSON.stringify(entry.type)} is not a decision kind the kernel can carry`,
          'a kind is lowercase snake_case up to 32 characters (`^[a-z][a-z0-9_]{0,31}$`); ' +
            'it is not renamed or case-folded, because two ecosystems must be able to compare it. ' +
            `This plugin's own kinds are ${KNOWN_DECISION_KINDS.join(', ')} — that list is a label, not a gate.`,
        ),
      ),
    }
  }

  // The ledger directory is resolved BEFORE the lock is taken: `acquireProjectLockChecked`
  // mkdirs `.iterate/` itself, and if it got there first the directory would carry
  // whatever mode the umask produced instead of the 0700 this ledger asks for. A mkdir
  // failure (EACCES, ENOTDIR when an ancestor is a regular file) is reported in the same
  // structured form — `appendDecisionEntry` must never throw out of a caller that already
  // performed its mutation.
  let filePath: string
  try {
    filePath = logPath(projectRoot)
  } catch (err) {
    return appendFailure(err, decisionLogPath(projectRoot))
  }

  const release = acquireLogLock(projectRoot)
  try {
    try {
      prepareLedger(filePath)
      const draft = draftFor(entry, 'this append')
      const appended = kernelAppendLedgerEntry(filePath, draft)
      // The kernel wrote `bytesWritten` (line + newline) and verified the read-back. The
      // size the file had BEFORE this append is therefore today's size minus that line —
      // which is what the count cache keys on.
      const afterSize = statSync(filePath).size
      const prevSize = Math.max(0, afterSize - appended.bytesWritten)
      // Count entries via the size/count cache: when nothing else changed the file since
      // our last append (same byte size), count is just +1 — no full re-read. Falls back
      // to a full re-count whenever the cache is stale.
      const cached = cacheGet(filePath)
      let count: number
      if (cached && cached.size === prevSize) {
        count = cached.count + 1
      } else {
        const recounted = recountEntries(filePath)
        if (!recounted.ok) {
          // The append LANDED but the read-back failed (file vanished / replaced
          // mid-call). Report the best count we actually know and DO NOT touch the
          // cache: caching a failed read under the new byte size would poison every
          // later append's count.
          return { count: recounted.count, path: filePath }
        }
        count = recounted.count
      }
      cacheSet(filePath, { size: afterSize, count })
      return { count, path: filePath }
    } catch (err) {
      return appendFailure(err, filePath)
    }
  } finally {
    release()
  }
}

/**
 * Detailed log read: valid entries plus the number of corrupt lines that were
 * skipped, so callers can surface silent audit-trail loss to the model/UI.
 */
export interface DecisionLogRead {
  entries: DecisionLogEntry[]
  invalidLines: number
}

/**
 * Read all entries from the decision log, plus the count of unreadable lines.
 *
 * Both shapes are PROJECTED to the loop's record view (`projectDecisionRecord`), so every
 * reader keeps the fields it has always read. A canonical line is projected, NOT verified:
 * this reader answers "what did the loop decide", and `verifyDecisionLedger` is what
 * answers "is this ledger intact" — a report must not be silenced by a broken chain link.
 * A line that decodes to NEITHER shape is skipped, never fatal, but counted.
 */
export function readDecisionLogDetailed(projectRoot: string): DecisionLogRead {
  const filePath = decisionLogPath(projectRoot)
  if (!existsSync(filePath)) return { entries: [], invalidLines: 0 }
  const entries: DecisionLogEntry[] = []
  let invalidLines = 0
  for (const line of decodedLines(filePath)) {
    const view = projectDecisionRecord(line.decoded)
    if (view === null) {
      invalidLines += 1
      continue
    }
    entries.push(view)
  }
  return { entries, invalidLines }
}

/**
 * Read all entries from the decision log.
 * A single corrupt line (partial write, hand-edit) is SKIPPED, not fatal —
 * one bad line must never empty the whole history for every reader.
 */
export function readDecisionEntries(projectRoot: string): DecisionLogEntry[] {
  return readDecisionLogDetailed(projectRoot).entries
}

/**
 * Verify the ledger's hash chain (the kernel's own read-back). A report should not need
 * this; an auditor does. A missing file is an empty chain, not an error.
 */
export function verifyDecisionLedger(projectRoot: string): {
  ok: boolean
  entries: number
  firstBrokenLine?: number
  brokenKind?: 'corrupt' | 'chain'
  reason?: string
  error?: string
  code?: string
  remedy?: string
} {
  const filePath = decisionLogPath(projectRoot)
  try {
    const lines = decodedLines(filePath)
    const body = `${lines.map((l) => l.raw).join('\n')}${lines.length > 0 ? '\n' : ''}`
    const verified = kernelVerifyLedgerText(body)
    return {
      ok: verified.ok,
      entries: verified.entries.length,
      firstBrokenLine: verified.firstBrokenLine,
      brokenKind: verified.brokenKind,
      reason: verified.reason,
    }
  } catch (err) {
    return { ok: false, entries: 0, ...refusalFields(err) }
  }
}

/**
 * Register the `iterate_decision_log` tool.
 * Append-only decision ledger stored in .iterate/decision-log.jsonl as a kernel
 * hash chain. Supports `append`, `read`, `verify` and the human-chosen `archive`.
 */
export function registerDecisionLogTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_decision_log',
      // `read`/`verify` never write; `append`/`archive` extend (or settle) the audit
      // ledger → only read joins a parallel dispatch group.
      isConcurrencySafe: (args) => {
        const operation = (args as { operation?: unknown }).operation
        return operation === 'read' || operation === 'verify'
      },
      description:
        'Append-only decision ledger for the iterate loop, stored as a hash-chained JSONL ledger ' +
        '(each line is canonical JSON; `prevEntryHash` is the sha256 of the previous line). ' +
        'Use `append` to record a round start, review finding, fix, validation result, or decision — ' +
        'the chain fields come from the ledger, never from the caller. ' +
        'Use `read` to retrieve the loop\'s record view of every entry, `verify` to check the chain. ' +
        'Use `archive` ONLY when an append reports ITERATE_E_DECISION_LOG_INTERLEAVED: it moves the ' +
        'contested ledger aside losslessly (0600) so the next append starts a clean chain. ' +
        'The ledger can never be renumbered, edited or age-trimmed in place. ' +
        'The log is stored in .iterate/decision-log.jsonl and persists across sessions.',

      parameters: {
        operation: {
          type: 'string',
          required: true,
          description:
            '"append" to add an entry, "read" to retrieve all entries, "verify" to check the ' +
            'hash chain, "archive" to move a CONTESTED ledger aside and restart the chain.',
          enum: ['append', 'read', 'verify', 'archive'],
        },
        type: {
          type: 'string',
          description:
            'Decision kind (required for append): lowercase snake_case, at most 32 characters ' +
            '(`^[a-z][a-z0-9_]{0,31}$`). This plugin emits ' +
            `${KNOWN_DECISION_KINDS.join(', ')} — that is a label list, not a closed set: a ` +
            'well-formed kind either shell produces is accepted, because the kernel owns the ' +
            'GRAMMAR and each ecosystem owns its vocabulary.',
        },
        round: {
          type: 'integer',
          description: 'Current iteration round number (required for append).',
        },
        data: {
          type: 'json',
          description: 'Entry payload as JSON object (required for append). Copied into the entry\'s `payload` in full.',
        },
        path: {
          type: 'string',
          description: 'Project root directory (default: current working directory).',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: { type: 'string', required: true },
            entryCount: { type: 'integer' },
            invalidLines: { type: 'integer' },
            logPath: { type: 'string' },
            entries: { type: 'json' },
            success: { type: 'boolean' },
            entry: { type: 'json' },
            archivePath: { type: 'string' },
            chain: { type: 'json' },
            error: { type: 'string' },
            code: { type: 'string' },
            remedy: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) {
          return { operation: args.operation, error: resolved.reason }
        }
        const projectRoot = resolved.root

        if (args.operation === 'read') {
          const { entries, invalidLines } = readDecisionLogDetailed(projectRoot)
          return {
            operation: 'read',
            entryCount: entries.length,
            invalidLines,
            logPath: decisionLogPath(projectRoot),
            entries: entries as unknown as JsonValue,
          }
        }

        if (args.operation === 'verify') {
          const chain = verifyDecisionLedger(projectRoot)
          return {
            operation: 'verify',
            success: chain.ok,
            entryCount: chain.entries,
            logPath: decisionLogPath(projectRoot),
            chain: chain as unknown as JsonValue,
            ...(chain.error !== undefined ? { error: chain.error, code: chain.code, remedy: chain.remedy } : {}),
          }
        }

        if (args.operation === 'archive') {
          try {
            const archivePath = archiveContestedDecisionLog(projectRoot)
            return { operation: 'archive', success: true, archivePath, logPath: decisionLogPath(projectRoot) }
          } catch (err) {
            return { operation: 'archive', success: false, ...refusalFields(err) }
          }
        }

        if (args.operation === 'append') {
          const invalid = validateAppendInput(args.type, args.round, args.data)
          if (invalid !== null) {
            return { operation: 'append', success: false, ...invalid }
          }
          const entry: DecisionLogEntry = {
            timestamp: new Date().toISOString(),
            round: args.round as number,
            type: args.type as string,
            data: args.data === undefined || args.data === null
              ? {}
              : args.data as Record<string, unknown>,
          }

          const result = appendDecisionEntry(projectRoot, entry)
          if (result.error) {
            return {
              operation: 'append',
              success: false,
              entryCount: 0,
              logPath: result.path,
              error: result.error,
              code: result.code,
              remedy: result.remedy,
            }
          }
          return {
            operation: 'append',
            success: true,
            entryCount: result.count,
            logPath: result.path,
            entry: entry as unknown as JsonValue,
          }
        }

        return {
          operation: args.operation,
          error: `Unknown operation "${args.operation}". Use "append", "read", "verify" or "archive".`,
        }
      },
    }),
  )
}

/**
 * Validate a candidate (type, round, data) triple for an append operation.
 * Returns a refusal (code + remedy) on failure, or null when the entry is well-formed.
 *
 * `type` is checked against the KERNEL GRAMMAR here, not a list: an unknown-but-well-formed
 * kind is a decision this shell has not seen, not a malformed one.
 */
function validateAppendInput(
  type: unknown,
  round: unknown,
  data: unknown,
): { error: string; code: string; remedy: string } | null {
  if (!isDecisionKind(type)) {
    return refusalFields(
      new DecisionLogWriteRefusal(
        'KERNEL_E_DECISION_KIND',
        `${JSON.stringify(type)} is not a decision kind the kernel can carry`,
        'a kind is lowercase snake_case up to 32 characters (`^[a-z][a-z0-9_]{0,31}$`); it is not ' +
          `renamed or case-folded, because two ecosystems must be able to compare it. This plugin emits ` +
          `${KNOWN_DECISION_KINDS.join(', ')} and a new well-formed kind needs no release.`,
      ),
    )
  }
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    return {
      code: 'ITERATE_E_DECISION_ROUND',
      error: 'round must be a positive integer.',
      remedy: 'pass the round the loop is on; the kernel allows 0 and above, this tool requires 1+ ' +
        'so a report can locate the decision in a run',
    }
  }
  if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    return {
      code: 'KERNEL_E_DECISION_RECORD',
      error: 'data must be an object (or omitted).',
      remedy: 'pass the payload as a JSON object; transcription copies it into `payload` in full',
    }
  }
  return null
}
