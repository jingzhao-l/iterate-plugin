/**
 * src/tools/prune.ts — runtime artifact cleanup for the iterate loop.
 *
 *   iterate_prune — inspect or remove stale runtime artifacts (.iterate/).
 *                   Defaults to dry-run (report-only); set `dryRun: false` to
 *                   actually delete.
 *
 * Artifacts managed:
 *   - Decision-log entries older than `retainDays` (default 30, via since).
 *   - Stale checkpoint files (checkpoint.json).
 *   - Fix backups left over from old rounds (backups whose fix-id no longer
 *     appears in the registry).
 *   - Empty fix rounds (rounds with 0 records).
 *   - Stray temp files left behind by a crashed atomic write (see
 *     `isPrunableTemp` for the recognized naming conventions).
 *   - Experience bank entries beyond `MAX_EXPERIENCE_ENTRIES` (newest kept) —
 *     the bank grows across sessions with no natural bound; a sweep caps it.
 *   - Defense events older than `retainDays` (stale iteration streams that
 *     were never cleared).
 *
 * Security model:
 *   - Only operates under the resolved project `.iterate/` directory.
 *   - dryRun=true by default — the caller must explicitly opt into deletion.
 *   - Each deletion is logged to the decision log (when not dry-run).
 */

import { existsSync, readdirSync, rmSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { writeTextAtomic, writeJsonAtomic } from '../atomic-fs.ts'
import { readDecisionEntries, appendDecisionEntry, acquireLogLock, invalidateLogCountCache } from './decision-log.ts'
import { readRegistry, removeRecord, recomputeRoundCounts } from './fix.ts'
import { readExperienceBank, writeExperienceBank } from './experience-store.ts'
import { readDefenseEvents, writeDefenseEvents } from './defense-store.ts'
import { iterateDir, fixesDir, checkpointPath, fixRegistryPath } from '../paths.ts'
import type { DefenseEventStream, ExperienceBank, FixRegistry } from '../types.ts'

/** Default retention for decision-log entries (in days). */
const DEFAULT_RETAIN_DAYS = 30
const MIN_RETAIN_DAYS = 1
const MAX_RETAIN_DAYS = 365

/**
 * Upper bound on experience-bank entries retained by a prune sweep. The bank
 * accumulates curated knowledge across sessions and each entry is small, so a
 * generous cap drops only the oldest tail of a pathologically large bank
 * (never recent learning).
 */
export const MAX_EXPERIENCE_ENTRIES = 2000

/** How many compare-and-append retries bound the decision-log rewrite race. */
const MAX_LOG_REWRITE_RETRIES = 3

/** Clamp retainDays to a sane range. */
export function clampRetainDays(days: number | undefined): number {
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    return DEFAULT_RETAIN_DAYS
  }
  return Math.min(Math.max(days, MIN_RETAIN_DAYS), MAX_RETAIN_DAYS)
}

/** Build the cutoff timestamp for a given retainDays. */
export function cutoffTimestamp(retainDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() - retainDays)
  return d.toISOString()
}

/**
 * Whether a file name inside `.iterate/` is a prunable leftover temp file.
 *
 * Recognized conventions (all written to the SAME directory as their target,
 * so they can never be confused with real state files):
 *   - `.<name>.tmp-<pid>-<rand>` — current atomic-fs.ts temp prefix;
 *   - `.tmp-<pid>-<rand>`        — legacy temp prefix (older plugin builds);
 *   - `<name>.tmp`               — legacy transcript.ts / live.ts temp suffix.
 *
 * Pure and exported for unit tests. A live writer's temp file is only visible
 * to it (unique name), so deleting any match is always safe.
 */
export function isPrunableTemp(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') return false
  if (name.startsWith('.tmp-')) return true
  if (name.endsWith('.tmp')) return true
  // .<basename>.tmp-<pid>-<rand>: starts with a dot and contains ".tmp-" after it.
  return name.startsWith('.') && name.includes('.tmp-')
}

/**
 * Bound the experience bank to its newest `cap` entries (by timestamp; ties
 * keep their original order via stable sort). Returns the trimmed bank plus
 * how many entries would be dropped. Never mutates the input bank.
 */
