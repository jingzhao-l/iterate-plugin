/**
 * src/tools/transcript.ts — `iterate_transcript` tool.
 *
 * Exposes the runtime-observatory manifest to the model (and, via its persisted
 * on-disk copy, to the client observatory panel). Purely local, deterministic,
 * and safe:
 *
 *   - `read`     — return the persisted transcript manifest (or a structured
 *                  "not found" empty view). Used each round by the workflow to
 *                  pick up steering nudges, and polled by tool-reading agents.
 *   - `capture`  — build a fresh transcript from the review `rounds` + `report`
 *                  and persist it. Called by the canonical scripts after the
 *                  final aggregate so the client always sees the latest run.
 *   - `nudge`    — set (`text`) or clear (`text: null`) steering text persisted
 *                  for the next round's reviewers to read.
 *
 * All writes are persisted to `.iterate/transcript.json` via an atomic
 * tmp+rename so a crashed writer never leaves a corrupt manifest.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  loadEffectiveConfig,
  resolveProjectRootForExec,
} from '../config-loader.ts'
import { transcriptPath } from '../paths.ts'
import { ReviewTranscriptBuilder } from '../transcript.ts'
import type {
  TranscriptManifest,
  TranscriptFix,
} from '../types.ts'

/** Build per-dimension threads for one round from its (dimension-tagged) findings. */
function captureRound(builder: ReviewTranscriptBuilder, round: unknown): void {
  if (!round || typeof round !== 'object') return
  const r = round as {
    round?: unknown
    findings?: unknown
    readFiles?: unknown
  }
  const roundNo = typeof r.round === 'number' ? Math.floor(r.round) : 0
  if (roundNo <= 0) return
  builder.roundStart(roundNo)
  const findings = Array.isArray(r.findings) ? r.findings : []
  const readFiles = Array.isArray(r.readFiles) ? r.readFiles : []
  // Group the round's findings by dimension → one reviewer thread each.
  const byDim = new Map<string, unknown[]>()
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    const rec = f as Record<string, unknown>
    const dim = typeof rec.dimension === 'string' && rec.dimension ? rec.dimension : 'review'
    const list = byDim.get(dim) ?? []
    list.push(f)
    byDim.set(dim, list)
  }
  if (byDim.size === 0) {
    builder.reviewerSnapshot('review', [], readFiles)
  } else {
    for (const [dim, list] of byDim) builder.reviewerSnapshot(dim, list, readFiles)
  }
}

/** Normalize the checkpoint shape if present. */
function normalizeCheckpoint(input: unknown): TranscriptManifest['checkpoint'] {
  if (!input || typeof input !== 'object') return null
  const c = input as Record<string, unknown>
  const round = typeof c.round === 'number' ? c.round : 0
  if (round <= 0) return null
  return {
    mode: c.mode === 'dry-run' || c.mode === 'normal' ? c.mode : 'normal',
    round,
    maxRounds: typeof c.maxRounds === 'number' ? c.maxRounds : 0,
    fixedCount: typeof c.fixedCount === 'number' ? c.fixedCount : 0,
    resumeCount: typeof c.resumeCount === 'number' ? c.resumeCount : 0,
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : new Date().toISOString(),
  }
}

/** Normalize a fix record. */
function normalizeFix(input: unknown): TranscriptFix | null {
  if (!input || typeof input !== 'object') return null
  const f = input as Record<string, unknown>
  const id = typeof f.id === 'string' ? f.id : ''
  const file = typeof f.file === 'string' ? f.file : ''
  if (!id || !file) return null
  return {
    id,
    timestamp: typeof f.timestamp === 'string' ? f.timestamp : new Date().toISOString(),
    round: typeof f.round === 'number' ? f.round : 0,
    file,
    summary: typeof f.summary === 'string' ? f.summary : '',
    linesAdded: typeof f.linesAdded === 'number' ? f.linesAdded : 0,
    linesRemoved: typeof f.linesRemoved === 'number' ? f.linesRemoved : 0,
    success: f.success !== false,
  }
}

