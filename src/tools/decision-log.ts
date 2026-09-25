import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import type { DecisionLogEntry } from '../types.ts'

const LOG_DIR = '.iterate'
const LOG_FILE = 'decision-log.jsonl'

// ─── Cross-process log mutex ────────────────────────────────────────────────
//
// The prune rewrite (temp + atomic rename) can silently discard an audit line
// from a CONCURRENT appender whose fd was opened against the pre-rename inode:
// the appender writes to the unlinked inode, the post-rewrite re-read sees a
// "stable" file, and the fresh entry is lost. In-process safety is guaranteed
// by synchronous I/O, but a second plugin process appending to the same
// project realises the race. The log is serialized with a tiny advisory lock
// file (exclusive create, pid stamped, stale-stealable) so `append` and the
// prune rewrite mutually exclude across processes. Best-effort: contention
// timeouts degrade to "proceed unlocked" (the bounded retry loop in prune.ts
// stays as defense-in-depth), never to a crash.

const LOCK_FILE = '.decision-log.lock'
const LOCK_WAIT_MS = 5000
const LOCK_STALE_MS = 10000
const LOCK_POLL_MS = 25

/** True when a pid refers to a live process (or we lack permission to tell). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Synchronous busy-wait sleep (Atomics.wait is a reliable sleep in Node). */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

/**
 * Acquire the decision-log lock for `projectRoot`.
 * Returns a release function (always callable; a no-op when the lock could
 * not be taken — never wedge an append behind a vanished holder).
 */
export function acquireLogLock(projectRoot: string): () => void {
  const dir = join(projectRoot, LOG_DIR)
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return () => {}
    }
  }
  const lockPath = join(dir, LOCK_FILE)
  const start = Date.now()
  for (;;) {
    let fd: number | null = null
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {}
      // Lock exists — steal it when the owner is gone or the lock is ancient.
      let stale = false
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true
        else {
          const pid = Number(readFileSync(lockPath, 'utf-8'))
          if (!processAlive(pid)) stale = true
        }
      } catch {
        stale = true // unreadable/vanishing lock → retry as stale
      }
      if (stale) {
        try { unlinkSync(lockPath) } catch { /* another holder stole it */ }
        continue
      }
      if (Date.now() - start > LOCK_WAIT_MS) return () => {}
      sleepSync(LOCK_POLL_MS)
      continue
    }
    // Owned the lock: stamp the holder pid, then release once on return.
    try { writeSync(fd, String(process.pid)) } catch { /* pid stamp is advisory */ }
    try { closeSync(fd) } catch { /* best-effort */ }
    let released = false
    return () => {
      if (released) return
      released = true
      try { unlinkSync(lockPath) } catch { /* already gone */ }
    }
  }
}

// ─── Entry-count cache (avoid an O(n) full re-read per append) ─────────────

const entryCountCache = new Map<string, { size: number; count: number }>()

/** Line-count the log file from scratch (entries = non-empty JSON lines). */
function recountEntries(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content.split('\n').filter((l) => l.trim().length > 0).length
  } catch {
    return 1
  }
}

/**
 * Drop the cached entry count for a log file. The cache is keyed by the log
 * path and assumes "same byte size ⇒ same entry count"; a prune rewrite
 * (temp + atomic rename) replaces the file with a DIFFERENT number of entries,
 * so only a stale-cache invalidation keeps the fast path honest. Without it, a
 * rewrite that lands on the exact same byte size as the previous append would
 * make the next append report a wrong `count`.
 */
export function invalidateLogCountCache(filePath: string): void {
  entryCountCache.delete(filePath)
}

/** All valid DecisionLogEntry `type` values (must stay in sync with Types). */
const VALID_ENTRY_TYPES = new Set<DecisionLogEntry['type']>([
  'round_start',
  'review_result',
  'atomic_fix',
  'architectural_fix',
  'revert',
  'round_failed',
  'validation',
  'decision',
  'report',
  'resume',
])

/**
 * Validate a candidate (type, round, data) triple for an append operation.
 * Returns an error string on failure, or null when the entry is well-formed.
 */
function validateEntryInput(type: unknown, round: unknown, data: unknown): string | null {
  if (typeof type !== 'string' || !VALID_ENTRY_TYPES.has(type as DecisionLogEntry['type'])) {
    return `type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}.`
  }
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    return 'round must be a positive integer.'
  }
  if (data !== undefined && data !== null && typeof data !== 'object') {
    return 'data must be an object (or omitted).'
  }
  return null
}

/**
 * Resolve the log file path, creating the directory if needed.
 */
function logPath(projectRoot: string): string {
  const dir = join(projectRoot, LOG_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, LOG_FILE)
}