export function sweepExperienceBank(bank: ExperienceBank, cap: number): { bank: ExperienceBank; removed: number } {
  const size = Number.isFinite(cap) && (cap as number) >= 0 ? Math.floor(cap) : MAX_EXPERIENCE_ENTRIES
  const total = bank.entries.length
  if (total <= size) return { bank, removed: 0 }
  const kept = [...bank.entries]
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
    .slice(0, size)
  // Preserve the original (insertion) order of the surviving entries.
  const keptIds = new Set(kept.map((e) => e.id))
  const ordered = bank.entries.filter((e) => keptIds.has(e.id))
  return {
    bank: { ...bank, entries: ordered, lastUpdated: new Date().toISOString() },
    removed: total - ordered.length,
  }
}

/**
 * Drop defense events older than `cutoff` from the stream using an ISO
 * timestamp comparison, recomputing the counts so they can never drift from
 * the surviving events. Never mutates the input stream.
 */
export function sweepDefenseEvents(
  stream: DefenseEventStream,
  cutoff: string,
): { stream: DefenseEventStream; removed: number } {
  const kept = stream.events.filter((e) => e.timestamp >= cutoff)
  if (kept.length === stream.events.length) return { stream, removed: 0 }
  return {
    stream: {
      events: kept,
      lastUpdated: new Date().toISOString(),
      counts: computeDefenseCounts(kept),
    },
    removed: stream.events.length - kept.length,
  }
}

/** Recompute per-type defense counts from a list of events. */
function computeDefenseCounts(events: DefenseEventStream['events']): DefenseEventStream['counts'] {
  const counts: DefenseEventStream['counts'] = {
    precondition_failed: 0,
    rollback: 0,
    invariant_violated: 0,
    assumption_falsified: 0,
  }
  for (const e of events) {
    if (e.type in counts) counts[e.type]++
  }
  return counts
}

/**
 * Inspect the runtime state and report what would be pruned.
 * Pure (no deletions). Returns a structured report.
 */
export function inspectPrune(
  projectRoot: string,
  retainDays: number,
): {
  oldLogEntries: number
  hasCheckpoint: boolean
  checkpointStale: boolean
  staleBackups: string[]
  staleTemps: string[]
  emptyRounds: number[]
  totalLogEntries: number
  registryRounds: number
  totalExperiences: number
  experienceOversize: number
  totalDefenseEvents: number
  staleDefenseEvents: number
} {
  const cutoff = cutoffTimestamp(retainDays)

  // 1. Decision-log entries older than retainDays.
  const entries = readDecisionEntries(projectRoot)
  const oldLogEntries = entries.filter((e) => e.timestamp < cutoff).length

  // 2. Checkpoint presence. A checkpoint is only STALE once it is older than
  // retainDays — a fresh checkpoint means a run was interrupted recently and
  // may still be resumed, so `hasCheckpoint` is kept as pure existence while
  // `checkpointStale` decides whether a prune actually deletes it.
  const hasCheckpoint = existsSync(checkpointPath(projectRoot))
  let checkpointStale = false
  if (hasCheckpoint) {
    try {
      const st = statSync(checkpointPath(projectRoot))
      if (st && st.mtimeMs < Date.parse(cutoff)) checkpointStale = true
    } catch {
      checkpointStale = true // unreadable mtime — treat as garbage / deletable
    }
  }

  // 3. Stale fix backups: .bak files whose fix-id prefix is not in the registry.
  const registry = readRegistry(projectRoot)
  const activeIds = new Set<string>()
  for (const r of registry.rounds) {
    for (const rec of r.records) {
      activeIds.add(rec.id)
    }
  }
  const staleBackups: string[] = []
  const fixDir = fixesDir(projectRoot)
  // existsSync does not prove readability — a permissions failure must degrade
  // to "nothing listable" (report skipped) instead of throwing out of execute.
  let fixEntries: string[] = []
  try {
    if (existsSync(fixDir)) fixEntries = readdirSync(fixDir)
  } catch {
    fixEntries = []
  }
  for (const entry of fixEntries) {
    if (!entry.endsWith('.bak')) continue
    // Extract the fix-id prefix (up to the first underscore after the id).
    // e.g. "fix-abc123_2026-08-17T00-00-00-000Z.bak" → "fix-abc123"
    const match = entry.match(/^(fix-[a-z0-9]+)_/)
    const id = match?.[1]
    if (id && !activeIds.has(id)) {
      staleBackups.push(entry)
    }
  }

  // 4. Empty rounds (rounds with 0 records).
  const emptyRounds = registry.rounds
    .filter((r) => r.records.length === 0)
    .map((r) => r.round)

  // 5. Stray atomic-write temp files left behind by a crashed writer. The
  // unique prefix makes them recognizable and safe to delete — no live writer
  // ever reads another writer's temp file. A permissions failure listing the
  // dir degrades to "none found" (report-only) rather than throwing.
  let iterateEntries: string[] = []
  try {
    iterateEntries = existsSync(iterateDir(projectRoot)) ? readdirSync(iterateDir(projectRoot)) : []
  } catch {
    iterateEntries = []
  }
  const staleTemps = iterateEntries.filter((f) => isPrunableTemp(f)).sort()

  // 6. Experience-bank oversize (entries beyond the entry cap). The bank grows
  // across sessions with no natural bound — a sweep reports the tail that a
  // prune would drop (newest `MAX_EXPERIENCE_ENTRIES` preserved).
  const bank = readExperienceBank(projectRoot)
  const sweptBank = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES)

  // 7. Defense events older than retainDays (a previous iteration's stream
  // that was never cleared).
  const defenseStream = readDefenseEvents(projectRoot)
  const sweptDefense = sweepDefenseEvents(defenseStream, cutoff)

  return {
    oldLogEntries,
    hasCheckpoint,
    checkpointStale,
    staleBackups,
    staleTemps,
    emptyRounds,
    totalLogEntries: entries.length,
    registryRounds: registry.rounds.length,
    totalExperiences: bank.entries.length,
    experienceOversize: sweptBank.removed,
    totalDefenseEvents: defenseStream.events.length,
    staleDefenseEvents: sweptDefense.removed,
  }
}

