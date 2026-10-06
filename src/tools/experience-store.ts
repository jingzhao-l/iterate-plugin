/**
 * src/tools/experience-store.ts — experience bank storage layer.
 *
 * Provides read/write access to the experience bank stored in
 * .iterate/experience.json. Experiences are accumulated across sessions.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { iterateDir } from '../paths.ts'
import { writeJsonAtomic } from '../atomic-fs.ts'
import { hashString } from './fix.ts'
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

/** Valid severity values (kept in sync with ExperienceEntry). */
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])

/** String array guard for fields that must be arrays (`files`, `tags`). */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/**
 * Coerce a persisted hit counter to a safe non-negative integer. Hand-edited
 * banks can carry fractional (4.5), negative (-1), non-finite (Infinity) or
 * non-numeric ('x') values — the tool output schema declares these fields as
 * `integer`, so any of them reaching the result would throw ToolOutputError
 * at runtime. Floors first, then clamps at 0; anything non-finite → 0.
 */
function toHitCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.floor(v))
}

/**
 * Longest caller-supplied experience id we will persist, and the characters
 * it may contain. Ids surface verbatim in tool output and on disk, so a
 * hostile "add" must not be able to store a 100 KB blob or control bytes
 * (NUL/newline) under the id field. Printable characters only (no C0/C1
 * controls); unicode text is fine.
 */
export const MAX_EXPERIENCE_ID_LENGTH = 200

/**
 * Whether a caller-supplied id may identify a NEW experience entry.
 * Validated at the tool layer BEFORE the entry reaches `upsertExperience`
 * (see src/tools/experience-bank.ts): non-empty, ≤ 200 chars, no control
 * characters. Pure — exported for unit tests.
 */
export function isValidExperienceId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > MAX_EXPERIENCE_ID_LENGTH) return false
  // Control characters (NUL, newline, …) would corrupt the id wherever it is
  // echoed (JSON output, file names in renderers) — reject them outright.
  return !/[\u0000-\u001f\u007f]/.test(id)
}

/**
 * Normalize one persisted experience entry. A hand-edited bank entry can be
 * missing `files`/`tags` arrays (or `hitCount`) — consumers rendering/searching
 * entries (`render` `.join(', ')`, `searchExperienceEntries` spread) must never
 * throw or emit NaN. Returns null for non-object entries; every required field
 * gets a safe default.
 */
function normalizeEntry(raw: unknown, index: number): ExperienceEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  const pattern = typeof e.pattern === 'string' ? e.pattern : ''
  const dimension = typeof e.dimension === 'string' ? e.dimension : ''
  // Deterministic id (content + position based) so a read→write cycle never
  // churns random ids on entries that were hand-edited without one.
  const derivedId = `exp-${hashString(`${index}|${pattern}|${dimension}`)}`
  const id = typeof e.id === 'string' && e.id ? e.id : derivedId
  if (!pattern && !dimension) return null
  const hitCount = toHitCount(e.hitCount)
  return {
    id,
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
    dimension,
    pattern,
    description: typeof e.description === 'string' ? e.description : '',
    verifiedFix: typeof e.verifiedFix === 'string' ? e.verifiedFix : '',
    findingSummary: typeof e.findingSummary === 'string' ? e.findingSummary : '',
    files: stringArray(e.files),
    hitCount,
    ...(typeof e.lastHitAt === 'string' ? { lastHitAt: e.lastHitAt } : {}),
    tags: stringArray(e.tags),
    severity: VALID_SEVERITIES.has(String(e.severity)) ? (e.severity as ExperienceEntry['severity']) : 'low',
  }
}

/** Read the experience bank from disk. Returns empty bank if not found. */
export function readExperienceBank(projectRoot: string): ExperienceBank {
  const filePath = path.join(projectRoot, '.iterate', EXPERIENCE_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<ExperienceBank>
    if (parsed && Array.isArray(parsed.entries)) {
      const entries = parsed.entries
        .map((raw, i) => normalizeEntry(raw, i))
        .filter((e): e is ExperienceEntry => e !== null)
      return {
        entries,
        // Stream-level fallback timestamp: display-only metadata — the entry
        // sweep ranks per-ENTRY `entry.timestamp`, never `lastUpdated`, so a
        // missing/corrupt value degrading to "now" cannot reorder or rescue
        // entries. (Reaffirmed from the earlier review: comment only, behavior
        // unchanged.)
        lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : emptyBank().lastUpdated,
        // Same contract as per-entry hitCount: a hand-edited totalHits must be
        // a finite non-negative integer before it reaches the `integer` output
        // schema (4.5 → 4, -1 → 0, Infinity/NaN/'x' → 0).
        totalHits: toHitCount(parsed.totalHits),
      }
    }
  } catch {
    // File not found or invalid JSON
  }
  return emptyBank()
}

