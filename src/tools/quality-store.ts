/**
 * src/tools/quality-store.ts — quality gate storage layer.
 *
 * Provides read/write access to quality gate data stored in
 * .iterate/quality-gate.json. Quality gate snapshots are generated
 * from review results and validation outcomes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QualityGateSnapshot, QualityGateDimension } from '../types.ts'

const QUALITY_GATE_FILE = 'quality-gate.json'

/** Default empty quality gate snapshot. */
function emptySnapshot(): QualityGateSnapshot {
  return {
    timestamp: new Date().toISOString(),
    overallStatus: 'pending',
    overallScore: 0,
    dimensions: [],
    verificationPassRate: 0,
    totalChecks: 0,
    passedChecks: 0,
    failedChecks: 0,
    totalFindings: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
  }
}

/**
 * Read the quality gate snapshot from disk.
 * Normalizes a hand-edited / partial file so readers and the tool's `render`
 * never crash on missing arrays or non-numeric fields: `dimensions` is
 * guaranteed to be an array and every numeric field degrades to 0.
 */
export function readQualityGate(projectRoot: string): QualityGateSnapshot {
  const filePath = path.join(projectRoot, '.iterate', QUALITY_GATE_FILE)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<QualityGateSnapshot> | null
    if (parsed && typeof parsed === 'object') {
      const num = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0
      const status: QualityGateSnapshot['overallStatus'] =
        parsed.overallStatus === 'pass' || parsed.overallStatus === 'fail' || parsed.overallStatus === 'pending'
          ? parsed.overallStatus
          : 'pending'
      const dimensions = Array.isArray(parsed.dimensions)
        ? (parsed.dimensions as unknown as Array<Record<string, unknown>>)
            .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof d.dimension === 'string')
            .map((d) => {
              const dimStatus: QualityGateDimension['status'] =
                d.status === 'pass' || d.status === 'fail' || d.status === 'warn' ? d.status : 'warn'
              return {
                dimension: d.dimension as string,
                convergenceRate: num(d.convergenceRate),
                findingsCount: num(d.findingsCount),
                fixedCount: num(d.fixedCount),
                score: num(d.score),
                status: dimStatus,
              }
            })
        : []
      return {
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : emptySnapshot().timestamp,
        overallStatus: status,
        overallScore: num(parsed.overallScore),
        dimensions,
        verificationPassRate: num(parsed.verificationPassRate),
        totalChecks: num(parsed.totalChecks),
        passedChecks: num(parsed.passedChecks),
        failedChecks: num(parsed.failedChecks),
        totalFindings: num(parsed.totalFindings),
        criticalCount: num(parsed.criticalCount),
        highCount: num(parsed.highCount),
        mediumCount: num(parsed.mediumCount),
        lowCount: num(parsed.lowCount),
        // Only carry an own failReason when it is a real string — an absent
        // persisted reason must not surface as `failReason: undefined` (which
        // deep-equals differently than the JSON round-trip of computeQualityGate).
        ...(typeof parsed.failReason === 'string' ? { failReason: parsed.failReason } : {}),
      }
    }
  } catch {
    // File not found or invalid JSON
  }
  return emptySnapshot()
}

/**
 * Write the quality gate snapshot to disk.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` when the write
 * fails — a caller must surface the failure instead of reporting success for
 * a snapshot that was never persisted.
 */
export function writeQualityGate(
  projectRoot: string,
  snapshot: QualityGateSnapshot,
): { ok: true } | { ok: false; error: string } {
  const dirPath = path.join(projectRoot, '.iterate')
  const filePath = path.join(dirPath, QUALITY_GATE_FILE)

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  } catch (err) {
    return { ok: false, error: `unable to write ${filePath}: ${String(err)}` }
  }
  return { ok: true }
}

/**
 * Compute the convergence rate for a dimension.
 *
 * Convergence measures how much NEW-finding volume shrank across rounds:
 * `(first - last) / first` from the dimension's per-round findings series,
 * expressed as a 0-100 percentage, clamped. A series with no fresh findings
 * (or a dimension never reporting a first-round reading) counts as fully
 * converged (100). Returns 0 — no measurable improvement — when a reading
 * exists but the series is empty or malformed.
 */
