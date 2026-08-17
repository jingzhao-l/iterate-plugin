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
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { resolveProjectRoot } from '../config-loader.ts'
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
 */
export function filterDecisionEntries(
  entries: DecisionLogEntry[],
  opts: { type?: unknown; since?: unknown; limit?: unknown },
): { entries: DecisionLogEntry[]; filteredCount: number; limit: number } {
  const type = typeof opts.type === 'string' && opts.type ? opts.type : undefined
  const since = typeof opts.since === 'string' && opts.since ? opts.since : undefined
  const limit = clampHistoryLimit(opts.limit as number | undefined)

  const matching = (Array.isArray(entries) ? entries : []).filter((e) => {
    if (type && e.type !== type) return false
    if (since && e.timestamp <= since) return false
    return true
  })
  return {
    entries: matching.slice(-limit),
    filteredCount: matching.length,
    limit,
  }
}

/** Per-round fix counts + totals from a fix registry. Pure, unit-tested. */
export function summarizeFixRegistry(registry: FixRegistry): {
  totalFixed: number
  totalFailed: number
  roundCount: number
  rounds: { round: number; fixedCount: number; failedCount: number }[]
} {
  const rounds = (registry.rounds ?? []).map((r) => ({
    round: r.round,
    fixedCount: r.fixedCount,
    failedCount: r.failedCount,
  }))
  return {
    totalFixed: rounds.reduce((s, r) => s + r.fixedCount, 0),
    totalFailed: rounds.reduce((s, r) => s + r.failedCount, 0),
    roundCount: rounds.length,
    rounds,
  }
}

/**
 * Register the `iterate_history` tool.
 * Reads the decision log (optionally filtered by type / since / limit) and a
 * fix-registry summary. Read-only; never modifies the filesystem.
 */
export function registerHistoryTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_history',
      description:
        'Read the iteration history: decision-log entries (optionally filtered by entry `type`, `since` ' +
        'timestamp, and a `limit`) plus a summary of the fix registry (per-round fixed/failed counts). ' +
        'Read-only — use it to review what the run did, audit a log, or inspect fixes.',
      parameters: {
        type: {
          type: 'string',
          description:
            'Optional entry-type filter: round_start, review_result, atomic_fix, architectural_fix, ' +
            'revert, validation, decision, report.',
        },
        since: {
          type: 'string',
          description: 'Optional ISO timestamp; only entries AFTER this timestamp are returned.',
        },
        limit: {
          type: 'integer',
          description: `Max entries to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}). Newest first.`,
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
            ...log.map((e) => `[${e.timestamp}] r${e.round} ${e.type}: ${JSON.stringify(e.data ?? {})}`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args) {
        const resolved = resolveProjectRoot(args.path)
        if (!resolved.ok) return { ok: false, kind: 'history', error: resolved.reason }
        const projectRoot = resolved.root

        const { entries, filteredCount, limit } = filterDecisionEntries(
          readDecisionEntries(projectRoot),
          { type: args.type, since: args.since, limit: args.limit },
        )
        const fixes = summarizeFixRegistry(readRegistry(projectRoot))

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
