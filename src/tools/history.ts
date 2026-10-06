/**
 * src/tools/history.ts — iteration history reader.
 *
 *   iterate_history — read the decision-log entries (with optional filters)
 *                     plus a summary of the fix registry, so the user or the
 *                     orchestrator can review exactly what the run did.
 *
 * Complements `iterate_status` (compact summary) with the actual detail.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readDecisionEntries } from './decision-log.ts'
import { readRegistry } from './fix.ts'
import type { DecisionLogEntry, FixRegistry } from '../types.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Clamp a caller-supplied `limit` to a sane range. */
export function clampHistoryLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(limit, MAX_LIMIT)
}

/**
 * Filter + cap decision-log entries. Pure, unit-tested.
 * Returns the newest `limit` matching entries plus the total match count
 * (before the cap), so callers can tell when the result was truncated.
 *
 * `round` keeps only entries logged for that round; `file` keeps only entries
 * whose `data.file` names that fixed file. Invalid `round`/`file` inputs are
 * ignored (same convention as `type`/`since`), never treated as a match-nothing
 * filter by accident.
 */
export function filterDecisionEntries(
  entries: DecisionLogEntry[],
  opts: { type?: unknown; since?: unknown; limit?: unknown; round?: unknown; file?: unknown },
): { entries: DecisionLogEntry[]; filteredCount: number; limit: number } {
  const type = typeof opts.type === 'string' && opts.type ? opts.type : undefined
  const since = typeof opts.since === 'string' && opts.since ? opts.since : undefined
  const round =
    typeof opts.round === 'number' && Number.isInteger(opts.round) && opts.round >= 0
      ? opts.round
      : undefined
  const file = typeof opts.file === 'string' && opts.file ? opts.file : undefined
  const limit = clampHistoryLimit(opts.limit as number | undefined)

  const matching = (Array.isArray(entries) ? entries : []).filter((e) => {
    if (type && e.type !== type) return false
    if (since && e.timestamp <= since) return false
    if (round !== undefined && e.round !== round) return false
    if (file && (!e.data || e.data.file !== file)) return false
    return true
  })
  return {
    entries: matching.slice(-limit),
    filteredCount: matching.length,
    limit,
  }
}

/**
 * Per-round fix counts + totals from a fix registry. Pure, unit-tested.
 *
 * `opts.round` narrows the view to one round. `opts.file` narrows each round to
 * the records that fixed that file: the stored per-round counts cover every
 * file and cannot be subsetted, so a file-scoped summary RECOMPUTES the counts
 * from the kept records (mirroring `recomputeRoundCounts`), and rounds left
 * without any matching record are dropped entirely — an all-zero placeholder
 * round would falsely suggest the file was touched that round.
 */
export function summarizeFixRegistry(
  registry: FixRegistry,
  opts: { round?: unknown; file?: unknown } = {},
): {
  totalFixed: number
  totalFailed: number
  roundCount: number
  rounds: { round: number; fixedCount: number; failedCount: number }[]
} {
  const roundFilter =
    typeof opts.round === 'number' && Number.isInteger(opts.round) && opts.round >= 0
      ? opts.round
      : undefined
  const fileFilter = typeof opts.file === 'string' && opts.file ? opts.file : undefined

  const rounds = (registry.rounds ?? [])
    .filter((r) => roundFilter === undefined || r.round === roundFilter)
    .flatMap((r) => {
      if (fileFilter === undefined) {
        // Coerce defensively so a hand-edited registry round missing either count
        // can never propagate NaN into the integer output fields.
        return [{
          round: r.round,
          fixedCount: Number(r.fixedCount) || 0,
          failedCount: Number(r.failedCount) || 0,
        }]
      }
      const kept = (r.records ?? []).filter((rec) => rec && rec.finding && rec.finding.file === fileFilter)
      if (kept.length === 0) return []
      // Recompute from the kept records: a rolled-back (success:false) record
      // counts as failed, matching the registry's own recomputeRoundCounts.
      return [{
        round: r.round,
        fixedCount: kept.filter((rec) => rec.success).length,
        failedCount: kept.filter((rec) => !rec.success).length,
      }]
    })
  return {
    totalFixed: rounds.reduce((s, r) => s + r.fixedCount, 0),
    totalFailed: rounds.reduce((s, r) => s + r.failedCount, 0),
    roundCount: rounds.length,
    rounds,
  }
}

/**
 * Register the `iterate_history` tool.
 * Reads the decision log (optionally filtered by type / since / round / file /
 * limit) and a fix-registry summary (scoped by the same round / file filters).
 * Read-only; never modifies the filesystem.
 */
export function registerHistoryTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_history',
      // Read-only audit view over on-disk state → safe to join a parallel
      // dispatch group alongside other read-only sibling calls.
      isConcurrencySafe: () => true,
      description:
        'Read the iteration history: decision-log entries (optionally filtered by entry `type`, `since` ' +
        'timestamp, `round`, fixed `file`, and a `limit`) plus a summary of the fix registry (per-round ' +
        'fixed/failed counts, scoped by the same round/file filters). ' +
        'Read-only — use it to review what the run did, audit a log, or inspect fixes.',
      parameters: {
        type: {
          type: 'string',
          description:
            'Optional entry-type filter: round_start, review_result, atomic_fix, architectural_fix, ' +
            'revert, round_failed, validation, decision, report, resume.',
        },
        since: {
          type: 'string',
          description: 'Optional ISO timestamp; only entries AFTER this timestamp are returned.',
        },
        round: {
          type: 'integer',
          description:
            'Optional round number; only decision-log entries logged for this round are returned, ' +
            'and the fix summary is scoped to this round.',
        },
        file: {
          type: 'string',
          description:
            'Optional fixed-file path; only decision-log entries whose `data.file` matches are returned, ' +
            'and the fix summary counts only fixes applied to that file.',
        },
        limit: {
          type: 'integer',
          description: `Max entries to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}). Returns the newest window in chronological order.`,
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
            kind: { type: 'string' },
            count: { type: 'integer' },
            filteredCount: { type: 'integer' },
            limit: { type: 'integer' },
            log: { type: 'json' },
            fixes: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `history failed: ${value.error}` }]
          const log = (value.log as DecisionLogEntry[] | undefined) ?? []
          const fixes = (value.fixes as { totalFixed: number; totalFailed: number; roundCount: number } | undefined)
          const lines = [
            `Decision-log entries: ${value.count} (filtered to ${value.limit})`,
            fixes
              ? `Fixes: ${fixes.totalFixed} applied · ${fixes.totalFailed} failed · across ${fixes.roundCount} round(s)`
              : 'Fixes: none',
            '',
            ...log.map((e) => `[${e.timestamp}] r${e.round ?? '?'} ${e.type}: ${JSON.stringify(e.data ?? {})}`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'history', error: resolved.reason }
        const projectRoot = resolved.root

        const { entries, filteredCount, limit } = filterDecisionEntries(
          readDecisionEntries(projectRoot),
          { type: args.type, since: args.since, limit: args.limit, round: args.round, file: args.file },
        )
        const fixes = summarizeFixRegistry(readRegistry(projectRoot), { round: args.round, file: args.file })

        return {
          ok: true,
          kind: 'history',
          count: entries.length,
          filteredCount,
          limit,
          log: entries as unknown as JsonValue,
          fixes: fixes as unknown as JsonValue,
        }
      },
    }),
  )
}
