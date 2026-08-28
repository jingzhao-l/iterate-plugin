/**
 * src/tools/fix.ts — structured fix system for the iterate loop.
 *
 * Three tools:
 *   iterate_fix       — apply ONE atomic fix to a file: validates atomicity,
 *                       backs up the original, writes the new content, and
 *                       records a FixRecord in `.iterate/fixes/registry.json`
 *                       plus an `atomic_fix` decision-log entry.
 *   iterate_diff      — show the accumulated diff for a file (or a summary of
 *                       every fixed file), derived from the first backup.
 *   iterate_rollback  — restore a file from a fix's backup and remove the
 *                       fix from the registry (append a `revert` log entry).
 *
 * Security model:
 *   - Only files under the resolved project root may be written.
 *   - Backups are written before any write, so a failure never destroys data.
 *   - Atomicity is enforced against `config.atomic.max_lines` unless `force`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { loadEffectiveConfig, resolveProjectRootForExec } from '../config-loader.ts'
import { runWithJob } from '../jobs.ts'
import { countTouchedMethods } from '../method-scope.ts'
import { fixBackupPath, fixRegistryPath, fixesDir } from '../paths.ts'
import { appendDecisionEntry } from './decision-log.ts'
import type { FileDiffHunk, FixRecord, FixRegistry, ReviewFinding } from '../types.ts'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Upper bound for a single fix `content` payload (characters). */
export const MAX_FIX_CONTENT_CHARS = 1_000_000

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Deterministic 32-bit FNV-1a hash used to derive a stable fix id from a
 * finding (same finding always maps to the same id → dedupe + rollback keys).
 */
export function hashString(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Stable id for a finding: file|dimension|line|summary. */
export function fixId(finding: Pick<ReviewFinding, 'file' | 'dimension' | 'line' | 'summary'>): string {
  const key = `${finding.file}|${finding.dimension}|${finding.line ?? 0}|${finding.summary}`
  return `fix-${hashString(key)}`
}

/**
 * Compute a minimal line diff between two texts.
 * Returns an array of hunks (empty when unchanged). Uses common-prefix/suffix
 * trimming then reports the changed middle block — sufficient and deterministic
 * for the small atomic edits this toolchain produces.
 */
export function diffLines(before: string, after: string): FileDiffHunk[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA)
  const added = b.slice(start, endB)
  if (removed.length === 0 && added.length === 0) return []
  const contentLines: string[] = []
  for (const line of removed) contentLines.push(`- ${line}`)
  for (const line of added) contentLines.push(`+ ${line}`)
  return [
    {
      oldStart: start + 1,
      oldLines: removed.length,
      newStart: start + 1,
      newLines: added.length,
      content: contentLines.join('\n'),
    },
  ]
}

/** Added/removed line counts for a change (derived from diffLines). */
export function countChangedLines(before: string, after: string): { added: number; removed: number } {
  const hunks = diffLines(before, after)
  let added = 0
  let removed = 0
  for (const h of hunks) {
    added += h.newLines
    removed += h.oldLines
  }
  return { added, removed }
}

/** Human-readable one-line diff summary. */
export function buildDiffSummary(hunks: FileDiffHunk[]): string {
  if (hunks.length === 0) return 'no changes'
  let added = 0
  let removed = 0
  for (const h of hunks) {
    added += h.newLines
    removed += h.oldLines
  }
  return `+${added}/-${removed} lines (${hunks.length} hunk${hunks.length === 1 ? '' : 's'})`
}

/** Default empty registry. */
export function emptyRegistry(): FixRegistry {
  return { rounds: [] }
}

/** Read the fix registry from disk (missing/corrupt → empty). */
export function readRegistry(projectRoot: string): FixRegistry {
  const file = fixRegistryPath(projectRoot)
  if (!existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as FixRegistry
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rounds)) return emptyRegistry()
    // Defensive: a hand-edited or partially-written registry may contain a
    // round without a `records` array — normalize instead of crashing readers.
    parsed.rounds = parsed.rounds.filter(
      (r) => r && typeof r === 'object' && Array.isArray(r.records),
    )
    return parsed
  } catch {
    return emptyRegistry()
  }
}

/** Find a fix record by id across all rounds, or undefined. */
export function findFixRecord(registry: FixRegistry, id: string): FixRecord | undefined {
  for (const round of registry.rounds) {
    const found = round.records.find((r) => r.id === id)
    if (found) return found
  }
  return undefined
}

