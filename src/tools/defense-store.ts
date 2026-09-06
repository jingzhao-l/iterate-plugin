/**
 * src/tools/defense-store.ts — defense event storage layer.
 *
 * Provides read/write access to defense events stored in
 * .iterate/defense-events.json. Events are accumulated during iteration.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
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

/**
 * Read the defense events stream from disk.
 * Normalizes the persisted stream so a hand-edited / partial file can never
 * produce NaN counts: `counts` is recomputed from the events when missing or
 * malformed, and every type key is guaranteed present.
 */
export function readDefenseEvents(projectRoot: string): DefenseEventStream {
  const filePath = path.join(projectRoot, '.iterate', DEFENSE_EVENTS_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<DefenseEventStream>
    if (parsed && Array.isArray(parsed.events)) {
      const events = parsed.events.filter(
        (e): e is DefenseEvent =>
          !!e && typeof e === 'object' && typeof (e as DefenseEvent).type === 'string',
      )
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
  const dirPath = path.join(projectRoot, '.iterate')
  const filePath = path.join(dirPath, DEFENSE_EVENTS_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(stream, null, 2), 'utf-8')
  } catch (err) {
    return { ok: false, error: `unable to write ${filePath}: ${String(err)}` }
  }
  return { ok: true }
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