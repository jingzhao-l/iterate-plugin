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

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { writeJsonAtomic, writeTextAtomic } from '../atomic-fs.ts'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadEffectiveConfig, resolveProjectRootForExec } from '../config-loader.ts'
import { withProjectLock } from '../file-lock.ts'
import { runWithJob } from '../jobs.ts'
import { countTouchedMethods } from '../method-scope.ts'
import { fixBackupPath, fixRegistryPath, fixesDir } from '../paths.ts'
import { appendDecisionEntry } from './decision-log.ts'
import { markFixRolledBackInTranscript } from './transcript.ts'
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
 * Exact-alignment budget for the changed middle block: a dynamic-programming
 * LCS pass over `m × n` cells. Beyond these bounds diffLines falls back to the
 * legacy single-hunk report (coarser counts, but never a hang), so a
 * pathological multi-thousand-line input cannot stall the tool loop.
 */
export const DIFF_MAX_REGION_CELLS = 20_000
export const DIFF_MAX_REGION_LINES = 5_000

/**
 * Compute a minimal line diff between two texts.
 * Returns an array of hunks (empty when unchanged).
 *
 * Common prefix/suffix are trimmed first, then the changed middle block is
 * aligned EXACTLY (suffix-LCS dynamic programming, bounded by
 * DIFF_MAX_REGION_CELLS / DIFF_MAX_REGION_LINES) and split into one hunk per
 * run of changed lines separated by unchanged lines. This keeps counts honest:
 * changing line 1 AND line 100 of a 200-line file reports {added:2, removed:2}
 * across two hunks, not {100,100} for the whole span — the atomic `max_lines`
 * gate and the persisted FixRecord line counts are derived from these numbers.
 * When the region exceeds the budget, the old single-hunk behavior is kept so
 * huge inputs degrade to coarse-but-correct counts instead of hanging.
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
  return alignRegion(removed, added, start) ?? singleRegionHunk(removed, added, start)
}

/**
 * Legacy single-hunk report for the trimmed changed block (also the bounded
 * fallback when `alignRegion` refuses an over-budget region).
 */
function singleRegionHunk(removed: string[], added: string[], start: number): FileDiffHunk[] {
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

/**
 * Exactly align the trimmed changed block and split it into per-spot hunks
 * (each maximal run of changed lines, separated by at least one unchanged
 * line). Returns `null` when the region exceeds the DP budget so the caller
 * can fall back to {@link singleRegionHunk}.
 *
 * Hunk coordinates follow GNU `diff -U0` conventions: for a pure insertion
 * `oldStart` is the line BEFORE the insertion point (oldLines = 0), for a pure
 * deletion `newStart` is the line before the deletion point (newLines = 0),
 * and for a replacement both point at the replaced line.
 */
function alignRegion(removed: string[], added: string[], start: number): FileDiffHunk[] | null {
  const m = removed.length
  const n = added.length
  if (m > DIFF_MAX_REGION_LINES || n > DIFF_MAX_REGION_LINES || m * n > DIFF_MAX_REGION_CELLS) return null

  // dp[i][j] = LCS length of removed[i..] / added[j..] (suffix table).
  const stride = n + 1
  const dp = new Int32Array((m + 1) * stride)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * stride + j] = removed[i] === added[j]
        ? dp[(i + 1) * stride + j + 1]! + 1
        : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + j + 1]!)
    }
  }

  const hunks: FileDiffHunk[] = []
  let open: { iOpen: number; jOpen: number; oldLines: number; newLines: number; content: string[] } | null = null
  const closeHunk = (): void => {
    if (!open) return
    hunks.push({
      // oldLines > 0 → first removed line (1-based); pure insertion → the
      // line before the insertion point (= its 0-based index).
      oldStart: start + open.iOpen + (open.oldLines > 0 ? 1 : 0),
      oldLines: open.oldLines,
      newStart: start + open.jOpen + (open.newLines > 0 ? 1 : 0),
      newLines: open.newLines,
      content: open.content.join('\n'),
    })
    open = null
  }

  let i = 0 // region index into removed
  let j = 0 // region index into added
  while (i < m || j < n) {
    // A matching pair always belongs to SOME optimal alignment (CLRS
    // x_i = y_j ⇒ LCS(i,j) = 1 + LCS(i+1,j+1)), so greedily closing the
    // current hunk here is exact, not heuristic.
    if (i < m && j < n && removed[i] === added[j]) {
      closeHunk()
      i++
      j++
      continue
    }
    // Diverged: consume whichever side the suffix table says costs less.
    // Ties prefer removal so a plain replacement reads `- old / + new`.
    const takeRemoved = i >= m ? false : j >= n ? true : dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!
    if (takeRemoved) {
      if (!open) open = { iOpen: i, jOpen: j, oldLines: 0, newLines: 0, content: [] }
      open.oldLines++
      open.content.push(`- ${removed[i]}`)
      i++
    } else {
      if (!open) open = { iOpen: i, jOpen: j, oldLines: 0, newLines: 0, content: [] }
      open.newLines++
      open.content.push(`+ ${added[j]}`)
      j++
    }
  }
  closeHunk()
  return hunks
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
    // Defensive normalization: a hand-edited or partially-written registry may
    // contain a round without a `records` array, or records that are missing
    // their id / finding object — all of which would make readers
    // (findFixRecord / recordsForFile / iterate_diff) throw or sum NaN.
    // Numeric counters are also floored to non-negative integers: the status
    // output schema declares them `type: 'integer'`, so a `fixedCount: 1.5`
    // must never reach iterate_status.
    const intCount = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
    parsed.rounds = parsed.rounds
      .filter((r) => r && typeof r === 'object' && Array.isArray(r.records))
      .map((r) => ({
        ...r,
        round: typeof r.round === 'number' && Number.isFinite(r.round) ? Math.floor(r.round) : 0,
        fixedCount: intCount(r.fixedCount),
        failedCount: intCount(r.failedCount),
        records: r.records.filter(
          (rec): rec is FixRecord =>
            !!rec &&
            typeof rec === 'object' &&
            typeof rec.id === 'string' &&
            !!rec.finding &&
            typeof rec.finding === 'object',
        ),
      }))
      .filter((r) => typeof r.round === 'number' && Number.isFinite(r.round))
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

