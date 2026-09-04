/**
 * src/tools/experience-store.ts — experience bank storage layer.
 *
 * Provides read/write access to the experience bank stored in
 * .iterate/experience.json. Experiences are accumulated across sessions.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExperienceBank, ExperienceEntry } from '../types.ts'

const EXPERIENCE_FILE = 'experience.json'

/** Default empty experience bank. */
function emptyBank(): ExperienceBank {
  return {
    entries: [],
    lastUpdated: new Date().toISOString(),
    totalHits: 0,
  }
}

/** Read the experience bank from disk. Returns empty bank if not found. */
export function readExperienceBank(projectRoot: string): ExperienceBank {
  const filePath = path.join(projectRoot, '.iterate', EXPERIENCE_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as ExperienceBank
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch {
    // File not found or invalid JSON
  }
  return emptyBank()
}

/** Write the experience bank to disk. */
export function writeExperienceBank(projectRoot: string, bank: ExperienceBank): void {
  const dirPath = path.join(projectRoot, '.iterate')
  const filePath = path.join(dirPath, EXPERIENCE_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(bank, null, 2), 'utf-8')
  } catch {
    // Silently fail - experience bank is not critical
  }
}

/** Search experience entries by query string. */
export function searchExperienceEntries(
  entries: ExperienceEntry[],
  query: string,
  opts: { dimension?: string; tags?: string[] } = {},
): ExperienceEntry[] {
  const lowerQuery = query.toLowerCase()

  return entries.filter((entry) => {
    // Dimension filter
    if (opts.dimension && entry.dimension !== opts.dimension) {
      return false
    }

    // Tags filter (AND logic)
    if (opts.tags && opts.tags.length > 0) {
      if (!opts.tags.every((t) => entry.tags.includes(t))) {
        return false
      }
    }

    // Text search across multiple fields
    if (query) {
      const searchableText = [
        entry.pattern,
        entry.description,
        entry.verifiedFix,
        entry.findingSummary,
        entry.dimension,
        ...entry.files,
        ...entry.tags,
      ].join(' ').toLowerCase()

      if (!searchableText.includes(lowerQuery)) {
        return false
      }
    }

    return true
  })
}

/** Fields the caller may supply when adding/updating an experience entry. */
export type ExperienceEntryInput = Omit<
  ExperienceEntry,
  'id' | 'timestamp' | 'hitCount' | 'lastHitAt'
> & { id?: string }

/**
 * Add or update an experience entry.
 *
 * An entry with an `id` that already exists, OR a new entry whose
 * `pattern`+`dimension` pair matches an existing entry, is treated as a HIT:
 * the matching entry's hitCount is incremented (lastHitAt refreshed) so
 * repeated encounters of the same pattern do not create duplicates. Otherwise
 * a fresh entry is appended with hitCount 1. Never mutates the input bank.
 *
 * Returns the resulting bank plus whether a NEW entry was created and the id
 * of the affected entry.
 */
export function upsertExperience(
  bank: ExperienceBank,
  entry: ExperienceEntryInput
): { bank: ExperienceBank; added: boolean; entryId: string } {
  const lastUpdated = new Date().toISOString()
  const existing = entry.id
    ? bank.entries.find((e) => e.id === entry.id)
    : bank.entries.find((e) => e.pattern === entry.pattern && e.dimension === entry.dimension)

  if (existing) {
    const updated: ExperienceEntry = {
      ...existing,
      hitCount: (existing.hitCount ?? 0) + 1,
      lastHitAt: lastUpdated,
    }
    return {
      bank: {
        ...bank,
        entries: bank.entries.map((e) => (e.id === existing.id ? updated : e)),
        lastUpdated,
        totalHits: (bank.totalHits ?? 0) + 1,
      },
      added: false,
      entryId: existing.id,
    }
  }

  // Add new entry
  const id = entry.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const newEntry: ExperienceEntry = {
    id,
    timestamp: lastUpdated,
    hitCount: 1,
    lastHitAt: lastUpdated,
    ...entry,
  }

  return {
    bank: {
      ...bank,
      entries: [...bank.entries, newEntry],
      lastUpdated,
      totalHits: (bank.totalHits ?? 0) + 1,
    },
    added: true,
    entryId: id,
  }
}
