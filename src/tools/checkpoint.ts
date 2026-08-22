/**
 * src/tools/checkpoint.ts — iteration checkpoint + status tools.
 *
 *   iterate_checkpoint — save / load / clear a resume checkpoint so a long
 *                        iteration can continue where it left off.
 *   iterate_status     — summarize the current iteration state from the
 *                        decision log, fix registry, and checkpoint.
 *
 * Checkpoint layout: `.iterate/checkpoint.json`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { checkpointPath, iterateDir } from '../paths.ts'
import { readRegistry } from './fix.ts'
import { readDecisionEntries } from './decision-log.ts'
import type { IterationCheckpoint, IterationStatus } from '../types.ts'

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/** Read a checkpoint from disk (missing/corrupt → null). */
export function readCheckpoint(projectRoot: string): IterationCheckpoint | null {
  const file = checkpointPath(projectRoot)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as IterationCheckpoint
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.mode !== 'dry-run' && parsed.mode !== 'normal') return null
    if (typeof parsed.round !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** Validate a checkpoint payload (returns error string or null). */
export function validateCheckpoint(input: {
  mode: unknown
  round: unknown
  maxRounds: unknown
  fixedCount: unknown
  architecturalCount: unknown
  resumeCount?: unknown
}): string | null {
  if (input.mode !== 'dry-run' && input.mode !== 'normal') {
    return 'mode must be "dry-run" or "normal"'
  }
  if (typeof input.round !== 'number' || !Number.isInteger(input.round) || input.round < 0) {
    return 'round must be a non-negative integer'
  }
  if (typeof input.maxRounds !== 'number' || !Number.isInteger(input.maxRounds) || input.maxRounds < 1) {
    return 'maxRounds must be a positive integer'
  }
  if (typeof input.fixedCount !== 'number' || !Number.isInteger(input.fixedCount) || input.fixedCount < 0) {
    return 'fixedCount must be a non-negative integer'
  }
  if (typeof input.architecturalCount !== 'number' || !Number.isInteger(input.architecturalCount) || input.architecturalCount < 0) {
    return 'architecturalCount must be a non-negative integer'
  }
  if (
    input.resumeCount !== undefined &&
    (typeof input.resumeCount !== 'number' || !Number.isInteger(input.resumeCount) || input.resumeCount < 0)
  ) {
    return 'resumeCount must be a non-negative integer'
  }
  return null
}

/**
 * Compute a status summary from the runtime artifacts.
 * Pure (no I/O) — all reads are injected, so it is unit-testable.
 */
export function computeStatus(input: {
  checkpoint: IterationCheckpoint | null
  decisionEntries: { timestamp: string; type: string; round?: number; data?: Record<string, unknown> }[]
  fixRegistry: { rounds: { round: number; fixedCount: number; failedCount: number }[] }
}): IterationStatus {
  const checkpoint = input.checkpoint
  const entries = input.decisionEntries
  const registry = input.fixRegistry

  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null
  const lastUpdated = lastEntry?.timestamp ?? checkpoint?.updatedAt ?? null

  // Round = checkpoint.round (explicit) or max round seen in the decision log.
  let currentRound = checkpoint?.round ?? 0
  if (!checkpoint) {
    for (const e of entries) {
      if (typeof e.round === 'number' && e.round > currentRound) currentRound = e.round
    }
  }

  const totalRounds = checkpoint?.maxRounds ?? currentRound
  const registryFixed = registry.rounds.reduce((sum, r) => sum + r.fixedCount, 0)
  const failedCount = registry.rounds.reduce((sum, r) => sum + r.failedCount, 0)
  // When a checkpoint exists, its snapshot fields are authoritative for resume
  // (fixedCount / architecturalCount / findings); otherwise derive from the
  // live fix registry and decision log.
  const fixedCount = checkpoint ? checkpoint.fixedCount : registryFixed
  const architecturalCount = checkpoint?.architecturalCount ?? 0

  return {
    mode: checkpoint?.mode ?? null,
    currentRound,
    totalRounds,
    fixedCount,
    architecturalCount,
    // A checkpoint may predate the `findings` field (or be hand-edited) — a
    // missing findings must degrade to 0, never throw.
    findingsCount: Array.isArray(checkpoint?.findings) ? checkpoint.findings.length : 0,
    totalDecisionLogEntries: entries.length,
    hasCheckpoint: checkpoint !== null,
    // A checkpoint left on disk means the previous run was interrupted before
    // it could clear it — this is the durable "interruption" signal.
    interrupted: checkpoint !== null,
    resumeCount: checkpoint?.resumeCount ?? 0,
    checkpoint,
    lastUpdated,
  }
}

// ─── iterate_checkpoint ──────────────────────────────────────────────────────

/**
 * Register the `iterate_checkpoint` tool.
 * Saves progress so the orchestrator can resume a long iteration.
 */
export function registerCheckpointTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_checkpoint',
      description:
        'Save / load / clear the iteration checkpoint. The workflow saves a checkpoint at the start of ' +
        'each round (so a long run can resume) and clears it when the iteration completes.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"save" to persist the current progress, "load" to read it back, "clear" to remove it.',
          enum: ['save', 'load', 'clear'],
        },
        mode: { type: 'string', description: 'Required for save: "dry-run" or "normal".' },
        round: { type: 'integer', description: 'Required for save: current round number (0 = none started).' },
        maxRounds: { type: 'integer', description: 'Required for save: total round cap.' },
        fixedCount: { type: 'integer', description: 'Required for save: number of fixes applied so far.' },
        architecturalCount: { type: 'integer', description: 'Required for save: architectural findings left unfixed.' },
        resumeCount: { type: 'integer', description: 'Optional for save: how many times this checkpoint has already been resumed after an interruption (default 0).' },
        findings: { type: 'json', description: 'Optional for save: the current deduped findings to resume from.' },
        path: { type: 'string', description: 'Project root directory (default: current working directory).' },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            checkpoint: { type: 'json' },
            existed: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { operation: args.operation, ok: false, error: resolved.reason }
        const projectRoot = resolved.root

        if (args.operation === 'load') {
          const checkpoint = readCheckpoint(projectRoot)
          return { operation: 'load', ok: true, checkpoint: checkpoint as unknown as JsonValue | null }
        }

        if (args.operation === 'clear') {
          const existed = existsSync(checkpointPath(projectRoot))
          if (existed) {
            try { rmSync(checkpointPath(projectRoot), { force: true }) } catch (err) {
              return { operation: 'clear', ok: false, existed, error: `failed to clear checkpoint: ${String(err)}` }
            }
          }
          return { operation: 'clear', ok: true, existed }
        }

        if (args.operation === 'save') {
          const invalid = validateCheckpoint({
            mode: args.mode,
            round: args.round,
            maxRounds: args.maxRounds,
            fixedCount: args.fixedCount,
            architecturalCount: args.architecturalCount,
            resumeCount: args.resumeCount,
          })
          if (invalid) return { operation: 'save', ok: false, error: invalid }
          const checkpoint: IterationCheckpoint = {
            mode: args.mode as 'dry-run' | 'normal',
            round: args.round as number,
            maxRounds: args.maxRounds as number,
            fixedCount: args.fixedCount as number,
            architecturalCount: args.architecturalCount as number,
            resumeCount: (typeof args.resumeCount === 'number' ? args.resumeCount : 0),
            findings: (Array.isArray(args.findings) ? args.findings : []) as unknown as IterationCheckpoint['findings'],
            startedAt: readCheckpoint(projectRoot)?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          try {
            mkdirSync(iterateDir(projectRoot), { recursive: true })
            // Atomic write (temp + rename): a crash mid-write must not corrupt
            // the checkpoint and silently lose the interruption state.
            const cpPath = checkpointPath(projectRoot)
            const tmpPath = `${cpPath}.tmp-${Date.now()}`
            writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8')
            renameSync(tmpPath, cpPath)
          } catch (err) {
            return { operation: 'save', ok: false, error: `failed to write checkpoint: ${String(err)}` }
          }
          return { operation: 'save', ok: true, checkpoint: checkpoint as unknown as JsonValue }
        }

        return { operation: args.operation, ok: false, error: 'unknown operation. Use "save", "load", or "clear".' }
      },
    }),
  )
}

