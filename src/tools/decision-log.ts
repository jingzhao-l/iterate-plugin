import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { resolveProjectRoot } from '../config-loader.ts'
import type { DecisionLogEntry } from '../types.ts'

const LOG_DIR = '.iterate'
const LOG_FILE = 'decision-log.jsonl'

/** All valid DecisionLogEntry `type` values (must stay in sync with Types). */
const VALID_ENTRY_TYPES = new Set<DecisionLogEntry['type']>([
  'round_start',
  'review_result',
  'atomic_fix',
  'architectural_fix',
  'revert',
  'round_failed',
  'validation',
  'decision',
  'report',
  'resume',
])

/**
 * Validate a candidate (type, round, data) triple for an append operation.
 * Returns an error string on failure, or null when the entry is well-formed.
 */
function validateEntryInput(type: unknown, round: unknown, data: unknown): string | null {
  if (typeof type !== 'string' || !VALID_ENTRY_TYPES.has(type as DecisionLogEntry['type'])) {
    return `type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}.`
  }
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    return 'round must be a positive integer.'
  }
  if (data !== undefined && data !== null && typeof data !== 'object') {
    return 'data must be an object (or omitted).'
  }
  return null
}

/**
 * Resolve the log file path, creating the directory if needed.
 */
function logPath(projectRoot: string): string {
  const dir = join(projectRoot, LOG_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, LOG_FILE)
}

/**
 * Append one entry to the decision log (JSONL format).
 * Returns the entry count after appending.
 */
export function appendDecisionEntry(projectRoot: string, entry: DecisionLogEntry): { count: number; path: string } {
  const filePath = logPath(projectRoot)
  const line = JSON.stringify(entry) + '\n'
  appendFileSync(filePath, line, 'utf-8')
  // Count entries
  let count = 0
  try {
    const content = readFileSync(filePath, 'utf-8')
    count = content.split('\n').filter((l) => l.trim().length > 0).length
  } catch {
    count = 1
  }
  return { count, path: filePath }
}

/**
 * Read all entries from the decision log.
 */
export function readDecisionEntries(projectRoot: string): DecisionLogEntry[] {
  const filePath = join(projectRoot, LOG_DIR, LOG_FILE)
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as DecisionLogEntry)
  } catch {
    return []
  }
}

/**
 * Register the `iterate_decision_log` tool.
 * Append-only decision log stored in .iterate/decision-log.jsonl.
 * Supports `append` and `read` operations.
 */
export function registerDecisionLogTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_decision_log',
      description:
        'Append-only decision log for the iterate loop. ' +
        'Use `append` to record a round start, review finding, fix, validation result, or decision. ' +
        'Use `read` to retrieve all entries for review. ' +
        'The log is stored in .iterate/decision-log.jsonl and persists across sessions.',

      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"append" to add an entry, "read" to retrieve all entries.',
          enum: ['append', 'read'],
        },
        type: {
          type: 'string',
          description:
            'Entry type (required for append): round_start, review_result, atomic_fix, ' +
            'architectural_fix, revert, round_failed, validation, decision, report, resume.',
          enum: [
            'round_start',
            'review_result',
            'atomic_fix',
            'architectural_fix',
            'revert',
            'round_failed',
            'validation',
            'decision',
            'report',
            'resume',
          ],
        },
        round: {
          type: 'integer',
          description: 'Current iteration round number (required for append).',
        },
        data: {
          type: 'json',
          description: 'Entry payload as JSON object (required for append).',
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
            entryCount: { type: 'integer' },
            logPath: { type: 'string' },
            entries: { type: 'json' },
            success: { type: 'boolean' },
            entry: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args) {
        const resolved = resolveProjectRoot(args.path)
        if (!resolved.ok) {
          return { operation: args.operation, error: resolved.reason }
        }
        const projectRoot = resolved.root

        if (args.operation === 'read') {
          const entries = readDecisionEntries(projectRoot)
          return {
            operation: 'read',
            entryCount: entries.length,
            logPath: join(projectRoot, LOG_DIR, LOG_FILE),
            entries: entries as unknown as JsonValue,
          }
        }

        if (args.operation === 'append') {
          const invalid = validateEntryInput(args.type, args.round, args.data)
          if (invalid !== null) {
            return {
              operation: 'append',
              error: invalid,
            }
          }
          const type = args.type as DecisionLogEntry['type']
          const round = args.round as number
          const data = args.data === undefined || args.data === null
            ? {}
            : args.data as Record<string, unknown>

          const entry: DecisionLogEntry = {
            timestamp: new Date().toISOString(),
            round,
            type,
            data,
          }

          const result = appendDecisionEntry(projectRoot, entry)
          return {
            operation: 'append',
            success: true,
            entryCount: result.count,
            logPath: result.path,
            entry: entry as unknown as JsonValue,
          }
        }

        return {
          operation: args.operation,
          error: `Unknown operation "${args.operation}". Use "append" or "read".`,
        }
      },
    }),
  )
}