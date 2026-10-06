import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import yaml from 'js-yaml'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { writeTextAtomic } from '../atomic-fs.ts'
import { configBackupSuffix } from '../config-write.ts'
import { WHOLE_FILE_LINE } from '../evidence.ts'
import type { KnownIntentional } from '../types.ts'

const CONFIG_FILE = 'iterate.config.yaml'

/** Personalization key that holds the known-intentional list. */
const PERSONALIZATION_KEY = 'personalization'
const KNOWN_INTENTIONAL_KEY = 'known_intentional'

/** Max entries per single `apply` call. */
const MAX_ENTRIES = 500

/**
 * TOTAL cap on `personalization.known_intentional`.
 *
 * `MAX_ENTRIES` only bounds one `apply` payload, so the list itself grew
 * without limit across sessions — every review round then ran
 * `filterKnownIntentional` as O(findings × entries) over an ever-longer list,
 * and the config file (backed up on every write) grew with it. Merges now
 * evict the OLDEST entries (list order is write order — incoming entries are
 * appended) beyond this bound and report how many were dropped.
 */
export const MAX_TOTAL_KNOWN_INTENTIONAL = 1000

/** How many timestamped config backups are retained (older ones are removed). */
export const MAX_TRIAGE_BACKUPS = 5

/** Whole-file marker line — the shared constant from evidence.ts (also used by
 *  review-scope/filterKnownIntentional), so every consumer agrees on `0`. */

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Normalize a caller-supplied `line` value.
 * Returns a positive integer, or `undefined` when the value is absent,
 * non-numeric, or non-positive (which is the "whole file" semantics).
 *
 * @param {unknown} line
 * @returns {number | undefined}
 */
export function normalizeEntryLine(line: unknown): number | undefined {
  if (typeof line !== 'number' || !Number.isInteger(line)) return undefined
  if (line <= 0) return undefined
  return line
}

/**
 * Validate an array of triage entries. Each entry must be an object with
 * non-empty string `file` / `dimension` / `reason`, and an optional positive
 * integer `line`.
 *
 * @param {unknown} entries
 * @returns {string[]} Validation error messages (empty when valid).
 */
export function validateTriageEntries(entries: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(entries)) {
    errors.push('entries must be an array')
    return errors
  }
  if (entries.length > MAX_ENTRIES) {
    errors.push(`entries must not exceed ${MAX_ENTRIES} items (got ${entries.length})`)
    return errors
  }
  for (let i = 0; i < entries.length; i++) {
    const prefix = `entries[${i}]`
    const e = entries[i]
    if (!e || typeof e !== 'object') {
      errors.push(`${prefix} must be an object`)
      continue
    }
    const entry = e as Record<string, unknown>
    if (typeof entry.file !== 'string' || entry.file.trim().length === 0) {
      errors.push(`${prefix}.file must be a non-empty string`)
    }
    if (typeof entry.dimension !== 'string' || entry.dimension.trim().length === 0) {
      errors.push(`${prefix}.dimension must be a non-empty string`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      errors.push(`${prefix}.reason must be a non-empty string`)
    }
    if (entry.line !== undefined && normalizeEntryLine(entry.line) === undefined) {
      errors.push(`${prefix}.line must be a positive integer when present`)
    }
  }
  return errors
}

/**
 * Build the dedupe key for a known-intentional entry.
 * Semantics mirror review.ts filterKnownIntentional: a whole-file entry
 * (`line` 0/undefined) is distinct from a line-specific one.
 *
 * @param {KnownIntentional} entry
 * @returns {string}
 */
export function entryKey(entry: KnownIntentional): string {
  const line = normalizeEntryLine(entry.line) ?? WHOLE_FILE_LINE
  return `${entry.file}|${entry.dimension}|${line}`
}

