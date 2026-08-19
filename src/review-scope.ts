/**
 * File-inventory collection, chunking, and coverage scoring for review scope.
 *
 * Mirrors `harness/iterate-harness/.../review_scope.py`. The iterate review
 * loop must force each reviewer subagent to actually open EVERY file in the
 * scope it is responsible for (not silently skip or assume files). This
 * module supplies the deterministic building blocks:
 *
 * - `collectScopeFiles`: produce the sorted relative-path inventory for a
 *   review scope (changed-only delta, or a full walk filtered to source files
 *   and stripped of dependency/build/vendor dirs).
 * - `chunkFiles`: split a large inventory into stable batches so `full`
 *   reviews stay bounded; consecutive files from the same directory are kept
 *   together to avoid splitting a module's review across two reviewers.
 * - `computeCoverage`: compare a reviewer's self-reported `readFiles` against
 *   the inventory it was assigned, returning a coverage ratio plus the list of
 *   files that were not opened. Consumed by meta-review as a
 *   *prompt-informative* metric (never a hard gate).
 *
 * Pure math (chunkFiles / computeCoverage) has no I/O so it unit-tests
 * cleanly; collectScopeFiles walks the filesystem.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface CoverageResult {
  assigned: string[]
  read: string[]
  covered: string[]
  uncovered: string[]
  ratio: number
}

/** Relative-scope sentinel for whole-module findings. */
export const WHOLE_FILE_LINE = 0

/** Source extensions a full-scope walk includes. */
const SOURCE_EXTENSIONS = new Set([
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.java', '.rs', '.c', '.h', '.cc', '.cpp', '.cs',
  '.swift', '.kt', '.scala', '.rb', '.php', '.sh', '.bash', '.zsh',
  '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte',
])

/** Directory names always excluded from a full-scope walk. */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env',
  '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', 'dist',
  'build', 'out', '.next', '.nuxt', 'coverage', '.tox', '.idea',
  '.vscode', 'target', '.release', '.dist_tmp',
])

/** Default chunk size for a `full` scope review (files per batch). */
export const DEFAULT_SCOPE_CHUNK_SIZE = 25

/** Coverage ratio at/above which a scope is fully covered. */
export const COVERAGE_TARGET = 0.95

const SEP = '/'

/**
 * Canonicalize separators + dot-segments. Leading `..` PATH segments are
 * PRESERVED (mirrors Python `os.path.normpath`, which never resolves beyond
 * the root), so callers can still detect path-escaping (`..`) after
 * normalization — a full `..`-driven traversal must not be silently folded
 * into a bare filename.
 */
function normalizePath(path: string): string {
  const cleaned = path.replace(/\\/g, SEP)
  const parts: string[] = []
  for (const part of cleaned.split(SEP)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      else parts.push(part) // no root segment to pop — keep the leading '..'
      continue
    }
    parts.push(part)
  }
  return parts.join(SEP)
}

function sourceExt(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name)
}

/** Collect the sorted relative-path inventory for a review scope. */
export function collectScopeFiles(
  root: string,
  opts: { scope: 'full' | 'changed-only'; changedFiles?: string[] },
): string[] {
  if (opts.scope === 'changed-only') return collectChanged(opts.changedFiles ?? [])
  return collectFull(root)
}

function collectChanged(changedFiles: string[]): string[] {
  const out = new Set<string>()
  for (const rel of changedFiles) {
    if (typeof rel !== 'string' || !rel.trim()) continue
    if (rel === String(WHOLE_FILE_LINE)) continue
    const cleaned = normalizePath(rel)
    if (cleaned.startsWith('..')) continue
    if (!sourceExt(cleaned)) continue
    out.add(cleaned)
  }
  return [...out].sort()
}

function collectFull(root: string): string[] {
  // Deterministic recursive walk built on Node's fs; a code reviewer never
  // anchors findings to lock files, images, or vendored builds.
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!sourceExt(entry.name)) continue
      const rel = abs.startsWith(root + SEP) ? abs.slice(root.length + 1) : abs
      out.push(rel.split(SEP).join(SEP))
    }
  }
  walk(root)
  return out.sort()
}

/** Split `files` into stable batches, keeping directory runs together. */
export function chunkFiles(files: string[], perChunk?: number): string[][] {
  const size = perChunk === undefined || perChunk < 1 ? DEFAULT_SCOPE_CHUNK_SIZE : perChunk
  const ordered = [...files].sort()
  const chunks: string[][] = []
  let current: string[] = []
  let lastDir: string | undefined
  for (const rel of ordered) {
    const parent = rel.includes(SEP) ? rel.slice(0, rel.lastIndexOf(SEP)) : '.'
    if (current.length > 0 && lastDir !== undefined && parent !== lastDir) {
      chunks.push(current)
      current = []
      lastDir = undefined
    }
    current.push(rel)
    lastDir = parent
    if (current.length >= size) {
      chunks.push(current)
      current = []
      lastDir = undefined
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Score self-reported reads against the assigned inventory. */
export function computeCoverage(
  assigned: string[],
  readFiles?: string[] | null,
): CoverageResult {
  const readNorm = new Set<string>()
  for (const p of readFiles ?? []) {
    if (typeof p === 'string' && p) readNorm.add(normalizePath(p))
  }
  const assignedSorted = [...assigned].sort()
  const covered = assignedSorted.filter((rel) => readNorm.has(normalizePath(rel)))
  const uncovered = assignedSorted.filter((rel) => !readNorm.has(normalizePath(rel)))
  const rawRatio =
    assignedSorted.length === 0 ? 1 : covered.length / assignedSorted.length
  const ratio = Math.round(rawRatio * 1000) / 1000
  return {
    assigned: assignedSorted,
    read: [...new Set((readFiles ?? []).filter((p): p is string => typeof p === 'string'))].sort(),
    covered,
    uncovered,
    ratio,
  }
}

/** Serialize a coverage result for the tool-layer JSON wire shape. */
export function coverageToDict(c: CoverageResult): Record<string, unknown> {
  return {
    assigned: c.assigned,
    read: c.read,
    covered: c.covered,
    uncovered: c.uncovered,
    ratio: c.ratio,
    met: c.ratio >= COVERAGE_TARGET,
  }
}