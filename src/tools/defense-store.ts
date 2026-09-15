/**
 * src/tools/defense-store.ts — defense event storage layer.
 *
 * Provides read/write access to defense events stored in
 * .iterate/defense-events.json. Events are accumulated during iteration.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { iterateDir } from '../paths.ts'
import { writeJsonAtomic } from '../atomic-fs.ts'
import type { DefenseEvent, DefenseEventStream, DefenseEventType } from '../types.ts'

const DEFENSE_EVENTS_FILE = 'defense-events.json'

/** Valid defense event types (must stay in sync with DefenseEventType). */
const VALID_EVENT_TYPES: ReadonlySet<DefenseEventType> = new Set<DefenseEventType>([
  'precondition_failed',
  'rollback',
  'invariant_violated',
  'assumption_falsified',
])

/**
 * Bump the count for an event type. Unknown types (malformed JSON on disk,
 * or a caller passing an untyped value) are ignored rather than crashing or
 * creating garbage keys in the counts object.
 */
function bumpCount(counts: Record<DefenseEventType, number>, type: unknown): void {
  if (typeof type === 'string' && VALID_EVENT_TYPES.has(type as DefenseEventType)) {
    counts[type as DefenseEventType]++
  }
}

/** Default empty defense event stream. */
function emptyStream(): DefenseEventStream {
  return {
    events: [],
    lastUpdated: new Date().toISOString(),
    counts: {
      precondition_failed: 0,
      rollback: 0,
      invariant_violated: 0,
      assumption_falsified: 0,
    },
  }
}

/** Valid severity values (kept in sync with DefenseEvent). */
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])

/**
 * Normalize one persisted event. Hand-edited files can carry events missing
 * `timestamp`/`round`/`description`/`defense`/`outcome`/`severity` — readers
 * (list sort by timestamp, render label selection) must never crash or emit
 * NaN for those. Returns null when the entry is not an object or has no usable
 * `type`; otherwise fills every required field with a safe default.
 */
function normalizeEvent(raw: unknown): DefenseEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  if (typeof e.type !== 'string' || !VALID_EVENT_TYPES.has(e.type as DefenseEventType)) return null
  return {
    id: typeof e.id === 'string' && e.id ? e.id : `def-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: typeof e.timestamp === 'string' && e.timestamp ? e.timestamp : new Date().toISOString(),
    round: typeof e.round === 'number' && Number.isFinite(e.round) ? Math.floor(e.round) : 0,
    type: e.type as DefenseEventType,
    description: typeof e.description === 'string' ? e.description : '',
    defense: typeof e.defense === 'string' ? e.defense : '',
    outcome: typeof e.outcome === 'string' ? e.outcome : '',
    ...(typeof e.file === 'string' && e.file.length > 0 ? { file: e.file } : {}),
    ...(typeof e.line === 'number' && Number.isFinite(e.line) && e.line >= 0 ? { line: e.line } : {}),
    severity: VALID_SEVERITIES.has(String(e.severity)) ? (e.severity as DefenseEvent['severity']) : 'low',
  }
}

/**
 * Read the defense events stream from disk.
 * Normalizes the persisted stream so a hand-edited / partial file can never
 * produce NaN counts: `counts` is recomputed from the events when missing or
 * malformed, every type key is guaranteed present, and every surviving event is
 * shape-normalized so consumers (timestamp sort, render label selection) cannot
 * throw on missing fields.
 */
export function readDefenseEvents(projectRoot: string): DefenseEventStream {
  const filePath = path.join(projectRoot, '.iterate', DEFENSE_EVENTS_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<DefenseEventStream>
    if (parsed && Array.isArray(parsed.events)) {
      const events = parsed.events
        .map(normalizeEvent)
        .filter((e): e is DefenseEvent => e !== null)
      const counts = computeCounts(events)
      return {
        events,
        lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : emptyStream().lastUpdated,
        counts,
      }
    }
  } catch {
    // File not found or invalid JSON
  }
  return emptyStream()
}

/**
 * Write the defense events stream to disk.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` when the write
 * fails — a caller must surface the failure instead of reporting success for
 * an event that was never persisted.
 */
export function writeDefenseEvents(
  projectRoot: string,
  stream: DefenseEventStream,
): { ok: true } | { ok: false; error: string } {
  const dirPath = iterateDir(projectRoot)
  const filePath = path.join(dirPath, DEFENSE_EVENTS_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    // Atomic (temp + rename): a crash mid-write can never leave a truncated
    // defense event stream behind.
    writeJsonAtomic(filePath, stream)
  } catch (err) {
    return { ok: false, error: `unable to write ${filePath}: ${String(err)}` }
  }
  return { ok: true }
}

/**
 * Clear the persisted defense-event stream (`.iterate/defense-events.json`).
 * Mirrors `clearQualityGate` in quality-store.ts: a stale event stream from a
 * previous iteration must be resettable before a fresh run. Returns whether a
 * file existed and was removed, or a structured error when removal fails.
 */
export function clearDefenseEvents(
  projectRoot: string,
): { ok: true; existed: boolean } | { ok: false; error: string } {
  const filePath = path.join(iterateDir(projectRoot), DEFENSE_EVENTS_FILE)
  const existed = fs.existsSync(filePath)
  if (!existed) return { ok: true, existed: false }
  try {
    fs.rmSync(filePath, { force: true })
  } catch (err) {
    return { ok: false, error: `unable to remove ${filePath}: ${String(err)}` }
  }
  return { ok: true, existed: true }
}

/** Add a defense event to the stream. */
export function addDefenseEvent(
  stream: DefenseEventStream,
  event: Omit<DefenseEvent, 'id' | 'timestamp'>
): DefenseEventStream {
  const id = `def-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const newEvent: DefenseEvent = {
    id,
    timestamp: new Date().toISOString(),
    ...event,
  }

  // Always recompute from the events array instead of mutating a possibly
  // stale/malformed persisted `counts` object — guarantees the stream counts
  // can never drift from (or NaN out against) its events.
  const newCounts = computeCounts(stream.events)
  bumpCount(newCounts, event.type)

  return {
    events: [...stream.events, newEvent],
    lastUpdated: new Date().toISOString(),
    counts: newCounts,
  }
}

/** Compute counts from events array (for consistency). */
export function computeCounts(events: DefenseEvent[]): Record<DefenseEventType, number> {
  const counts: Record<DefenseEventType, number> = {
    precondition_failed: 0,
    rollback: 0,
    invariant_violated: 0,
    assumption_falsified: 0,
  }

  for (const event of events) {
    bumpCount(counts, event.type)
  }

  return counts
}