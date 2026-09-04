/**
 * src/tools/quality-gate.ts — quality gate query tool.
 *
 *   iterate_quality_gate — query quality gate status, convergence rates,
 *                          and verification results.
 *
 * Provides a machine-readable quality certificate for the current iteration.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { readQualityGate } from './quality-store.ts'
import type { QualityGateSnapshot } from '../types.ts'

/**
 * Register the `iterate_quality_gate` tool.
 * Queries quality gate status and provides a machine-readable quality certificate.
 */
export function registerQualityGateTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_quality_gate',
      description:
        'Query the quality gate status: dimension convergence rates, verification pass rates, ' +
        'and overall PASS/FAIL status. Returns a machine-readable quality certificate. ' +
        'Read-only — use it to check if the iteration meets quality thresholds.',
      parameters: {
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
            snapshot: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `quality gate query failed: ${value.error}` }]
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
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'quality_gate', error: resolved.reason }
        const projectRoot = resolved.root

        const snapshot = readQualityGate(projectRoot)
        return {
          ok: true,
          kind: 'quality_gate',
          snapshot: snapshot as unknown as JsonValue,
        }
      },
    }),
  )
}