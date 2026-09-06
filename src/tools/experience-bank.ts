/**
 * src/tools/experience-bank.ts — experience bank query tool.
 *
 *   iterate_experience — browse, search, query, and add project experience entries.
 *
 * Experiences are accumulated across sessions and stored in .iterate/experience.json.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readExperienceBank, writeExperienceBank, searchExperienceEntries, upsertExperience } from './experience-store.ts'
import type { ExperienceEntryInput } from './experience-store.ts'
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

/** Validate a caller-supplied experience entry object. Returns error strings. */
function validateExperienceInput(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['entry must be a JSON object']
  }
  const e = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof e.pattern !== 'string' || !e.pattern.trim()) errors.push('.pattern is required')
  if (typeof e.dimension !== 'string' || !e.dimension.trim()) errors.push('.dimension is required')
  if (typeof e.description !== 'string' || !e.description.trim()) errors.push('.description is required')
  if (typeof e.verifiedFix !== 'string' || !e.verifiedFix.trim()) errors.push('.verifiedFix is required')
  if (typeof e.findingSummary !== 'string' || !e.findingSummary.trim()) errors.push('.findingSummary is required')
  const severity = e.severity
  if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low') {
    errors.push('.severity must be one of critical, high, medium, low')
  }
  if (!Array.isArray(e.files) || !e.files.every((f) => typeof f === 'string' && f.length > 0)) {
    errors.push('.files must be an array of non-empty strings')
  }
  if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) {
    errors.push('.tags must be an array of strings')
  }
  return errors
}

/** Normalize a validated raw entry into the store input shape. */
function normalizeExperienceInput(raw: Record<string, unknown>): ExperienceEntryInput {
  return {
    ...(typeof raw.id === 'string' && raw.id.length > 0 ? { id: raw.id } : {}),
    pattern: raw.pattern as string,
    description: raw.description as string,
    verifiedFix: raw.verifiedFix as string,
    dimension: raw.dimension as string,
    findingSummary: raw.findingSummary as string,
    severity: raw.severity as ExperienceEntryInput['severity'],
    files: raw.files as string[],
    tags: raw.tags as string[],
  }
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
        'Query or extend the experience bank: browse/search historical fixes and patterns, ' +
        'or record a new verified fix (operation:"add"). ' +
        'List/search/get return matching entries with hit counts, verified fixes, and related context. ' +
        '"add" upserts an experience entry into .iterate/experience.json — a repeat of the same ' +
        'pattern+dimension increments its hit count instead of duplicating it. ' +
        'Use it to remember fixes that worked so future rounds apply them first.',
      parameters: {
        operation: {
          type: 'string',
          description: 'Operation: list (browse all), search (by query), get (by id), add (add a new experience). Default: list.',
          enum: ['list', 'search', 'get', 'add'],
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
          description: 'Experience ID (for get operation, or to update a specific entry via add).',
        },
        entry: {
          type: 'json',
          description:
            'Experience entry object (required for add). Fields: id (optional), pattern, dimension, description, ' +
            'verifiedFix, findingSummary, severity (critical|high|medium|low), files (string[]), tags (string[]).',
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
            added: { type: 'boolean' },
            errors: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `experience query failed: ${value.error}` }]
          if (value.operation === 'add' && value.entry) {
            const entry = value.entry as unknown as ExperienceEntry
            return [{ type: 'text', text: [
              value.added
                ? `Recorded new experience: ${entry.id}`
                : `Experience already known (hit ${entry.hitCount}): ${entry.id}`,
              `Pattern: ${entry.pattern}`,
              `Dimension: ${entry.dimension}`,
              `Description: ${entry.description}`,
              `Fix: ${entry.verifiedFix}`,
              `Files: ${entry.files.join(', ')}`,
              `Tags: ${entry.tags.join(', ')}`,
            ].join('\n') }]
          }
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

        if (operation === 'add') {
          const raw = args.entry
          const errors = validateExperienceInput(raw)
          if (errors.length > 0) {
            return {
              ok: false,
              kind: 'experience',
              operation: 'add',
              errors: errors as unknown as JsonValue,
              error: `Invalid experience entry: ${errors.join('; ')}`,
            }
          }
          const bank = readExperienceBank(projectRoot)
          const { bank: next, added, entryId } = upsertExperience(bank, normalizeExperienceInput(raw as Record<string, unknown>))
          const write = writeExperienceBank(projectRoot, next)
          if (!write.ok) {
            return { ok: false, kind: 'experience', operation: 'add', error: write.error }
          }
          const entry = next.entries.find((e) => e.id === entryId)
          return {
            ok: true,
            kind: 'experience',
            operation: 'add',
            added,
            count: next.entries.length,
            entry: entry as unknown as JsonValue,
            totalHits: next.totalHits,
          }
        }

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