/** All fix records for a file, in chronological order. */
export function recordsForFile(registry: FixRegistry, file: string): FixRecord[] {
  const out: FixRecord[] = []
  for (const round of registry.rounds) {
    for (const r of round.records) {
      if (r.finding.file === file && r.success) out.push(r)
    }
  }
  return out
}

/** Insert (or replace) a record in the registry and return a NEW registry. */
export function upsertRecord(registry: FixRegistry, record: FixRecord): FixRegistry {
  const rounds = registry.rounds.map((r) => ({ ...r, records: [...r.records] }))
  let target = rounds.find((r) => r.round === record.round)
  if (!target) {
    target = { round: record.round, fixedCount: 0, failedCount: 0, records: [] }
    rounds.push(target)
  }
  const idx = target.records.findIndex((r) => r.id === record.id)
  if (idx >= 0) target.records[idx] = record
  else target.records.push(record)
  rounds.sort((a, b) => a.round - b.round)
  return recomputeRoundCounts({ rounds })
}

/** Recompute per-round fixed/failed counts from the raw records. */
export function recomputeRoundCounts(registry: FixRegistry): FixRegistry {
  return {
    rounds: registry.rounds.map((r) => {
      const fixedCount = r.records.filter((rec) => rec.success).length
      const failedCount = r.records.filter((rec) => !rec.success).length
      return { ...r, fixedCount, failedCount }
    }),
  }
}

/** Remove a record by id and return a NEW registry (rollback). */
export function removeRecord(registry: FixRegistry, id: string): FixRegistry {
  const rounds = registry.rounds
    .map((r) => ({ ...r, records: r.records.filter((rec) => rec.id !== id) }))
    .filter((r) => r.records.length > 0)
  return recomputeRoundCounts({ rounds })
}

/**
 * Ensure a relative file path stays inside the project root.
 * Returns `{ ok: true, resolved }` or `{ ok: false, reason }`.
 */
export function resolveProjectFile(projectRoot: string, file: string): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof file !== 'string' || file.trim().length === 0) {
    return { ok: false, reason: 'file must be a non-empty relative path' }
  }
  if (file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file)) {
    return { ok: false, reason: 'file must be a relative path inside the project root' }
  }
  const resolved = join(projectRoot, file)
  if (resolved === projectRoot || !resolved.startsWith(projectRoot + '/') && !resolved.startsWith(projectRoot + '\\')) {
    return { ok: false, reason: 'file resolves outside the project root' }
  }
  // Symlink containment: the lexical prefix check above does not resolve
  // symlinks. If the target exists, verify its REAL path stays inside the REAL
  // project root so a symlinked directory/file inside the repo can never route
  // a fix (write/rollback/diff) outside the project.
  if (existsSync(resolved)) {
    let rootReal: string
    let real: string
    try {
      rootReal = realpathSync(projectRoot)
      real = realpathSync(resolved)
    } catch {
      return { ok: false, reason: 'failed to resolve real path for containment check' }
    }
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
    if (real !== rootReal && !real.startsWith(rootPrefix)) {
      return { ok: false, reason: 'file resolves outside the project root (symlink escape)' }
    }
  }
  return { ok: true, resolved }
}

// ─── Shared execute helpers ──────────────────────────────────────────────────

/**
 * Minimal glob matcher for personalization.protected_paths.
 * Supports `*` (any run of chars within one segment) and `**` (any chars,
 * including separators). All other characters are literal. Pure, unit-testable.
 */
export function globMatch(path: string, pattern: string): boolean {
  if (typeof path !== 'string' || typeof pattern !== 'string') return false
  // Escape regex specials except our two wildcards.
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) { re += '[\\s\\S]*'; i++ } else { re += '[^/\\\\]*' }
    } else if ('.[]{}()+-^$|?'.includes(ch)) {
      re += '\\' + ch
    } else {
      re += ch
    }
  }
  try {
    return new RegExp('^' + re + '$').test(path)
  } catch {
    return false
  }
}

/** Read the current content of a file under the project root. */
function readProjectFile(projectRoot: string, file: string): { ok: true; content: string } | { ok: false; reason: string } {
  const resolved = resolveProjectFile(projectRoot, file)
  if (!resolved.ok) return resolved
  if (!existsSync(resolved.resolved)) return { ok: false, reason: `file does not exist: ${file}` }
  try {
    return { ok: true, content: readFileSync(resolved.resolved, 'utf-8') }
  } catch (err) {
    return { ok: false, reason: `failed to read file: ${String(err)}` }
  }
}

// ─── iterate_fix ─────────────────────────────────────────────────────────────

/**
 * Register the `iterate_fix` tool.
 * The fixer subagent supplies the file + its NEW full content; the tool
 * validates atomicity, backs up, writes, and records the fix.
 */