/**
 * Actually prune the runtime artifacts (only called when dryRun=false).
 * Returns a detailed report of what was deleted.
 */
/**
 * Rewrite the decision log to the entries younger than `cutoff`.
 *
 * The read-before-rewrite is a TOCTOU hot spot: a concurrent worker can append
 * a fresh audit line between our read and our atomic rewrite, and an atomic
 * rename would silently discard it. So instead of a single read+write we use a
 * bounded compare-and-append loop — after each rewrite we re-read the log and
 * retry whenever the file grew (a concurrent append slipped in). The loop
 * terminates when the file is stable or after `MAX_LOG_REWRITE_RETRIES`, and a
 * failure here is surfaced as a structured error instead of truncating the log.
 *
 * @returns the number of entries removed (best-effort) or 0 on error.
 */
function rewriteDecisionLogKeepingRecent(projectRoot: string, cutoff: string): { deleted: number; error?: string } {
  const logPath = join(iterateDir(projectRoot), 'decision-log.jsonl')
  // Take the cross-process log lock for the ENTIRE loop: with the mutex held,
  // no concurrent appender can slip a fresh line into the read-before-rewrite
  // window, so the first attempt is nearly always the only one. (The retry
  // loop stays as defense-in-depth for the lock-unavailable path.)
  const release = acquireLogLock(projectRoot)
  try {
    for (let attempt = 0; attempt < MAX_LOG_REWRITE_RETRIES; attempt++) {
      try {
        const entries = readDecisionEntries(projectRoot)
        const kept = entries.filter((e) => e.timestamp >= cutoff)
        const deleted = entries.length - kept.length
        if (deleted === 0) return { deleted: 0 }
        writeTextAtomic(logPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n')
        // The append-side entry-count cache is keyed by path and assumes "same
        // byte size ⇒ same count"; the rename above replaced the file with a
        // different number of entries, so drop the stale cache or the next
        // append can report a wrong entryCount when the sizes coincidentally
        // match.
        invalidateLogCountCache(logPath)
        // A concurrent appender (cross-process, lock-unavailable path) may have
        // landed new lines after our read. If the log grew during the write
        // window, re-read and prune again instead of accepting a lost audit trail.
        const after = readDecisionEntries(projectRoot)
        if (after.length <= kept.length) return { deleted }
      } catch (err) {
        return { deleted: 0, error: `failed to rewrite decision log: ${String(err)}` }
      }
    }
    return { deleted: 0, error: `failed to rewrite decision log after ${MAX_LOG_REWRITE_RETRIES} attempts` }
  } finally {
    release()
  }
}

/**
 * Execute the prune: apply every cleanable item reported by `inspectPrune`.
 * Every step is individually hedged so a single disk failure degrades to a
 * reported error rather than aborting the whole cleanup.
 */
export function executePrune(
  projectRoot: string,
  retainDays: number,
  report: ReturnType<typeof inspectPrune>,
): {
  deletedLogEntries: number
  deletedCheckpoint: boolean
  deletedBackups: string[]
  deletedTemps: string[]
  trimmedEmptyRounds: number
  deletedExperiences: number
  deletedDefenseEvents: number
  errors: string[]
} {
  const cutoff = cutoffTimestamp(retainDays)
  const result = {
    deletedLogEntries: 0,
    deletedCheckpoint: false,
    deletedBackups: [] as string[],
    deletedTemps: [] as string[],
    trimmedEmptyRounds: 0,
    deletedExperiences: 0,
    deletedDefenseEvents: 0,
    errors: [] as string[],
  }

  // 1. Rewrite the decision log, keeping only recent entries. Atomic
  // (temp + rename) so a crash mid-write can never truncate the log; the
  // bounded compare-and-append loop guards against a concurrent appender
  // slipping a fresh audit line into the read-before-rewrite window.
  {
    const { deleted, error } = rewriteDecisionLogKeepingRecent(projectRoot, cutoff)
    result.deletedLogEntries = deleted
    if (error) result.errors.push(error)
  }

  // 2. Remove checkpoint — ONLY when it is actually stale (older than
  // retainDays). A fresh checkpoint is a live resume point for a recently
  // interrupted run; pruning it would silently destroy the ability to resume.
  if (report.checkpointStale) {
    try {
      rmSync(checkpointPath(projectRoot), { force: true })
      result.deletedCheckpoint = true
    } catch (err) {
      result.errors.push(`failed to remove checkpoint: ${String(err)}`)
    }
  }

  // 3. Delete stale backups.
  for (const bak of report.staleBackups) {
    try {
      unlinkSync(join(fixesDir(projectRoot), bak))
      result.deletedBackups.push(bak)
    } catch (err) {
      result.errors.push(`failed to delete backup ${bak}: ${String(err)}`)
    }
  }

  // 4. Trim empty rounds from the registry.
  if (report.emptyRounds.length > 0) {
    try {
      let registry = readRegistry(projectRoot)
      const emptyRoundNos = new Set(report.emptyRounds)
      // Drop whole empty rounds (records.length === 0) instead of only
      // removing their records — an empty round has no records to remove, so
      // the old loop was a no-op that still reported trimmedEmptyRounds.
      registry = {
        ...registry,
        rounds: registry.rounds.filter((r) => !emptyRoundNos.has(r.round) || (r.records?.length ?? 0) > 0),
      }
      registry = recomputeRoundCounts(registry)
      writeJsonAtomic(fixRegistryPath(projectRoot), registry)
      result.trimmedEmptyRounds = report.emptyRounds.length
    } catch (err) {
      result.errors.push(`failed to trim empty rounds: ${String(err)}`)
    }
  }

  // 5. Remove stray atomic-write temp files.
  for (const tmp of report.staleTemps) {
    try {
      rmSync(join(iterateDir(projectRoot), tmp), { force: true })
      result.deletedTemps.push(tmp)
    } catch (err) {
      result.errors.push(`failed to delete temp file ${tmp}: ${String(err)}`)
    }
  }

  // 6. Trim the experience bank to its entry cap (newest wins).
  if (report.experienceOversize > 0) {
    try {
      const bank = readExperienceBank(projectRoot)
      const { bank: swept, removed } = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES)
      if (removed > 0) {
        writeExperienceBank(projectRoot, swept)
        result.deletedExperiences = removed
      }
    } catch (err) {
      result.errors.push(`failed to trim experience bank: ${String(err)}`)
    }
  }

  // 7. Drop defense events older than retainDays (recounted on write).
  if (report.staleDefenseEvents > 0) {
    try {
      const stream = readDefenseEvents(projectRoot)
      const { stream: swept, removed } = sweepDefenseEvents(stream, cutoff)
      if (removed > 0) {
        writeDefenseEvents(projectRoot, swept)
        result.deletedDefenseEvents = removed
      }
    } catch (err) {
      result.errors.push(`failed to sweep defense events: ${String(err)}`)
    }
  }

  return result
}

