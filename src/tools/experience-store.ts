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

/** Add or update an experience entry. */
export function upsertExperience(
  bank: ExperienceBank,
  entry: Omit<ExperienceEntry, 'id' | 'hitCount' | 'lastHitAt'> & { id?: string }
): ExperienceBank {
  const id = entry.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const existing = bank.entries.find((e) => e.id === id)

  if (existing) {
    // Update existing entry
    existing.hitCount++
    existing.lastHitAt = new Date().toISOString()
    return {
      ...bank,
      lastUpdated: new Date().toISOString(),
      totalHits: bank.totalHits + 1,
    }
  }

  // Add new entry
  const newEntry: ExperienceEntry = {
    id,
    hitCount: 1,
    lastHitAt: new Date().toISOString(),
    ...entry,
  }

  return {
    ...bank,
    entries: [...bank.entries, newEntry],
    lastUpdated: new Date().toISOString(),
    totalHits: bank.totalHits + 1,
  }
}