/**
 * Write the experience bank to disk.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` when the write
 * fails — a caller must surface the failure instead of reporting success for
 * an entry that was never persisted.
 */
export function writeExperienceBank(
  projectRoot: string,
  bank: ExperienceBank,
): { ok: true } | { ok: false; error: string } {
  const dirPath = iterateDir(projectRoot)
  const filePath = path.join(dirPath, EXPERIENCE_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    // Atomic (temp + rename): a crash mid-write can never leave a truncated
    // experience bank behind.
    writeJsonAtomic(filePath, bank)
  } catch (err) {
    return { ok: false, error: `unable to write ${filePath}: ${String(err)}` }
  }
  return { ok: true }
}

/** Search experience entries by query string. */
export function searchExperienceEntries(
  entries: ExperienceEntry[],
  query: string,
  opts: { dimension?: string; tags?: string[] } = {},
): ExperienceEntry[] {
  const lowerQuery = query.toLowerCase()

  return entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const rawEntry = entry as unknown as Record<string, unknown>
    const tags = stringArray(rawEntry.tags)
    // Dimension filter
    if (opts.dimension && entry.dimension !== opts.dimension) {
      return false
    }

    // Tags filter (AND logic)
    if (opts.tags && opts.tags.length > 0) {
      if (!opts.tags.every((t) => tags.includes(t))) {
        return false
      }
    }

    // Text search across multiple fields. Guards against a hand-edited bank entry
  // whose `files`/`tags` are missing or non-array (the spread below would
  // otherwise throw a TypeError on a non-iterable).
  if (query) {
    const searchableText = [
      entry.pattern,
      entry.description,
      entry.verifiedFix,
      entry.findingSummary,
      entry.dimension,
      ...stringArray(entry.files),
      ...stringArray(entry.tags),
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
 * An entry with an `id` that already exists is treated as an UPDATE + HIT:
 * the caller-supplied fields replace the stored ones and the hitCount is
 * incremented (lastHitAt refreshed) — this fulfills the documented
 * "update a specific entry via add" contract. A NEW entry whose
 * `pattern`+`dimension` pair matches an existing entry is treated as a HIT:
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
    // Explicit-id updates REPLACE the editable fields (fulfilling the
    // documented "update a specific entry via add" contract); a pattern+
    // dimension HIT only bumps the hit metadata so a repeat encounter never
    // overwrites the curated entry.
    const byId = typeof entry.id === 'string' && entry.id.length > 0
    const updated: ExperienceEntry = byId
      ? { ...existing, ...entry, id: existing.id, hitCount: (existing.hitCount ?? 0) + 1, lastHitAt: lastUpdated }
      : { ...existing, hitCount: (existing.hitCount ?? 0) + 1, lastHitAt: lastUpdated }
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

  // Add new entry. Spread the caller input FIRST so the store-generated
  // `timestamp`/`hitCount`/`lastHitAt` always win — a hostile or malformed
  // input can never forge its hit metadata. A caller-supplied `id` IS honored
  // here (it is the documented "update a specific entry via add"/custom-id
  // contract), but only after the tool layer validated it with
  // `isValidExperienceId` (non-empty, ≤ 200 chars, printable) — oversized or
  // control-byte ids are rejected with a structured error before they reach
  // this store (see src/tools/experience-bank.ts). Because an EXISTING id
  // takes the update path above, a new entry can never collide with — or
  // impersonate — an entry that is already in the bank.
  const id = entry.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const newEntry: ExperienceEntry = {
    ...entry,
    id,
    timestamp: lastUpdated,
    hitCount: 1,
    lastHitAt: lastUpdated,
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

/**
 * Remove an experience entry by id.
 * Returns the resulting bank plus whether an entry was actually removed. An
 * unknown id is a no-op (the caller decides how to surface it). Never mutates
 * the input bank.
 */
export function removeExperience(
  bank: ExperienceBank,
  id: string,
): { bank: ExperienceBank; removed: boolean } {
  const target = typeof id === 'string' && id ? id : ''
  if (!target) return { bank, removed: false }
  const entries = bank.entries.filter((e) => e.id !== target)
  if (entries.length === bank.entries.length) return { bank, removed: false }
  const lastUpdated = new Date().toISOString()
  return {
    bank: {
      ...bank,
      entries,
      lastUpdated,
      totalHits: bank.totalHits ?? 0,
    },
    removed: true,
  }
}