/**
 * Register the `iterate_prune` tool.
 * Defaults to dry-run: inspects the runtime state and reports what would be
 * cleaned up. Pass `dryRun: false` to actually delete.
 */
export function registerPruneTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_prune',
      description:
        'Inspect or clean up old iterate runtime artifacts (.iterate/). ' +
        'Defaults to dry-run (report-only, no deletion). Pass `dryRun: false` to actually prune. ' +
        'Manages: old decision-log entries, stale checkpoints, orphaned fix backups, empty fix rounds, ' +
        'stray temp files left by crashed atomic writes, experience-bank entries beyond the entry cap, ' +
        'and stale defense events. ' +
        'Each deletion is logged to the decision log.',
      parameters: {
        dryRun: {
          type: 'boolean',
          description: 'When true (default), only report what would be pruned without deleting anything.',
        },
        retainDays: {
          type: 'integer',
          description: `Keep entries newer than this many days (default: ${DEFAULT_RETAIN_DAYS}, range: ${MIN_RETAIN_DAYS}-${MAX_RETAIN_DAYS}).`,
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
            ok: { type: 'boolean', required: true },
            dryRun: { type: 'boolean', required: true },
            retainDays: { type: 'integer' },
            report: { type: 'json' },
            result: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `prune failed: ${value.error}` }]
          const report = value.report as Record<string, unknown> | undefined
          const result = value.result as Record<string, unknown> | undefined
          if (value.dryRun) {
            const lines = [
              `[dry-run] prune report (retainDays=${value.retainDays}):`,
              `  Decision-log entries to remove: ${report?.oldLogEntries ?? '?'} (of ${report?.totalLogEntries ?? '?'})`,
              `  Checkpoint to delete: ${report?.checkpointStale ? 'yes (stale)' : report?.hasCheckpoint ? 'no (fresh — resume point, kept)' : 'none'}`,
              `  Stale backups to delete: ${(report?.staleBackups as string[] | undefined)?.length ?? 0}`,
              `  Stray temp files to delete: ${(report?.staleTemps as string[] | undefined)?.length ?? 0}`,
              `  Empty rounds to trim: ${(report?.emptyRounds as number[] | undefined)?.length ?? 0}`,
              `  Experience entries to drop (over ${report?.totalExperiences ?? '?'} cap): ${report?.experienceOversize ?? 0} of ${report?.totalExperiences ?? '?'}`,
              `  Stale defense events to remove: ${report?.staleDefenseEvents ?? 0} (of ${report?.totalDefenseEvents ?? '?'})`,
              '',
              'Pass dryRun:false to execute the prune.',
            ]
            return [{ type: 'text', text: lines.join('\n') }]
          }
          const lines = [
            `Prune complete (retainDays=${value.retainDays}):`,
            `  Deleted ${result?.deletedLogEntries ?? 0} old log entries.`,
            `  Checkpoint deleted: ${result?.deletedCheckpoint ? 'yes' : 'no'}`,
            `  Deleted ${(result?.deletedBackups as string[] | undefined)?.length ?? 0} stale backups.`,
            `  Deleted ${(result?.deletedTemps as string[] | undefined)?.length ?? 0} stray temp files.`,
            `  Trimmed ${result?.trimmedEmptyRounds ?? 0} empty rounds.`,
            `  Trimmed ${result?.deletedExperiences ?? 0} experience entries (over the entry cap).`,
            `  Removed ${result?.deletedDefenseEvents ?? 0} stale defense events.`,
          ]
          const errs = (result?.errors as string[] | undefined) ?? []
          if (errs.length > 0) {
            lines.push('', '  Warnings:')
            for (const e of errs) lines.push(`    - ${e}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, dryRun: true, error: resolved.reason }
        const projectRoot = resolved.root
        const retainDays = clampRetainDays(args.retainDays as number | undefined)
        const dryRun = args.dryRun !== false

        const report = inspectPrune(projectRoot, retainDays)

        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            retainDays,
            report: report as unknown as JsonValue,
          }
        }

        const result = executePrune(projectRoot, retainDays, report)

        // Log the prune to the decision log. The mutations already happened, so
        // a failed log append is reported via `errors` — a silent audit miss
        // (F2) must never pretend every deletion was recorded.
        const logRes = appendDecisionEntry(projectRoot, {
          timestamp: new Date().toISOString(),
          round: 0,
          type: 'decision',
          data: {
            action: 'prune',
            retainDays,
            deletedLogEntries: result.deletedLogEntries,
            deletedCheckpoint: result.deletedCheckpoint,
            deletedBackups: result.deletedBackups.length,
            trimmedEmptyRounds: result.trimmedEmptyRounds,
            deletedExperiences: result.deletedExperiences,
            deletedDefenseEvents: result.deletedDefenseEvents,
          },
        })
        if (logRes.error) result.errors.push(logRes.error)

        return {
          ok: true,
          dryRun: false,
          retainDays,
          report: report as unknown as JsonValue,
          result: result as unknown as JsonValue,
        }
      },
    }),
  )
}