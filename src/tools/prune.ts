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
 *
 * Security model:
 *   - Only operates under the resolved project `.iterate/` directory.
 *   - dryRun=true by default — the caller must explicitly opt into deletion.
 *   - Each deletion is logged to the decision log (when not dry-run).
 */

import { existsSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readDecisionEntries, appendDecisionEntry } from './decision-log.ts'
import { readRegistry, removeRecord, recomputeRoundCounts } from './fix.ts'
import { iterateDir, fixesDir, checkpointPath, fixRegistryPath } from '../paths.ts'
import type { FixRegistry } from '../types.ts'

/** Default retention for decision-log entries (in days). */
const DEFAULT_RETAIN_DAYS = 30
const MIN_RETAIN_DAYS = 1
const MAX_RETAIN_DAYS = 365

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
 * Inspect the runtime state and report what would be pruned.
 * Pure (no deletions). Returns a structured report.
 */
export function inspectPrune(
  projectRoot: string,
  retainDays: number,
): {
  oldLogEntries: number
  hasCheckpoint: boolean
  staleBackups: string[]
  emptyRounds: number[]
  totalLogEntries: number
  registryRounds: number
} {
  const cutoff = cutoffTimestamp(retainDays)

  // 1. Decision-log entries older than retainDays.
  const entries = readDecisionEntries(projectRoot)
  const oldLogEntries = entries.filter((e) => e.timestamp < cutoff).length

  // 2. Checkpoint presence.
  const hasCheckpoint = existsSync(checkpointPath(projectRoot))

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
  if (existsSync(fixDir)) {
    for (const entry of readdirSync(fixDir)) {
      if (!entry.endsWith('.bak')) continue
      // Extract the fix-id prefix (up to the first underscore after the id).
      // e.g. "fix-abc123_2026-08-17T00-00-00-000Z.bak" → "fix-abc123"
      const match = entry.match(/^(fix-[a-z0-9]+)_/)
      const id = match?.[1]
      if (id && !activeIds.has(id)) {
        staleBackups.push(entry)
      }
    }
  }

  // 4. Empty rounds (rounds with 0 records).
  const emptyRounds = registry.rounds
    .filter((r) => r.records.length === 0)
    .map((r) => r.round)

  return {
    oldLogEntries,
    hasCheckpoint,
    staleBackups,
    emptyRounds,
    totalLogEntries: entries.length,
    registryRounds: registry.rounds.length,
  }
}

/**
 * Actually prune the runtime artifacts (only called when dryRun=false).
 * Returns a detailed report of what was deleted.
 */
export function executePrune(
  projectRoot: string,
  retainDays: number,
  report: ReturnType<typeof inspectPrune>,
): {
  deletedLogEntries: number
  deletedCheckpoint: boolean
  deletedBackups: string[]
  trimmedEmptyRounds: number
  errors: string[]
} {
  const cutoff = cutoffTimestamp(retainDays)
  const result = {
    deletedLogEntries: 0,
    deletedCheckpoint: false,
    deletedBackups: [] as string[],
    trimmedEmptyRounds: 0,
    errors: [] as string[],
  }

  // 1. Rewrite the decision log, keeping only recent entries. Atomic
  // (temp + rename) so a crash mid-write can never truncate the log.
  try {
    const entries = readDecisionEntries(projectRoot)
    const kept = entries.filter((e) => e.timestamp >= cutoff)
    result.deletedLogEntries = entries.length - kept.length
    if (result.deletedLogEntries > 0) {
      const logPath = join(iterateDir(projectRoot), 'decision-log.jsonl')
      const tmpPath = `${logPath}.tmp-${Date.now()}`
      writeFileSync(tmpPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
      renameSync(tmpPath, logPath)
    }
  } catch (err) {
    result.errors.push(`failed to rewrite decision log: ${String(err)}`)
    result.deletedLogEntries = 0
  }

  // 2. Remove checkpoint.
  if (report.hasCheckpoint) {
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
      writeFileSync(fixRegistryPath(projectRoot), JSON.stringify(registry, null, 2), 'utf-8')
      result.trimmedEmptyRounds = report.emptyRounds.length
    } catch (err) {
      result.errors.push(`failed to trim empty rounds: ${String(err)}`)
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
        'Manages: old decision-log entries, stale checkpoints, orphaned fix backups, empty fix rounds. ' +
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
              `  Checkpoint to delete: ${report?.hasCheckpoint ? 'yes' : 'none'}`,
              `  Stale backups to delete: ${(report?.staleBackups as string[] | undefined)?.length ?? 0}`,
              `  Empty rounds to trim: ${(report?.emptyRounds as number[] | undefined)?.length ?? 0}`,
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
            `  Trimmed ${result?.trimmedEmptyRounds ?? 0} empty rounds.`,
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

        // Log the prune to the decision log.
        appendDecisionEntry(projectRoot, {
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
          },
        })

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