export function registerFixTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_fix',
      description:
        'Apply ONE atomic fix to a file. Pass the target relative `file`, the finding that motivated ' +
        'the fix, the NEW full `content` of that file (after your edit), and the current `round`. ' +
        'The tool backs up the original, enforces the atomic `max_lines` and `max_adjacent_methods` thresholds (unless `force`), ' +
        'writes the new content, and records the fix for later diff/rollback. ' +
        'This is the ONLY sanctioned way to apply fixes in normal mode.',
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: 'Relative path of the file to fix, inside the project root.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'The NEW full content of the file after applying your fix.',
        },
        finding: {
          type: 'json',
          required: true,
          description: 'The finding this fix addresses: {dimension, file, line?, severity, summary, failure_scenario?, suggested_fix?, is_atomic}.',
        },
        round: {
          type: 'integer',
          required: true,
          description: 'Current iteration round (>= 1).',
        },
        force: {
          type: 'boolean',
          description: 'Skip the atomic max_lines threshold check (default: false).',
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
            id: { type: 'string' },
            file: { type: 'string' },
            round: { type: 'integer' },
            linesAdded: { type: 'integer' },
            linesRemoved: { type: 'integer' },
            diffSummary: { type: 'string' },
            backupPath: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.ok ? `${value.diffSummary ?? 'fixed'} @ ${value.file} (id: ${value.id})` : `fix failed: ${value.error}` },
        ],
      },

      async execute(args, exec) {
        const { result } = await runWithJob(ctx, 'iterate-fix', `iterate_fix ${typeof args.file === 'string' && args.file ? args.file : '(?)'}`, async () => {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, error: resolved.reason }
        const projectRoot = resolved.root
        const { config } = loadEffectiveConfig(projectRoot)
        const maxLines = config.atomic?.max_lines ?? 20
        const maxAdjacentMethods = config.atomic?.max_adjacent_methods ?? 3

        const file = typeof args.file === 'string' ? args.file : ''
        if (!file) return { ok: false, error: 'file is required' }
        if (typeof args.content !== 'string') return { ok: false, error: 'content must be a string' }
        if (args.content.length > MAX_FIX_CONTENT_CHARS) {
          return {
            ok: false,
            error: `content exceeds the ${MAX_FIX_CONTENT_CHARS}-character limit (got ${args.content.length})`,
          }
        }
        if (typeof args.round !== 'number' || !Number.isInteger(args.round) || args.round < 1) {
          return { ok: false, error: 'round must be a positive integer' }
        }
        const finding = args.finding as unknown as ReviewFinding | undefined
        if (!finding || typeof finding !== 'object') {
          return { ok: false, error: 'finding must be an object' }
        }
        if (typeof finding.file !== 'string' || finding.file.trim().length === 0) {
          return { ok: false, error: 'finding.file must be a non-empty string' }
        }
        if (typeof finding.dimension !== 'string' || finding.dimension.trim().length === 0) {
          return { ok: false, error: 'finding.dimension must be a non-empty string' }
        }
        // The finding must reference the file being fixed — the fix id and the
        // rollback/diff target are derived from finding.file, so a mismatch
        // would back up/restore the WRONG file.
        if (finding.file !== file) {
          return { ok: false, error: `finding.file ("${finding.file}") must match the file being fixed ("${file}")` }
        }
        // Full finding validation, mirroring the review schema: malformed
        // findings would produce lossy registry/log entries and a degraded id.
        const SEVERITY_SET = new Set(['critical', 'high', 'medium', 'low'])
        if (!SEVERITY_SET.has(finding.severity)) {
          return { ok: false, error: 'finding.severity must be one of critical/high/medium/low' }
        }
        if (typeof finding.summary !== 'string' || finding.summary.trim().length === 0) {
          return { ok: false, error: 'finding.summary must be a non-empty string' }
        }
        if (typeof finding.is_atomic !== 'boolean') {
          return { ok: false, error: 'finding.is_atomic must be a boolean' }
        }
        if (finding.line !== undefined && finding.line !== null &&
            (typeof finding.line !== 'number' || !Number.isInteger(finding.line) || finding.line < 0)) {
          return { ok: false, error: 'finding.line must be a non-negative integer (0 = whole-file)' }
        }

        const current = readProjectFile(projectRoot, file)
        if (!current.ok) return { ok: false, error: current.reason }

        const hunks = diffLines(current.content, args.content)
        const { added, removed } = countChangedLines(current.content, args.content)
        if (!args.force && (added > maxLines || removed > maxLines)) {
          return {
            ok: false,
            error: `Change to ${file} exceeds the atomic threshold (max_lines=${maxLines}, change is +${added}/-${removed}). ` +
              'Either split it into smaller atomic fixes or pass force:true if this is a deliberate architectural change.',
          }
        }

        const touchedMethods = countTouchedMethods(current.content, args.content, hunks)
        if (!args.force && touchedMethods > maxAdjacentMethods) {
          return {
            ok: false,
            error: `Change to ${file} touches ${touchedMethods} adjacent method(s), exceeds atomic.max_adjacent_methods (${maxAdjacentMethods}). ` +
              'Split it into smaller atomic fixes or pass force:true if this is a deliberate multi-method change.',
          }
        }

        const id = fixId(finding)
        const registry = readRegistry(projectRoot)
        if (findFixRecord(registry, id)) {
          return { ok: false, error: `finding already fixed this run (id: ${id})`, id }
        }

        const target = resolveProjectFile(projectRoot, file)
        if (!target.ok) return { ok: false, error: target.reason }

        // Personalization guards (SKILL.md Phase 2): protected_paths veto the
        // fix outright; forbidden_fixes veto fix approaches appearing in the
        // new content. Both are security-relevant, so they are enforced here
        // in the tool, not left to the model.
        const pers = config.personalization as
          | { protected_paths?: unknown; forbidden_fixes?: unknown }
          | undefined
        const protectedPaths = Array.isArray(pers?.protected_paths)
          ? (pers.protected_paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
          : []
        for (const pattern of protectedPaths) {
          if (globMatch(file, pattern)) {
            return { ok: false, error: `skipped: ${file} matches protected path "${pattern}" (personalization.protected_paths forbids modifying it)` }
          }
        }
        const forbiddenFixes = Array.isArray(pers?.forbidden_fixes)
          ? (pers.forbidden_fixes as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
          : []
        for (const forbidden of forbiddenFixes) {
          if (args.content.includes(forbidden)) {
            return { ok: false, error: `fix uses a forbidden approach: "${forbidden}" appears in the new content (personalization.forbidden_fixes)` }
          }
        }

        const timestamp = new Date().toISOString()
        const backupPath = fixBackupPath(projectRoot, id, timestamp)
        try {
          mkdirSync(fixesDir(projectRoot), { recursive: true })
          copyFileSync(target.resolved, backupPath)
        } catch (err) {
          return { ok: false, error: `failed to create backup: ${String(err)}` }
        }

        try {
          writeFileSync(target.resolved, args.content, 'utf-8')
        } catch (err) {
          return { ok: false, error: `failed to write file: ${String(err)}` }
        }

        const record: FixRecord = {
          id,
          timestamp,
          round: args.round,
          finding,
          backupPath,
          diffSummary: buildDiffSummary(hunks),
          linesAdded: added,
          linesRemoved: removed,
          success: true,
        }
        const nextRegistry = upsertRecord(registry, record)
        try {
          writeFileSync(fixRegistryPath(projectRoot), JSON.stringify(nextRegistry, null, 2), 'utf-8')
        } catch (err) {
          // Registry write failed → the file was already modified but no record
          // exists, so a later rollback/diff could never see it and a retry would
          // back up the already-fixed content as "original". Restore the file
          // from the backup to leave the tree exactly as it was.
          try {
            copyFileSync(backupPath, target.resolved)
          } catch (restoreErr) {
            return {
              ok: false,
              error: `failed to write fix registry: ${String(err)}; additionally failed to restore ${file} from backup: ${String(restoreErr)}`,
            }
          }
          return { ok: false, error: `failed to write fix registry: ${String(err)} (file restored from backup)` }
        }

        appendDecisionEntry(projectRoot, {
          timestamp,
          round: args.round,
          type: 'atomic_fix',
          data: { id, file, finding: finding.summary, linesAdded: added, linesRemoved: removed },
        })

        return {
          ok: true,
          id,
          file,
          round: args.round,
          linesAdded: added,
          linesRemoved: removed,
          diffSummary: record.diffSummary,
          backupPath,
        }
        })
        return result
      },
    }),
  )
}

