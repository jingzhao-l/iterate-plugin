/**
 * src/tools/quality-gate.ts — quality gate query & write tool.
 *
 *   iterate_quality_gate — query the persisted quality certificate, or compute
 *                          and persist a new one from review/validation data.
 *
 * Provides a machine-readable quality certificate for the current iteration.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readQualityGate, writeQualityGate, computeQualityGate } from './quality-store.ts'
import type { QualityGateSnapshot } from '../types.ts'

/** Validate a single finding object; returns true when well-formed. */
function isValidFinding(raw: unknown): raw is { dimension: string; severity: string; file: string; line?: number } {
  if (!raw || typeof raw !== 'object') return false
  const f = raw as Record<string, unknown>
  return (
    typeof f.dimension === 'string' &&
    typeof f.severity === 'string' &&
    typeof f.file === 'string' &&
    (f.line === undefined || typeof f.line === 'number')
  )
}

/** Validate a single validation result; returns true when well-formed. */
function isValidValidationResult(raw: unknown): raw is { command: string; exitCode: number } {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return typeof r.command === 'string' && typeof r.exitCode === 'number' && Number.isFinite(r.exitCode)
}

/** Sanitize a caller-supplied per-dimension number map. */
function sanitizeNumberMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Sanitize a caller-supplied per-dimension round series map. */
function sanitizeRoundSeries(raw: unknown): Record<string, number[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const series = value
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      if (series.length > 0) out[key] = series
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Register the `iterate_quality_gate` tool.
 * Reads the persisted quality certificate, or computes + persists a new one.
 */
export function registerQualityGateTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_quality_gate',
      description:
        'Query or write the quality gate status: dimension convergence rates, verification pass rates, ' +
        'and overall PASS/FAIL status. ' +
        'Operation "read" (default) returns the persisted machine-readable quality certificate. ' +
        'Operation "compute" computes a fresh snapshot from this round\'s findings/validation results, ' +
        'persists it to .iterate/quality-gate.json, and returns it.',
      parameters: {
        operation: {
          type: 'string',
          description: 'Operation: read (load persisted certificate) or compute (recompute + persist). Default: read.',
          enum: ['read', 'compute'],
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dimensions to gate (required for compute).',
        },
        findings: {
          type: 'json',
          description:
            'Findings array (required for compute). Each item: { dimension, severity (critical|high|medium|low), file, line? }.',
        },
        validationResults: {
          type: 'json',
          description: 'Validation results array (optional for compute). Each item: { command, exitCode }.',
        },
        findingsByRound: {
          type: 'json',
          description:
            'Optional per-dimension NEW-finding counts across rounds (latest last) — used to compute real convergence rates. ' +
            'Example: { "correctness": [5, 2, 0] }.',
        },
        fixedByDimension: {
          type: 'json',
          description: 'Optional per-dimension count of fixed findings, e.g. { "correctness": 3 }.',
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
            snapshot: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `quality gate query failed: ${value.error}` }]
          const operation = typeof value.operation === 'string' ? value.operation : 'read'
          const snapshot = value.snapshot as unknown as QualityGateSnapshot
          if (!snapshot) return [{ type: 'text', text: 'No quality gate data available.' }]

          const statusEmoji = snapshot.overallStatus === 'pass' ? '✓' : snapshot.overallStatus === 'fail' ? '✗' : '○'
          const lines = [
            `${statusEmoji} Quality Gate: ${snapshot.overallStatus.toUpperCase()} (score: ${snapshot.overallScore})`,
            `Verification: ${snapshot.passedChecks}/${snapshot.totalChecks} passed (${snapshot.verificationPassRate}%)`,
            `Findings: ${snapshot.totalFindings} total (${snapshot.criticalCount} critical, ${snapshot.highCount} high, ${snapshot.mediumCount} medium, ${snapshot.lowCount} low)`,
            '',
            'Dimension Breakdown:',
            ...snapshot.dimensions.map((d) => {
              const dimStatus = d.status === 'pass' ? '✓' : d.status === 'warn' ? '!' : '✗'
              return `  ${dimStatus} ${d.dimension}: score=${d.score}, convergence=${d.convergenceRate}%, findings=${d.findingsCount}, fixed=${d.fixedCount}`
            }),
          ]
          if (snapshot.failReason) {
            lines.push('', `Fail Reason: ${snapshot.failReason}`)
          }
          if (operation === 'compute') {
            lines.push('', 'Quality gate snapshot computed and persisted.')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'quality_gate', error: resolved.reason }
        const projectRoot = resolved.root

        const operation = typeof args.operation === 'string' ? args.operation : 'read'

        if (operation === 'compute') {
          const dimensions = Array.isArray(args.dimensions)
            ? args.dimensions.filter((d): d is string => typeof d === 'string' && d.length > 0)
            : []
          const findings = Array.isArray(args.findings) ? args.findings.filter(isValidFinding) : []
          const validationResults = Array.isArray(args.validationResults)
            ? args.validationResults.filter(isValidValidationResult)
            : undefined
          const findingsByRound = sanitizeRoundSeries(args.findingsByRound)
          const fixedByDimension = sanitizeNumberMap(args.fixedByDimension)

          const snapshot = computeQualityGate({
            dimensions,
            findings,
            validationResults,
            findingsByRound,
            fixedByDimension,
          })
          const write = writeQualityGate(projectRoot, snapshot)
          if (!write.ok) {
            return { ok: false, kind: 'quality_gate', operation: 'compute', error: write.error }
          }
          return {
            ok: true,
            kind: 'quality_gate',
            operation: 'compute',
            snapshot: snapshot as unknown as JsonValue,
          }
        }

        const snapshot = readQualityGate(projectRoot)
        return {
          ok: true,
          kind: 'quality_gate',
          operation: 'read',
          snapshot: snapshot as unknown as JsonValue,
        }
      },
    }),
  )
}