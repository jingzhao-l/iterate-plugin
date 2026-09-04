/**
 * src/tools/experience-bank.ts — experience bank query tool.
 *
 *   iterate_experience — browse, search, and query project experience entries.
 *                        Read-only; used to find historical fixes and patterns.
 *
 * Experiences are accumulated across sessions and stored in .iterate/experience.json.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readExperienceBank, searchExperienceEntries } from './experience-store.ts'
import type { ExperienceEntry } from '../types.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/** Clamp a caller-supplied limit to a sane range. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(limit, MAX_LIMIT)
}

/**
 * Register the `iterate_experience` tool.
 * Queries the experience bank for historical fixes and patterns.
 */
export function registerExperienceBankTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_experience',
      description:
        'Query the experience bank: browse/search historical fixes and patterns. ' +
        'Returns matching entries with hit counts, verified fixes, and related context. ' +
        'Read-only — use it to find similar issues from the past.',
      parameters: {
        operation: {
          type: 'string',
          description: 'Operation: list (browse all), search (by query), get (by id). Default: list.',
        },
        query: {
          type: 'string',
          description: 'Search query (for search operation). Matches against pattern, description, files, tags.',
        },
        dimension: {
          type: 'string',
          description: 'Filter by dimension (e.g., correctness, security, performance).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags (AND logic).',
        },
        id: {
          type: 'string',
          description: 'Experience ID (for get operation).',
        },
        limit: {
          type: 'integer',
          description: `Max entries to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}).`,
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
            entries: { type: 'json' },
            entry: { type: 'json' },
            totalHits: { type: 'integer' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `experience query failed: ${value.error}` }]
          if (value.operation === 'get' && value.entry) {
            const entry = value.entry as unknown as ExperienceEntry
            return [{ type: 'text', text: [
              `Experience: ${entry.id}`,
              `Pattern: ${entry.pattern}`,
              `Description: ${entry.description}`,
              `Fix: ${entry.verifiedFix}`,
              `Files: ${entry.files.join(', ')}`,
              `Hits: ${entry.hitCount}`,
              `Tags: ${entry.tags.join(', ')}`,
            ].join('\n') }]
          }
          const entries = (value.entries as unknown as ExperienceEntry[] | undefined) ?? []
          const lines = [
            `Found ${value.count} experience(s) (total hits: ${value.totalHits})`,
            '',
            ...entries.map((e) => `[${e.id}] ${e.pattern} (hits: ${e.hitCount}) - ${e.description}`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'experience', error: resolved.reason }
        const projectRoot = resolved.root

        const operation = typeof args.operation === 'string' ? args.operation : 'list'
        const limit = clampLimit(args.limit as number | undefined)

        const bank = readExperienceBank(projectRoot)

        if (operation === 'get' && typeof args.id === 'string') {
          const entry = bank.entries.find((e) => e.id === args.id)
          if (!entry) {
            return { ok: false, kind: 'experience', error: `Experience not found: ${args.id}` }
          }
          return {
            ok: true,
            kind: 'experience',
            operation: 'get',
            count: 1,
            entry: entry as unknown as JsonValue,
            totalHits: bank.totalHits,
          }
        }

        if (operation === 'search' && typeof args.query === 'string') {
          const entries = searchExperienceEntries(bank.entries, args.query, {
            dimension: typeof args.dimension === 'string' ? args.dimension : undefined,
            tags: Array.isArray(args.tags) ? args.tags : undefined,
          }).slice(0, limit)

          return {
            ok: true,
            kind: 'experience',
            operation: 'search',
            count: entries.length,
            entries: entries as unknown as JsonValue,
            totalHits: bank.totalHits,
          }
        }

        // Default: list with optional filters
        let entries = bank.entries
        if (typeof args.dimension === 'string' && args.dimension) {
          entries = entries.filter((e) => e.dimension === args.dimension)
        }
        if (Array.isArray(args.tags) && args.tags.length > 0) {
          entries = entries.filter((e) => args.tags!.every((t: string) => e.tags.includes(t)))
        }

        return {
          ok: true,
          kind: 'experience',
          operation: 'list',
          count: Math.min(entries.length, limit),
          entries: entries.slice(0, limit) as unknown as JsonValue,
          totalHits: bank.totalHits,
        }
      },
    }),
  )
}