// ─── iterate_diff ────────────────────────────────────────────────────────────

/**
 * Register the `iterate_diff` tool.
 * Shows the accumulated change for a file (diff vs its first backup) or a
 * summary of every file that has been fixed.
 */
export function registerDiffTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_diff',
      description:
        'Show the changes made by iterate fixes. With `file`, returns the unified diff of the current ' +
        'file content vs its original (first backup). Without `file`, returns a summary of every fixed file.',
      parameters: {
        file: {
          type: 'string',
          description: 'Optional relative file path to diff. When omitted, returns a per-file summary.',
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
            file: { type: 'string' },
            diff: { type: 'json' },
            diffSummary: { type: 'string' },
            files: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `diff failed: ${value.error}` }]
          if (value.file) {
            const diff = (value.diff as FileDiffHunk[] | undefined) ?? []
            const text = diff.length === 0
              ? `No changes for ${value.file}.`
              : diff.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.content}`).join('\n\n')
            return [{ type: 'text', text }]
          }
          const files = (value.files as { file: string; diffSummary: string; linesAdded: number; linesRemoved: number }[] | undefined) ?? []
          const text = files.length === 0 ? 'No fixes have been applied yet.' : files.map((f) => `${f.file}  ${f.diffSummary}`).join('\n')
          return [{ type: 'text', text }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, error: resolved.reason }
        const projectRoot = resolved.root
        const registry = readRegistry(projectRoot)
        const file = typeof args.file === 'string' && args.file.trim() ? args.file : undefined

        if (file) {
          const records = recordsForFile(registry, file)
          const first = records[0]
          if (!first) return { ok: false, error: `no fixes recorded for ${file}` }
          const current = readProjectFile(projectRoot, file)
          if (!current.ok) return { ok: false, error: current.reason }
          let original = ''
          try {
            original = readFileSync(first.backupPath, 'utf-8')
          } catch (err) {
            return { ok: false, error: `backup missing for ${file}: ${String(err)}` }
          }
          const hunks = diffLines(original, current.content)
          return { ok: true, file, diff: hunks as unknown as JsonValue, diffSummary: buildDiffSummary(hunks) }
        }

        const files: { file: string; diffSummary: string; linesAdded: number; linesRemoved: number }[] = []
        for (const round of registry.rounds) {
          for (const r of round.records) {
            if (!r.success) continue
            const existing = files.find((f) => f.file === r.finding.file)
            if (existing) {
              existing.linesAdded += r.linesAdded
              existing.linesRemoved += r.linesRemoved
              // Recompute the summary from the summed counts so a multi-fix
              // file's text does not contradict its accumulated numbers.
              existing.diffSummary = `+${existing.linesAdded}/-${existing.linesRemoved} lines`
            } else {
              files.push({
                file: r.finding.file,
                diffSummary: r.diffSummary,
                linesAdded: r.linesAdded,
                linesRemoved: r.linesRemoved,
              })
            }
          }
        }
        return { ok: true, files: files as unknown as JsonValue }
      },
    }),
  )
}

// ─── iterate_rollback ────────────────────────────────────────────────────────

/**
 * Register the `iterate_rollback` tool.
 * Restores a file from a fix's backup and removes the fix from the registry,
 * appending a `revert` decision-log entry. Use after a failed validation.
 */
export function registerRollbackTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_rollback',
      description:
        'Revert a previously applied fix. Pass the fix `id` (returned by iterate_fix). ' +
        'The file is restored from the fix backup, the fix is removed from the registry, ' +
        'and a `revert` entry is appended to the decision log. Use when a round\'s validation fails.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'The fix id returned by iterate_fix.',
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
            id: { type: 'string' },
            file: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.ok ? `reverted fix ${value.id} in ${value.file}` : `rollback failed: ${value.error}` },
        ],
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, error: resolved.reason }
        const projectRoot = resolved.root
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return { ok: false, error: 'id is required' }

        const registry = readRegistry(projectRoot)
        const record = findFixRecord(registry, id)
        if (!record) return { ok: false, error: `fix not found: ${id}` }
        if (!existsSync(record.backupPath)) {
          return { ok: false, error: `backup missing for fix ${id}` }
        }

        const target = resolveProjectFile(projectRoot, record.finding.file)
        if (!target.ok) return { ok: false, error: target.reason }
        try {
          copyFileSync(record.backupPath, target.resolved)
        } catch (err) {
          return { ok: false, error: `failed to restore backup: ${String(err)}` }
        }

        const nextRegistry = removeRecord(registry, id)
        try {
          writeFileSync(fixRegistryPath(projectRoot), JSON.stringify(nextRegistry, null, 2), 'utf-8')
        } catch (err) {
          return { ok: false, error: `failed to update fix registry: ${String(err)}` }
        }

        appendDecisionEntry(projectRoot, {
          timestamp: new Date().toISOString(),
          round: record.round,
          type: 'revert',
          data: { id, file: record.finding.file, revertedDiff: record.diffSummary },
        })

        return { ok: true, id, file: record.finding.file }
      },
    }),
  )
}