/**
 * Merge incoming entries into the existing known-intentional list.
 * Existing entries are never mutated; incoming entries whose key already
 * exists are skipped. The result is then bounded by
 * {@link MAX_TOTAL_KNOWN_INTENTIONAL}: the list is append-ordered, so when a
 * merge overflows, the entries at the FRONT (the oldest ones) are evicted and
 * counted in `dropped` — the caller reports that number instead of silently
 * losing verdicts.
 *
 * @param {KnownIntentional[]} existing
 * @param {KnownIntentional[]} incoming
 * @returns {{ merged: KnownIntentional[], added: number, skipped: number, dropped: number }}
 */
export function mergeKnownIntentional(
  existing: KnownIntentional[],
  incoming: KnownIntentional[],
): { merged: KnownIntentional[]; added: number; skipped: number; dropped: number } {
  const seen = new Set<string>()
  const merged: KnownIntentional[] = []
  for (const entry of existing) {
    const key = entryKey(entry)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(entry)
    }
  }
  let added = 0
  let skipped = 0
  for (const entry of incoming) {
    const key = entryKey(entry)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    merged.push(entry)
    added++
  }
  // Total bound: evict oldest-first. Incoming entries sit at the END of
  // `merged`, so they survive — a session cannot evict its own fresh verdicts
  // by overflowing the list, and one apply adds at most MAX_ENTRIES entries,
  // which bounds how far a single merge can overshoot the cap.
  let dropped = 0
  if (merged.length > MAX_TOTAL_KNOWN_INTENTIONAL) {
    dropped = merged.length - MAX_TOTAL_KNOWN_INTENTIONAL
    merged.splice(0, dropped)
  }
  return { merged, added, skipped, dropped }
}

/**
 * Build a NEW config object with `personalization.known_intentional` set to
 * the merged entries. All other top-level fields are preserved unchanged.
 * Returns a deep-enough copy so the caller can serialize it safely.
 *
 * @param {Record<string, unknown>} config
 * @param {KnownIntentional[]} entries
 * @returns {Record<string, unknown>}
 */
export function buildConfigWithKnownIntentional(
  config: Record<string, unknown>,
  entries: KnownIntentional[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config }
  const personalization =
    next[PERSONALIZATION_KEY] && typeof next[PERSONALIZATION_KEY] === 'object'
      ? { ...(next[PERSONALIZATION_KEY] as Record<string, unknown>) }
      : {}
  personalization[KNOWN_INTENTIONAL_KEY] = entries
  next[PERSONALIZATION_KEY] = personalization
  return next
}

/** Read the raw known-intentional list from a config object (may be absent). */
export function readKnownIntentional(
  config: Record<string, unknown>,
): KnownIntentional[] {
  const personalization = config[PERSONALIZATION_KEY]
  if (!personalization || typeof personalization !== 'object') return []
  const known = (personalization as Record<string, unknown>)[KNOWN_INTENTIONAL_KEY]
  if (!Array.isArray(known)) return []
  return known.filter(
    (e): e is KnownIntentional =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as Record<string, unknown>).file === 'string',
  )
}

/**
 * Build a filesystem-safe backup suffix from the current time.
 *
 * Re-exported from config-write: BOTH writers back up `iterate.config.yaml`,
 * and the shared implementation carries the same-millisecond collision guard
 * (two backups created in the same ms used to produce the identical
 * `config.bak-…` path, so the second silently overwrote the first).
 */
export const backupSuffix = configBackupSuffix

/**
 * Bound the timestamped config backups: after a fresh one is written, delete
 * every older `config.bak-*` file beyond the newest `keep`. Best-effort — a
 * filesystem failure here must never fail the apply that just succeeded
 * (backups are a safety net, not a requirement).
 * @returns the absolute paths of the backups that were removed.
 */