/**
 * All fix records for a file, in chronological order.
 * Both sides are canonicalized with {@link normalizeProjectPath} so a record
 * persisted as `./README.md` (pre-normalization builds) still matches a
 * query for `README.md` and vice versa.
 */
export function recordsForFile(registry: FixRegistry, file: string): FixRecord[] {
  const want = normalizeProjectPath(file)
  const out: FixRecord[] = []
  for (const round of registry.rounds) {
    for (const r of round.records) {
      if (normalizeProjectPath(r.finding.file) === want && r.success) out.push(r)
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
  // symlinks. Verify the REAL path of the target (when it exists) AND of its
  // nearest existing ancestor directory (when it does not — e.g. a fix that
  // creates a new file) stays inside the REAL project root, so a symlinked
  // directory inside the repo can never route a fix (write/rollback/diff)
  // outside the project. The probe stops at the project root itself: the root
  // is harness-provided (not model-controlled), and a path with no existing
  // entry inside the repo cannot hide a symlink.
  let probe = resolved
  while (!existsSync(probe) && probe !== projectRoot) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  if (existsSync(probe)) {
    let rootReal: string
    let real: string
    try {
      rootReal = realpathSync(projectRoot)
      real = realpathSync(probe)
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

/**
 * Canonicalize a model-supplied relative path ONCE at argument intake.
 *
 * Strips a leading `./`, collapses duplicate separators, and resolves `.` /
 * `..` segments lexically so the containment check, the protected-path glob,
 * the persisted FixRecord, and every later diff/rollback lookup all compare
 * the SAME string — a raw `./README.md` must not dodge a `README.md` veto
 * glob, and `src/../README.md` must record as `README.md`.
 * Absolute paths and `..` escapes survive normalization and are rejected by
 * {@link resolveProjectFile} afterwards. Pure, exported for unit tests.
 */
export function normalizeProjectPath(file: string): string {
  // An empty intake must stay empty (node's normalize('') === '.') so
  // resolveProjectFile still rejects it instead of resolving to the root.
  if (typeof file !== 'string' || file === '') return ''
  return normalize(file)
}

/**
 * Validate a registry-recorded backup path before it is read (iterate_diff)
 * or used to overwrite a project file (iterate_rollback).
 *
 * The registry is a plain JSON file on disk: a hand-edited/corrupt record can
 * point `backupPath` anywhere, turning diff into an arbitrary-file read and
 * rollback into arbitrary-content injection. A backup must stay inside the
 * project's fixes directory — lexically AND via realpath when it exists (so a
 * symlink planted inside `.iterate/fixes` cannot smuggle content either).
 */
export function resolveBackupPath(
  projectRoot: string,
  backupPath: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof backupPath !== 'string' || backupPath.trim().length === 0) {
    return { ok: false, reason: 'backup path is missing from the fix record' }
  }
  const fixes = fixesDir(projectRoot)
  // Relative entries are anchored at the project root (never the process cwd)
  // so `../../etc/passwd` fails the containment check below.
  const resolved = isAbsolute(backupPath) ? normalize(backupPath) : join(projectRoot, backupPath)
  const prefix = fixes.endsWith(sep) ? fixes : fixes + sep
  if (resolved !== fixes && !resolved.startsWith(prefix)) {
    return { ok: false, reason: `backup path escapes the fixes directory: ${backupPath}` }
  }
  if (existsSync(resolved)) {
    let realFixes: string
    let real: string
    try {
      realFixes = realpathSync(fixes)
      real = realpathSync(resolved)
    } catch {
      return { ok: false, reason: `failed to resolve real path for backup containment check: ${backupPath}` }
    }
    const realPrefix = realFixes.endsWith(sep) ? realFixes : realFixes + sep
    if (real !== realFixes && !real.startsWith(realPrefix)) {
      return { ok: false, reason: `backup path escapes the fixes directory (symlink): ${backupPath}` }
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
      // Pending-call card: surface the file about to change as an inline diff.
      // oldText is null — a call-time presenter has no access to the file's
      // prior content (an overwrite, per the presentation contract).
      presentCall: (args) => {
        const a = args as { file?: unknown; content?: unknown }
        if (typeof a.file !== 'string' || typeof a.content !== 'string') return undefined
        return {
          card: 'diff',
          title: `Fix ${a.file}`,
          diffs: [{ path: a.file, oldText: null, newText: a.content }],
          locations: [{ path: a.file }],
        }
      },
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
            warning: { type: 'string' },
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

        // Canonicalize ONCE at intake: `./README.md` and `src/../README.md`
        // must behave exactly like `README.md` downstream — the protected-path
        // glob, the fix id, the persisted FixRecord, and later diff/rollback
        // lookups all compare this normalized form (escapes/absolute paths
        // survive normalization and are rejected by resolveProjectFile).
        const rawFile = typeof args.file === 'string' ? args.file : ''
        if (!rawFile) return { ok: false, error: 'file is required' }
        const file = normalizeProjectPath(rawFile)
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
        const rawFinding = args.finding as unknown as ReviewFinding | undefined
        if (!rawFinding || typeof rawFinding !== 'object') {
          return { ok: false, error: 'finding must be an object' }
        }
        if (typeof rawFinding.file !== 'string' || rawFinding.file.trim().length === 0) {
          return { ok: false, error: 'finding.file must be a non-empty string' }
        }
        if (typeof rawFinding.dimension !== 'string' || rawFinding.dimension.trim().length === 0) {
          return { ok: false, error: 'finding.dimension must be a non-empty string' }
        }
        // The finding must reference the file being fixed — the fix id and the
        // rollback/diff target are derived from finding.file, so a mismatch
        // would back up/restore the WRONG file. Both sides are compared in
        // their NORMALIZED form (`./src/a.ts` and `src/a.ts` are the same fix).
        const finding: ReviewFinding = { ...rawFinding, file: normalizeProjectPath(rawFinding.file) }
        if (finding.file !== file) {
          return { ok: false, error: `finding.file ("${rawFinding.file}") must match the file being fixed ("${rawFile}")` }
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
        const timestamp = new Date().toISOString()

        // Cross-process read-modify-write guard: the registry read (dup check)
        // and the record write form ONE window — two plugin processes racing
        // here could each read the old registry and silently drop the other's
        // update. The shared advisory lock (src/file-lock.ts) serializes the
        // window; the decision-log append runs after it is released.
        const applied = withProjectLock(projectRoot, 'fix-registry', ():
          | { ok: false; error: string; id?: string }
          | { ok: true; record: FixRecord; backupPath: string } => {
        const registry = readRegistry(projectRoot)
        if (findFixRecord(registry, id)) {
          return { ok: false, error: `finding already fixed this run (id: ${id})`, id }
        }

        // No-op guard: content-identical "fixes" (e.g. a fixer that re-sent the
        // file unchanged) must never burn a backup, a write, or a registry/success
        // record. Placed after the registry check so a re-sent fix of an id that
        // was ALREADY fixed is still reported as "already fixed this run".
        if (added === 0 && removed === 0) {
          return {
            ok: false,
            error: `no changes: the supplied content for ${file} is identical to the current content — apply a real edit`,
          }
        }

        const target = resolveProjectFile(projectRoot, file)
        if (!target.ok) return { ok: false, error: target.reason }

        // Personalization guards (SKILL.md Phase 2): protected_paths veto the
        // fix outright; forbidden_fixes veto fix approaches appearing in the
        // new content. Both are security-relevant, so they are enforced here
        // in the tool, not left to the model. The glob runs against the
        // NORMALIZED `file`, so `./README.md` cannot dodge a `README.md` veto.
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

        const backupPath = fixBackupPath(projectRoot, id, timestamp)
        try {
          mkdirSync(fixesDir(projectRoot), { recursive: true })
          copyFileSync(target.resolved, backupPath)
        } catch (err) {
          return { ok: false, error: `failed to create backup: ${String(err)}` }
        }

        try {
          writeTextAtomic(target.resolved, args.content)
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
          writeJsonAtomic(fixRegistryPath(projectRoot), nextRegistry)
        } catch (err) {
          // Registry write failed → the file was already modified but no record
          // exists, so a later rollback/diff could never see it and a retry would
          // back up the already-fixed content as "original". Restore the file
          // from the backup atomically to leave the tree exactly as it was.
          try {
            writeTextAtomic(target.resolved, readFileSync(backupPath, 'utf-8'))
          } catch (restoreErr) {
            return {
              ok: false,
              error: `failed to write fix registry: ${String(err)}; additionally failed to restore ${file} from backup: ${String(restoreErr)}`,
            }
          }
          return { ok: false, error: `failed to write fix registry: ${String(err)} (file restored from backup)` }
        }
        return { ok: true, record, backupPath }
        })

        if (!applied.ok) return applied
        const { record, backupPath } = applied

        const logRes = appendDecisionEntry(projectRoot, {
          timestamp,
          round: args.round,
          type: 'atomic_fix',
          data: { id, file, finding: finding.summary, linesAdded: added, linesRemoved: removed },
        })

        // The fix itself succeeded, but a decision-log write failure would leave
        // the audit trail incomplete — surface it (warning, not fatal) so the
        // model/UI knows the record was not persisted.
        return {
          ok: true,
          id,
          file,
          round: args.round,
          linesAdded: added,
          linesRemoved: removed,
          diffSummary: record.diffSummary,
          backupPath,
          ...(logRes.error ? { warning: logRes.error } : {}),
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
      // Read-only (never writes project files or plugin state) → safe to join
      // a parallel dispatch group alongside other read-only sibling calls.
      isConcurrencySafe: () => true,
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
        const file = typeof args.file === 'string' && args.file.trim()
          ? normalizeProjectPath(args.file)
          : undefined

        if (file) {
          const records = recordsForFile(registry, file)
          const first = records[0]
          if (!first) return { ok: false, error: `no fixes recorded for ${file}` }
          // Containment: the registry is on-disk JSON that a hand edit can
          // point anywhere — a tampered backupPath must never turn this
          // read-only diff into an arbitrary-file read.
          const backup = resolveBackupPath(projectRoot, first.backupPath)
          if (!backup.ok) return { ok: false, error: `invalid backup for ${file}: ${backup.reason}` }
          const current = readProjectFile(projectRoot, file)
          if (!current.ok) return { ok: false, error: current.reason }
          let original = ''
          try {
            original = readFileSync(backup.resolved, 'utf-8')
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
            const file = typeof r.finding.file === 'string' ? r.finding.file : ''
            if (!file) continue
            // Coerce defensively: a hand-edited registry record missing the
            // numeric fields must not produce NaN in the accumulated summary.
            const added = Number(r.linesAdded) || 0
            const removed = Number(r.linesRemoved) || 0
            const existing = files.find((f) => f.file === file)
            if (existing) {
              existing.linesAdded += added
              existing.linesRemoved += removed
              // Recompute the summary from the summed counts so a multi-fix
              // file's text does not contradict its accumulated numbers.
              existing.diffSummary = `+${existing.linesAdded}/-${existing.linesRemoved} lines`
            } else {
              files.push({
                file,
                diffSummary: typeof r.diffSummary === 'string' ? r.diffSummary : `+${added}/-${removed} lines`,
                linesAdded: added,
                linesRemoved: removed,
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
      // Pending-call card: which fix is about to be reverted.
      presentCall: (args) => {
        const a = args as { id?: unknown }
        if (typeof a.id !== 'string' || a.id.length === 0) return undefined
        return {
          card: 'generic',
          title: `Rollback fix ${a.id}`,
          kind: 'edit',
          rawInput: { id: a.id },
        }
      },
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
            warning: { type: 'string' },
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

        // One locked read-modify-write window (see src/file-lock.ts): the
        // registry read, the file restore, and the record removal must not
        // interleave with another process's fix/rollback or the update is lost.
        const restored = withProjectLock(projectRoot, 'fix-registry', ():
          | { ok: false; error: string }
          | { ok: true; record: FixRecord } => {
        const registry = readRegistry(projectRoot)
        const record = findFixRecord(registry, id)
        if (!record) return { ok: false, error: `fix not found: ${id}` }

        // LIFO safety: restoring an OLDER backup would silently destroy every
        // NEWER successful fix to the same file — their records would stay
        // success:true while the bytes they wrote are gone. Refuse and name
        // the clobbered ids so the caller can roll back in reverse order first.
        const fileRecords = recordsForFile(registry, record.finding.file)
        const targetIdx = fileRecords.findIndex((r) => r.id === id)
        const newer = targetIdx >= 0
          ? fileRecords.slice(targetIdx + 1)
          : fileRecords.filter((r) => r.id !== id && r.timestamp > record.timestamp)
        if (newer.length > 0) {
          const clobbered = newer.map((r) => r.id).join(', ')
          return {
            ok: false,
            error: `rollback refused: fix ${id} is older than fix(es) ${clobbered} on ${record.finding.file} — ` +
              'restoring its backup would destroy them. Roll back the later fix(es) first (LIFO order).',
          }
        }

        // Containment: the registry is on-disk JSON that a hand edit can
        // point anywhere — a tampered backupPath must never inject arbitrary
        // content into the project file.
        const backup = resolveBackupPath(projectRoot, record.backupPath)
        if (!backup.ok) return { ok: false, error: `invalid backup for fix ${id}: ${backup.reason}` }
        if (!existsSync(backup.resolved)) {
          return { ok: false, error: `backup missing for fix ${id}` }
        }

        const target = resolveProjectFile(projectRoot, record.finding.file)
        if (!target.ok) return { ok: false, error: target.reason }
        try {
          // Atomic restore: never leave a truncated source file if we crash
          // mid-restore (matches the writeTextAtomic guarantee used by apply).
          writeTextAtomic(target.resolved, readFileSync(backup.resolved, 'utf-8'))
        } catch (err) {
          return { ok: false, error: `failed to restore backup: ${String(err)}` }
        }

        const nextRegistry = removeRecord(registry, id)
        try {
          writeJsonAtomic(fixRegistryPath(projectRoot), nextRegistry)
        } catch (err) {
          return { ok: false, error: `failed to update fix registry: ${String(err)}` }
        }
        return { ok: true, record }
        })

        if (!restored.ok) return restored
        const record = restored.record

        const logRes = appendDecisionEntry(projectRoot, {
          timestamp: new Date().toISOString(),
          round: record.round,
          type: 'revert',
          data: { id, file: record.finding.file, revertedDiff: record.diffSummary },
        })

        // Mirror the reversal into the persisted observatory transcript (F4) so
        // the client no longer shows a rolled-back fix as "成功". Best-effort:
        // a missing/corrupt transcript is left untouched and never breaks the
        // rollback flow.
        await markFixRolledBackInTranscript(projectRoot, id)

        return {
          ok: true,
          id,
          file: record.finding.file,
          ...(logRes.error ? { warning: logRes.error } : {}),
        }
      },
    }),
  )
}