/** Register the `iterate_transcript` tool. */
export function registerTranscriptTool(ctx: {
  tools: { register: (def: ReturnType<typeof defineTool>) => void }
}): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_transcript',
      description:
        'Runtime-observatory transcript for the iterate workflow. ' +
        '`read` returns the current persisted transcript manifest (per-reviewer threads, ' +
        'convergence series, findings, fixes, checkpoint, timeline, and any steering nudge ' +
        'written for the next round). ' +
        '`capture` builds a fresh transcript from the review `rounds` + `report` and persists it ' +
        '(call once after the final aggregate so the UI reflects the run). ' +
        '`nudge` sets (text) or clears (text:null) steering text the next round\'s reviewers read. ' +
        'Purely local and deterministic — never touches source files.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          description: '"read" to fetch the manifest, "capture" to persist one, "nudge" to set steering text.',
          enum: ['read', 'capture', 'nudge'],
        },
        rounds: {
          type: 'json',
          description: 'For `capture`: per-round findings, each [{round, findings:[{dimension,file,line?,severity,summary,…}], readFiles:[…]}].',
        },
        report: {
          type: 'json',
          description: 'For `capture`: the ReviewReport (convergence.findingsByRound used for the trend).',
        },
        mode: {
          type: 'string',
          description: 'For `capture`: run mode ("dry-run" | "normal"). Default dry-run.',
          enum: ['dry-run', 'normal'],
        },
        goal: { type: 'string', description: 'For `capture`: run goal.' },
        maxRounds: { type: 'integer', description: 'For `capture`: round cap.' },
        roundsExecuted: { type: 'integer', description: 'For `capture`: number of rounds actually executed.' },
        findingsByRound: { type: 'json', description: 'For `capture`: the per-round new-findings count series (report.convergence.findingsByRound). Preferred over passing the whole report.' },
        checkpoint: { type: 'json', description: 'For `capture`: checkpoint summary (optional).' },
        fixes: {
          type: 'json',
          description: 'For `capture`: array of applied fixes [{id, file, round, summary, linesAdded, linesRemoved, success}].',
        },
        refReadFiles: { type: 'json', description: 'For `capture`: flat array of all read files across rounds (optional).' },
        text: { type: 'string', description: 'For `nudge`: steering text to set (or null to clear).' },
        path: { type: 'string', description: 'Project root directory (default: current working directory).' },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: { type: 'string', required: true },
            found: { type: 'boolean' },
            transcript: { type: 'json' },
            updated: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { operation: args.operation, error: resolved.reason }
        const projectRoot = resolved.root
        const file = transcriptPath(projectRoot)
        const { config } = loadEffectiveConfig(projectRoot)
        const approval = config.observatory?.approval ?? 'ask'

        if (args.operation === 'read') {
          if (!existsSync(file)) {
            return {
              operation: 'read',
              found: false,
              transcript: new ReviewTranscriptBuilder({
                project: projectRoot,
                approval,
              }).serialize() as unknown as JsonValue,
            }
          }
          try {
            const raw = await readFile(file, 'utf-8')
            const parsed = JSON.parse(raw) as unknown as TranscriptManifest
            return { operation: 'read', found: true, transcript: parsed as unknown as JsonValue }
          } catch (err) {
            return {
              operation: 'read',
              found: false,
              error: `Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        }

        if (args.operation === 'nudge') {
          let manifest: TranscriptManifest | null = null
          if (existsSync(file)) {
            try {
              const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown as TranscriptManifest
              manifest = parsed
            } catch {
              manifest = null
            }
          }
          const builder = manifest
            ? rehydrateBuilder(manifest, approval)
            : new ReviewTranscriptBuilder({ project: projectRoot, mode: 'normal', approval })
          builder.setNudge(typeof args.text === 'string' && args.text.trim() ? args.text : null)
          await persist(file, builder.serialize())
          return {
            operation: 'nudge',
            updated: true,
            transcript: builder.serialize() as unknown as JsonValue,
          }
        }

        // capture
        const mode = args.mode === 'normal' ? 'normal' : 'dry-run'
        const goal = typeof args.goal === 'string' ? args.goal : ''
        const maxRounds =
          typeof args.maxRounds === 'number' ? Math.floor(args.maxRounds) : 0
        const builder = new ReviewTranscriptBuilder({ project: projectRoot, mode, approval, goal, maxRounds })
        const report = args.report as Record<string, unknown> | null | undefined
        const reportFindings: unknown =
          report && typeof report === 'object' && Array.isArray(report.findings)
            ? report.findings
            : []
        const convergence =
          Array.isArray(args.findingsByRound) ? (args.findingsByRound as number[])
          : report && typeof report === 'object' && report.convergence
            ? ((report.convergence as Record<string, unknown>).findingsByRound as number[] | undefined) ?? []
            : []

        const rounds = Array.isArray(args.rounds) ? (args.rounds as unknown[]) : []
        for (const r of rounds) captureRound(builder, r)
        if (rounds.length === 0) {
          // No pre-grouped rounds: fall back to the report's flattened findings.
          const readFiles = Array.isArray(args.refReadFiles) ? args.refReadFiles : []
          const byDim = new Map<string, unknown[]>()
          for (const f of reportFindings as unknown[]) {
            if (!f || typeof f !== 'object') continue
            const rec = f as Record<string, unknown>
            const dim = typeof rec.dimension === 'string' && rec.dimension ? rec.dimension : 'review'
            const list = byDim.get(dim) ?? []
            list.push(f)
            byDim.set(dim, list)
          }
          for (const [dim, list] of byDim) builder.reviewerSnapshot(dim, list, readFiles)
        }

        // Convergence series from the report (position per round).
        for (let i = 0; i < convergence.length; i += 1) {
          const n = convergence[i]
          if (typeof n === 'number') builder.snapshotConvergence(i + 1, n)
        }
        const roundsExecuted =
          typeof args.roundsExecuted === 'number' ? Math.floor(args.roundsExecuted) : rounds.length
        if (roundsExecuted > 0) builder.roundStart(roundsExecuted, maxRounds)

        builder.recordCheckpoint(normalizeCheckpoint(args.checkpoint))
        if (Array.isArray(args.fixes)) {
          for (const fx of args.fixes) {
            const record = normalizeFix(fx)
            if (record) builder.fix(record)
          }
        }
        // Convergence "found nothing → settled" marker when the trend ends on 0.
        const last = convergence[convergence.length - 1]
        if (convergence.length > 0 && last === 0) builder.finish()

        await persist(file, builder.serialize())
        return {
          operation: 'capture',
          found: true,
          updated: true,
          transcript: builder.serialize() as unknown as JsonValue,
        }
      },
    }),
  )
}

/** Rebuild a builder from a persisted manifest so nudge edits preserve history. */
function rehydrateBuilder(manifest: TranscriptManifest, approval: 'ask' | 'deny' | 'allow'): ReviewTranscriptBuilder {
  const builder = new ReviewTranscriptBuilder({
    project: manifest.project,
    mode: manifest.mode ?? null,
    approval,
    goal: manifest.goal,
    maxRounds: manifest.maxRounds,
  })
  for (const r of Array.isArray(manifest.rounds) ? manifest.rounds : []) {
    builder.roundStart(r.round, manifest.maxRounds)
    for (const t of Array.isArray(r.threads) ? r.threads : []) {
      builder.reviewerStart(t.dimension || 'review', t.attempt || 1)
      builder.reviewerMessage((t.messages ?? []).join('\n'))
      builder.reviewerRead(t.readFiles ?? [])
      for (const f of t.findings ?? []) builder.reviewerFindings([f])
    }
  }
  for (let idx = 0; idx < (manifest.convergence ?? []).length; idx += 1) {
    const n = manifest.convergence[idx]
    if (typeof n === 'number' && n >= 0) builder.snapshotConvergence(idx + 1, n)
  }
  if (manifest.checkpoint) builder.recordCheckpoint(manifest.checkpoint)
  if (Array.isArray(manifest.fixes)) for (const fx of manifest.fixes) builder.fix(fx as TranscriptFix)
  if (Array.isArray(manifest.timeline)) for (const e of manifest.timeline) builder.decision(e)
  builder.setNudge(manifest.nudge?.text ?? null)
  if (!manifest.active) builder.finish()
  return builder
}

/** Atomically persist a manifest (tmp + rename) under `.iterate/`. */
async function persist(file: string, manifest: TranscriptManifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
  await rename(tmp, file)
}