export function pruneOldConfigBackups(configPath: string, keep = MAX_TRIAGE_BACKUPS): string[] {
  const removed: string[] = []
  try {
    const dir = dirname(configPath)
    const prefix = `${basename(configPath)}.bak-`
    const matches = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
    // Keep the newest `keep`; remove everything older.
    const doomed = matches.slice(0, Math.max(0, matches.length - keep))
    for (const f of doomed) {
      rmSync(join(dir, f), { force: true })
      removed.push(join(dir, f))
    }
  } catch {
    // Best-effort cleanup — never surface a cleanup failure.
  }
  return removed
}

// ─── File I/O ───────────────────────────────────────────────────────────────

/** Load the raw config object (empty when the file is missing). */
function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  const content = readFileSync(configPath, 'utf-8')
  const parsed = yaml.load(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A config that exists but is NOT a YAML mapping (including a YAML list,
    // which `typeof [] === 'object'` alone would accept) must NOT be silently
    // treated as empty: writing over it would destroy user data. Callers
    // surface this as an error and refuse to write.
    throw new Error('existing iterate.config.yaml is not a valid YAML mapping')
  }
  return parsed as Record<string, unknown>
}

/** Apply the triage entries: backup, merge, write, rollback on failure. */
function applyEntries(
  projectRoot: string,
  incoming: KnownIntentional[],
): {
  ok: true
  added: number
  skipped: number
  /** Entries evicted from the FRONT of the list because the total cap was hit. */
  dropped: number
  count: number
  configPath: string
  backupPath: string | null
} | {
  ok: false
  error: string
} {
  const configPath = join(projectRoot, CONFIG_FILE)
  let config: Record<string, unknown>
  try {
    config = readConfigFile(configPath)
  } catch (err) {
    // The file exists but is malformed — refuse to overwrite user data.
    return { ok: false, error: `Failed to read config: ${String(err)}` }
  }
  const existing = readKnownIntentional(config)
  const { merged, added, skipped, dropped } = mergeKnownIntentional(existing, incoming)
  const nextConfig = buildConfigWithKnownIntentional(config, merged)

  const hadFile = existsSync(configPath)
  const backupPath = hadFile ? `${configPath}.bak-${backupSuffix()}` : null

  if (backupPath) {
    try {
      copyFileSync(configPath, backupPath)
    } catch (err) {
      return {
        ok: false,
        error: `Failed to create backup: ${String(err)}`,
      }
    }
  }

  const yamlText = yaml.dump(nextConfig, { noRefs: true })
  try {
    writeTextAtomic(configPath, yamlText)
  } catch (err) {
    // Rollback: restore the backup, or REMOVE the file we just created when
    // there was no prior config — an empty file left behind would poison all
    // future config reads (empty YAML is not a valid mapping).
    let rollbackError = ''
    try {
      if (backupPath) copyFileSync(backupPath, configPath)
      else if (existsSync(configPath)) rmSync(configPath, { force: true })
    } catch (rbErr) {
      rollbackError = `; rollback also failed: ${String(rbErr)}`
    }
    return {
      ok: false,
      error: `Failed to write config: ${String(err)}${rollbackError}`,
    }
  }

  // Success: bound the accumulation of timestamped backups so a long-lived
  // project never collects an unbounded pile of config snapshots.
  if (backupPath) pruneOldConfigBackups(configPath)

  return { ok: true, added, skipped, dropped, count: merged.length, configPath, backupPath }
}

/**
 * Register the `iterate_triage` tool.
 *
 * Completes the findings-triage closed loop: the client triage panel marks
 * findings as "known intentional" (a), and this tool writes those entries
 * into `iterate.config.yaml` under `personalization.known_intentional` so the
 * next review round filters them out (review.ts filterKnownIntentional).
 *
 * Operations:
 *  - `apply`: merge validated entries into the config (dedupe by
 *             file|dimension|line), with an automatic timestamped backup and
 *             rollback if the write fails.
 *  - `list`:  read back the current known_intentional entries.
 */