export function convergenceRateFor(series: number[] | undefined, currentCount: number): number {
  if (Array.isArray(series) && series.length > 0) {
    const first = series.find((n) => typeof n === 'number' && Number.isFinite(n))
    const last = [...series].reverse().find((n) => typeof n === 'number' && Number.isFinite(n))
    if (first === undefined || last === undefined) return currentCount === 0 ? 100 : 0
    if (first <= 0) return currentCount === 0 ? 100 : 0
    const raw = ((first - Math.max(0, last)) / first) * 100
    return Math.max(0, Math.min(100, Math.round(raw)))
  }
  return currentCount === 0 ? 100 : 0
}

/** Compute a quality gate snapshot from review data. */
export function computeQualityGate(opts: {
  dimensions: string[]
  findings: Array<{
    dimension: string
    severity: string
    file: string
    line?: number
  }>
  validationResults?: Array<{
    command: string
    exitCode: number
  }>
  /** Per-dimension sequence of NEW-finding counts across rounds, newest last. */
  findingsByRound?: Record<string, number[]>
  /** Per-dimension count of findings already fixed this iteration. */
  fixedByDimension?: Record<string, number>
}): QualityGateSnapshot {
  const { dimensions, findings, validationResults, findingsByRound, fixedByDimension } = opts

  // Count findings by severity
  const criticalCount = findings.filter((f) => f.severity === 'critical').length
  const highCount = findings.filter((f) => f.severity === 'high').length
  const mediumCount = findings.filter((f) => f.severity === 'medium').length
  const lowCount = findings.filter((f) => f.severity === 'low').length
  const totalFindings = findings.length

  // Compute dimension scores
  const dimensionStats: Record<string, { count: number; critical: number; high: number; medium: number; low: number }> = {}
  for (const dim of dimensions) {
    dimensionStats[dim] = { count: 0, critical: 0, high: 0, medium: 0, low: 0 }
  }

  for (const finding of findings) {
    const stats = dimensionStats[finding.dimension]
    if (stats) {
      stats.count++
      if (finding.severity === 'critical') stats.critical++
      else if (finding.severity === 'high') stats.high++
      else if (finding.severity === 'medium') stats.medium++
      else stats.low++
    }
  }

  // Compute dimension-level quality gates
  const dimensionGates: QualityGateDimension[] = dimensions.map((dim) => {
    const stats = dimensionStats[dim] || { count: 0, critical: 0, high: 0, medium: 0, low: 0 }
    // Score: 100 - (critical*30 + high*15 + medium*5 + low*1), capped at 0
    const penalty = stats.critical * 30 + stats.high * 15 + stats.medium * 5 + stats.low * 1
    const score = Math.max(0, 100 - penalty)
    const status: 'pass' | 'warn' | 'fail' = score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail'
    const series = findingsByRound?.[dim]
    const convergenceRate = convergenceRateFor(Array.isArray(series) ? series : undefined, stats.count)

    return {
      dimension: dim,
      convergenceRate,
      findingsCount: stats.count,
      fixedCount: fixedByDimension?.[dim] ?? 0,
      score,
      status,
    }
  })

  // Compute verification pass rate
  const totalChecks = validationResults?.length ?? 0
  const passedChecks = validationResults?.filter((r) => r.exitCode === 0).length ?? 0
  const failedChecks = totalChecks - passedChecks
  const verificationPassRate = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0

  // Compute overall score (weighted average of dimension scores)
  const overallScore = dimensionGates.length > 0
    ? Math.round(dimensionGates.reduce((sum, d) => sum + d.score, 0) / dimensionGates.length)
    : 0

  // Determine overall status
  const hasCritical = criticalCount > 0
  const hasHighFail = dimensionGates.some((d) => d.status === 'fail')
  const verificationFails = totalChecks > 0 && failedChecks > 0

  let overallStatus: 'pass' | 'fail' | 'pending' = 'pass'
  let failReason: string | undefined

  if (hasCritical) {
    overallStatus = 'fail'
    failReason = `${criticalCount} critical findings present`
  } else if (hasHighFail) {
    overallStatus = 'fail'
    failReason = 'One or more dimensions failed quality gate'
  } else if (verificationFails) {
    overallStatus = 'fail'
    failReason = `${failedChecks} validation checks failed`
  } else if (overallScore < 70) {
    overallStatus = 'fail'
    failReason = `Overall score ${overallScore} below threshold (70)`
  }

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    overallScore,
    dimensions: dimensionGates,
    verificationPassRate,
    totalChecks,
    passedChecks,
    failedChecks,
    failReason,
    totalFindings,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  }
}