// ─── iterate_status ──────────────────────────────────────────────────────────

/**
 * Register the `iterate_status` tool.
 * Summarizes the current iteration state (mode, round, fixed count, findings).
 */
export function registerStatusTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_status',
      description:
        'Summarize the current iterate run: mode, current round vs total, fixes applied, architectural ' +
        'findings remaining, decision-log size, and whether a resume checkpoint exists.',
      parameters: {
        path: { type: 'string', description: 'Project root directory (default: current working directory).' },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            mode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            currentRound: { type: 'integer' },
            totalRounds: { type: 'integer' },
            fixedCount: { type: 'integer' },
            architecturalCount: { type: 'integer' },
            findingsCount: { type: 'integer' },
            totalDecisionLogEntries: { type: 'integer' },
            hasCheckpoint: { type: 'boolean' },
            interrupted: { type: 'boolean', description: 'True when a checkpoint exists, meaning the previous run was interrupted before finishing.' },
            resumeCount: { type: 'integer', description: 'How many times the current checkpoint has already been resumed.' },
            lastUpdated: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `status failed: ${value.error}` }]
          const lines = [
            `Mode: ${value.mode ?? 'none'}`,
            `Round: ${value.currentRound} / ${value.totalRounds}`,
            `Fixed: ${value.fixedCount} · Architectural remaining: ${value.architecturalCount}`,
            `Findings in checkpoint: ${value.findingsCount}`,
            `Decision-log entries: ${value.totalDecisionLogEntries}`,
            `Checkpoint: ${value.hasCheckpoint ? 'yes' : 'no'}${value.interrupted ? ' (interrupted — resumable)' : ''}${value.resumeCount ? ` · resumed ${value.resumeCount}x` : ''}`,
            value.lastUpdated ? `Last updated: ${value.lastUpdated}` : '',
          ]
          return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, error: resolved.reason }
        const projectRoot = resolved.root
        const status = computeStatus({
          checkpoint: readCheckpoint(projectRoot),
          decisionEntries: readDecisionEntries(projectRoot),
          fixRegistry: readRegistry(projectRoot),
        })
        return {
          ok: true,
          mode: status.mode ?? null,
          currentRound: status.currentRound,
          totalRounds: status.totalRounds,
          fixedCount: status.fixedCount,
          architecturalCount: status.architecturalCount,
          findingsCount: status.findingsCount,
          totalDecisionLogEntries: status.totalDecisionLogEntries,
          hasCheckpoint: status.hasCheckpoint,
          interrupted: status.interrupted,
          resumeCount: status.resumeCount,
          lastUpdated: status.lastUpdated ?? null,
        }
      },
    }),
  )
}
