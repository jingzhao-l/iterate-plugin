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

/** Read the defense events stream from disk. */
export function readDefenseEvents(projectRoot: string): DefenseEventStream {
  const filePath = path.join(projectRoot, '.iterate', DEFENSE_EVENTS_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as DefenseEventStream
    if (parsed && Array.isArray(parsed.events)) {
      return parsed
    }
  } catch {
    // File not found or invalid JSON
  }
  return emptyStream()
}

/** Write the defense events stream to disk. */
export function writeDefenseEvents(projectRoot: string, stream: DefenseEventStream): void {
  const dirPath = path.join(projectRoot, '.iterate')
  const filePath = path.join(dirPath, DEFENSE_EVENTS_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(stream, null, 2), 'utf-8')
  } catch {
    // Silently fail - defense events are not critical
  }
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

  const newCounts = { ...stream.counts }
  newCounts[event.type]++

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
    counts[event.type]++
  }

  return counts
}