export function registerTriageTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_triage',
      // Pending-call card (#12): `apply` rewrites iterate.config.yaml (with
      // backup + rollback) — it must read as a config write, not a read, and
      // name how many entries it will merge. `list` is a plain read and keeps
      // the default presentation. Pure: derived from args only.
      presentCall: (args) => {
        const a = args as { operation?: unknown; entries?: unknown }
        if (a.operation !== 'apply') return undefined
        const count = Array.isArray(a.entries) ? a.entries.length : 0
        return {
          card: 'generic',
          title: count > 0
            ? `Apply ${count} known_intentional ${count === 1 ? 'entry' : 'entries'} to iterate.config.yaml`
            : 'Apply known_intentional entries to iterate.config.yaml',
          kind: 'edit',
        }
      },
      // `list` is a pure config read; `apply` rewrites iterate.config.yaml →
      // only list joins a parallel dispatch group.
      isConcurrencySafe: (args) => (args as { operation?: unknown }).operation === 'list',
      description:
        'Manage `personalization.known_intentional` entries in iterate.config.yaml. ' +
        'Use `apply` to write back triage verdicts (entries where the reviewer said "known intentional") so ' +
        'future review rounds filter them out. Entries are deduped by file|dimension|line and the config is ' +
        'backed up before writing. The list is capped at 1000 entries — when a merge overflows it, the OLDEST ' +
        'entries are evicted and the result reports `dropped`. Use `list` to read the current entries. ' +
        'The client browser cannot write files, so this tool is the write-back channel for the triage panel.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"apply" to merge entries into the config, "list" to read them back.',
          enum: ['apply', 'list'],
        },
        entries: {
          type: 'json',
          description:
            'For `apply`: array of known-intentional entries, e.g. ' +
            '[{"file":"src/a.ts","line":42,"dimension":"security","reason":"..."}]. ' +
            'Each entry needs non-empty string file/dimension/reason; line is an optional positive integer ' +
            '(omitted = whole file).',
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
            added: { type: 'integer' },
            skipped: { type: 'integer' },
            /** Entries evicted from the FRONT of the list (total cap hit). */
            dropped: { type: 'integer' },
            count: { type: 'integer' },
            path: { type: 'string' },
            backupPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            entries: { type: 'json' },
            errors: { type: 'array', items: { type: 'string' } },
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
        const configPath = join(projectRoot, CONFIG_FILE)

        if (args.operation === 'list') {
          let config: Record<string, unknown>
          try {
            config = readConfigFile(configPath)
          } catch (err) {
            return { operation: 'list', error: `Failed to read config: ${String(err)}` }
          }
          const entries = readKnownIntentional(config)
          return {
            operation: 'list',
            count: entries.length,
            path: configPath,
            entries: entries as unknown as JsonValue,
          }
        }

        if (args.operation === 'apply') {
          const validation = validateTriageEntries(args.entries)
          if (validation.length > 0) {
            return { operation: 'apply', errors: validation, error: 'Invalid entries.' }
          }
          const incoming = (args.entries as unknown[]).map((e) => {
            const raw = e as Record<string, unknown>
            return {
              file: String(raw.file),
              ...(normalizeEntryLine(raw.line) !== undefined
                ? { line: normalizeEntryLine(raw.line) as number }
                : {}),
              dimension: String(raw.dimension),
              reason: String(raw.reason),
            } as KnownIntentional
          })
          const result = applyEntries(projectRoot, incoming)
          if (!result.ok) {
            return { operation: 'apply', error: result.error }
          }
          return {
            operation: 'apply',
            added: result.added,
            skipped: result.skipped,
            // Surface the overflow count: a merge that hit the total cap
            // evicted the OLDEST entries, and the caller must be able to see
            // how many verdicts were dropped instead of silently losing them.
            dropped: result.dropped,
            count: result.count,
            path: result.configPath,
            backupPath: result.backupPath ?? null,
          }
        }

        return {
          operation: args.operation,
          error: 'Unknown operation. Use "apply" or "list".',
        }
      },
    }),
  )
}
