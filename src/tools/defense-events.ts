/**
 * src/tools/defense-events.ts — defense event stream query tool.
 *
 *   iterate_defense_events — browse/search defense events from the current iteration.
 *
 * Defense events include: precondition failures, rollbacks, invariant violations,
 * and assumption falsifications. Read-only; provides visibility into defensive actions.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readDefenseEvents } from './defense-store.ts'
import type { DefenseEvent, DefenseEventType } from '../types.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/** Clamp a caller-supplied limit to a sane range. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(limit, MAX_LIMIT)
}

/** Human-readable labels for defense event types. */
const EVENT_TYPE_LABELS: Record<DefenseEventType, string> = {
  precondition_failed: '前置校验失败',
  rollback: '回滚',
  invariant_violated: '不变量违反',
  assumption_falsified: '假设被证伪',
}

/**
 * Register the `iterate_defense_events` tool.
 * Queries defense events from the current iteration.
 */
export function registerDefenseEventsTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_defense_events',
      description:
        'Query defense events: precondition failures, rollbacks, invariant violations, ' +
        'and assumption falsifications. Returns events with descriptions and outcomes. ' +
        'Read-only — use it to review what defensive actions were taken.',
      parameters: {
        operation: {
          type: 'string',
          description: 'Operation: list (browse all), counts (summary by type). Default: list.',
        },
        type: {
          type: 'string',
          description: 'Filter by event type: precondition_failed, rollback, invariant_violated, assumption_falsified.',
        },
        round: {
          type: 'integer',
          description: 'Filter by round number.',
        },
        severity: {
          type: 'string',
          description: 'Filter by severity: critical, high, medium, low.',
        },
        limit: {
          type: 'integer',
          description: `Max events to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}).`,
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
            operation: { type: 'string' },
            count: { type: 'integer' },
            events: { type: 'json' },
            counts: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `defense events query failed: ${value.error}` }]

          if (value.operation === 'counts' && value.counts) {
            const counts = value.counts as Record<DefenseEventType, number>
            const lines = [
              'Defense Event Summary:',
              ...Object.entries(EVENT_TYPE_LABELS).map(([type, label]) =>
                `  ${label}: ${counts[type as DefenseEventType] ?? 0}`
              ),
              `  Total: ${Object.values(counts).reduce((a, b) => a + b, 0)}`,
            ]
            return [{ type: 'text', text: lines.join('\n') }]
          }

          const events = (value.events as DefenseEvent[] | undefined) ?? []
          if (events.length === 0) {
            return [{ type: 'text', text: 'No defense events recorded.' }]
          }

          const lines = [
            `Defense Events (${value.count} total):`,
            '',
            ...events.map((e) => {
              const typeLabel = EVENT_TYPE_LABELS[e.type] ?? e.type
              return `[${e.id}] Round ${e.round} - ${typeLabel}\n  ${e.description}\n  Outcome: ${e.outcome}`
            }),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'defense_events', error: resolved.reason }
        const projectRoot = resolved.root

        const operation = typeof args.operation === 'string' ? args.operation : 'list'
        const limit = clampLimit(args.limit as number | undefined)

        const stream = readDefenseEvents(projectRoot)

        if (operation === 'counts') {
          return {
            ok: true,
            kind: 'defense_events',
            operation: 'counts',
            counts: stream.counts as unknown as JsonValue,
          }
        }

        // Filter events
        let events = stream.events

        if (typeof args.type === 'string' && args.type) {
          events = events.filter((e) => e.type === args.type)
        }
        if (typeof args.round === 'number') {
          events = events.filter((e) => e.round === args.round)
        }
        if (typeof args.severity === 'string' && args.severity) {
          events = events.filter((e) => e.severity === args.severity)
        }

        // Sort by timestamp descending (newest first)
        events.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

        return {
          ok: true,
          kind: 'defense_events',
          operation: 'list',
          count: Math.min(events.length, limit),
          events: events.slice(0, limit) as unknown as JsonValue,
        }
      },
    }),
  )
}