/**
 * Append one entry to the decision log (JSONL format).
 * Returns the entry count after appending. Never throws — a disk failure is
 * surfaced through `error` so callers (fix/prune) can report the audit-trail
 * miss without failing the mutation they already performed.
 */
export function appendDecisionEntry(projectRoot: string, entry: DecisionLogEntry): { count: number; path: string; error?: string } {
  // Serialize with the cross-process log lock so an append can never interleave
  // with a prune rewrite (which renames the file under us).
  const release = acquireLogLock(projectRoot)
  try {
    const filePath = logPath(projectRoot)
    try {
      const line = JSON.stringify(entry) + '\n'
      const prevSize = existsSync(filePath) ? statSync(filePath).size : 0
      appendFileSync(filePath, line, 'utf-8')
      // Count entries via the size/count cache: when nothing else changed the
      // file since our last append (same byte size), count is just +1 — no full
      // re-read. Falls back to a full re-count whenever the cache is stale.
      const cached = entryCountCache.get(filePath)
      const count = cached && cached.size === prevSize
        ? cached.count + 1
        : recountEntries(filePath)
      entryCountCache.set(filePath, { size: existsSync(filePath) ? statSync(filePath).size : prevSize, count })
      return { count, path: filePath }
    } catch (err) {
      return { count: 0, path: join(projectRoot, LOG_DIR, LOG_FILE), error: `failed to append decision log: ${String(err)}` }
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
 * Read all entries from the decision log, plus the count of corrupt lines.
 * A single corrupt line (partial write, hand-edit) is SKIPPED, not fatal —
 * one bad line must never empty the whole history for every reader — but it
 * is counted in `invalidLines` so it never disappears silently.
 */
export function readDecisionLogDetailed(projectRoot: string): DecisionLogRead {
  const filePath = join(projectRoot, LOG_DIR, LOG_FILE)
  if (!existsSync(filePath)) return { entries: [], invalidLines: 0 }
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return { entries: [], invalidLines: 0 }
  }
  const entries: DecisionLogEntry[] = []
  let invalidLines = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        parsed === null || typeof parsed !== 'object' ||
        typeof (parsed as { timestamp?: unknown }).timestamp !== 'string' ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        invalidLines += 1
        continue
      }
      entries.push(parsed as DecisionLogEntry)
    } catch {
      invalidLines += 1
    }
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
 * Register the `iterate_decision_log` tool.
 * Append-only decision log stored in .iterate/decision-log.jsonl.
 * Supports `append` and `read` operations.
 */
export function registerDecisionLogTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_decision_log',
      // `read` never writes; `append` extends the audit log → only read joins
      // a parallel dispatch group.
      isConcurrencySafe: (args) => (args as { operation?: unknown }).operation === 'read',
      description:
        'Append-only decision log for the iterate loop. ' +
        'Use `append` to record a round start, review finding, fix, validation result, or decision. ' +
        'Use `read` to retrieve all entries for review. ' +
        'The log is stored in .iterate/decision-log.jsonl and persists across sessions.',

      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"append" to add an entry, "read" to retrieve all entries.',
          enum: ['append', 'read'],
        },
        type: {
          type: 'string',
          description:
            'Entry type (required for append): round_start, review_result, atomic_fix, ' +
            'architectural_fix, revert, round_failed, validation, decision, report, resume.',
          enum: [
            'round_start',
            'review_result',
            'atomic_fix',
            'architectural_fix',
            'revert',
            'round_failed',
            'validation',
            'decision',
            'report',
            'resume',
          ],
        },
        round: {
          type: 'integer',
          description: 'Current iteration round number (required for append).',
        },
        data: {
          type: 'json',
          description: 'Entry payload as JSON object (required for append).',
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
            error: { type: 'string' },
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
            logPath: join(projectRoot, LOG_DIR, LOG_FILE),
            entries: entries as unknown as JsonValue,
          }
        }

        if (args.operation === 'append') {
          const invalid = validateEntryInput(args.type, args.round, args.data)
          if (invalid !== null) {
            return {
              operation: 'append',
              error: invalid,
            }
          }
          const type = args.type as DecisionLogEntry['type']
          const round = args.round as number
          const data = args.data === undefined || args.data === null
            ? {}
            : args.data as Record<string, unknown>

          const entry: DecisionLogEntry = {
            timestamp: new Date().toISOString(),
            round,
            type,
            data,
          }

          const result = appendDecisionEntry(projectRoot, entry)
          if (result.error) {
            return {
              operation: 'append',
              success: false,
              entryCount: 0,
              logPath: result.path,
              error: result.error,
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
          error: `Unknown operation "${args.operation}". Use "append" or "read".`,
        }
      },
    }),
  )
}