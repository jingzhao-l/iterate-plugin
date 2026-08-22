/**
 * Deterministic code-evidence verification for review findings.
 *
 * Mirror of `iterate_harness/iterate/evidence.py` for the iterate-plugin.
 *
 * The iterate review loop requires that reviewer subagent findings ANCHOR to
 * real code instead of speculating. This module enforces it:
 *
 * - a finding's `file` must resolve to an existing file under the project root
 *   (traversal-safe), otherwise evidence is poisoned (`file_not_found`);
 * - a finding with an explicit line must reference a line that actually exists
 *   in that file (`line_out_of_range`);
 * - a whole-file finding (line 0 / undefined) must still reference an existing
 *   file, so even structural findings cannot point at nothing;
 * - `readVerified` is a best-effort, NON-gating hint: the plugin's reviewers are
 *   subagents whose reads are not aggregated here, so it is only set when a
 *   read set is explicitly provided and never fails the audit.
 *
 * Gate rule (user preference): ANY localizable finding with poisoned evidence
 * flips the whole audit to `passed: false`, so the meta-review forces revision.
 *
 * The pure math (`countLines`, `verifyLineBounds`) is separated from the
 * filesystem half (`verifyFinding`) to stay unit-testable without touching disk.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ReviewFinding } from './types.ts'

/** Sentinel for whole-file findings (line 0 or omitted means the whole file). */
export const WHOLE_FILE_LINE = 0

/**
 * Hard cap on a single evidence file read. `verifyFinding` only needs the
 * line count + a NUL check; reading an unbounded file (or a device file
 * reached through a symlink) is a memory/hang hazard, so anything larger is
 * treated as not line-addressable.
 */
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024

export type EvidenceError = 'file_not_found' | 'line_out_of_range'

/** Per-finding attestation result. */
export interface FindingEvidence {
  file: string
  line: number | null
  lineTotal: number | null
  resolvedPath: string | null
  verified: boolean
  error?: EvidenceError
  /** True/False only when a read-set is supplied; undefined = not checkable. */
  readVerified?: boolean
}

/** Aggregate attestation over a findings list. */
export interface EvidenceAudit {
  checked: number
  results: FindingEvidence[]
}

/** A single finding object that exposes `file` / `line` (for verification). */
interface Locatable {
  file?: string
  line?: number
}

/** Number of physical lines in `text`. A trailing newline does not add a line. */
export function countLines(text: string): number {
  if (text === '') return 0
  // Mirrors Python `str.splitlines()`: split on every line separator, not just
  // \r\n|\r|\n — otherwise line counts diverge from the harness on files
  // containing \v \f \x1c-\x1e \x85 \u2028 \u2029.
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  // A trailing newline leaves an empty final element that is NOT a line
  // (mirrors Python `str.splitlines()` used by the harness).
  if (parts[parts.length - 1] === '') return parts.length - 1
  return parts.length
}

/** Resolve `root/rel` and reject any path escaping `root` (returns null). */
export function resolveWithin(root: string, rel: string): string | null {
  const resolved = resolve(root, rel)
  const rootResolved = resolve(root)
  if (resolved === rootResolved) return resolved
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (!resolved.startsWith(prefix)) return null
  return resolved
}

/** True when `candidate` is `root` itself or lexically inside `root`. */
function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate.startsWith(prefix)
}

/** best-effort realpath; falls back to the lexical path on any failure. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Pure check that `line` (if anchored) exists in `text`.
 * Whole-file findings (undefined/0) are always bounds-valid.
 */
export function verifyLineBounds(
  line: number | null | undefined,
  text: string,
): { inBounds: boolean; lineTotal: number } {
  const lineTotal = countLines(text)
  if (line === undefined || line === null || line === WHOLE_FILE_LINE) {
    return { inBounds: true, lineTotal }
  }
  if (line < 1) return { inBounds: false, lineTotal }
  return { inBounds: line <= lineTotal, lineTotal }
}

/** Verify a single finding's location against the real filesystem. */
export function verifyFinding(
  root: string,
  input: Locatable,
  opts: { readSet?: Set<string> } = {},
): FindingEvidence {
  const relFile = input.file ?? ''
  const line = typeof input.line === 'number' ? input.line : null
  const resolved = resolveWithin(root, relFile)

  if (resolved === null || !existsSync(resolved)) {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'file_not_found',
    }
  }

  // Symlink containment: resolveWithin is lexical only, but existsSync /
  // readFileSync follow symlinks. Verify the REAL path stays inside the REAL
  // project root so a finding path can never read (or line-count) a file
  // outside the project via a symlinked directory or file.
  const rootReal = safeRealpath(root)
  const real = safeRealpath(resolved)
  if (!isWithin(rootReal, real)) {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'file_not_found',
    }
  }

  // Regular-file + size guard: a directory, device file (/dev/zero), FIFO or
  // multi-GB file is not a line-addressable text target. statSync follows
  // symlinks, so a link to a device still lands here and is rejected.
  let st
  try {
    st = statSync(resolved)
  } catch {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'file_not_found',
    }
  }
  if (!st.isFile() || st.size > MAX_EVIDENCE_BYTES) {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'line_out_of_range',
    }
  }

  let raw: Buffer
  try {
    raw = readFileSync(resolved)
  } catch {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'file_not_found',
    }
  }

  // A file is not line-addressable if it contains a NUL byte (binary payload).
  // Anchored line numbers on a binary file cannot be trusted, so treat them the
  // same as an out-of-range line rather than credulously accepting them
  // (mirrors the harness `evidence.py` NUL check).
  if (raw.includes(0)) {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: resolved,
      verified: false,
      error: 'line_out_of_range',
    }
  }

  const text = raw.toString('utf-8')
  const { inBounds, lineTotal } = verifyLineBounds(line, text)
  if (!inBounds) {
    return {
      file: relFile,
      line,
      lineTotal,
      resolvedPath: resolved,
      verified: false,
      error: 'line_out_of_range',
    }
  }

  const outcome: FindingEvidence = {
    file: relFile,
    line,
    lineTotal,
    resolvedPath: resolved,
    verified: true,
  }
  if (opts.readSet !== undefined) {
    outcome.readVerified = opts.readSet.has(resolved)
  }
  return outcome
}

/** Attest every finding in a list. */
export function verifyFindings(
  root: string,
  findings: Locatable[],
  opts: { readSet?: Set<string> } = {},
): EvidenceAudit {
  const results = findings.map((f) => verifyFinding(root, f, opts))
  return { checked: results.length, results }
}

/** `passed` is true only when no real existence failure exists (read is a hint). */
export function evidencePassed(audit: EvidenceAudit): boolean {
  return audit.results.every((r) => r.error === undefined)
}

/** Violating (non-grounded) results. */
export function evidenceViolations(audit: EvidenceAudit): FindingEvidence[] {
  return audit.results.filter((r) => r.error !== undefined)
}

/** Serialize an audit for tool payloads (pure). */
export function evidenceToPlain(audit: EvidenceAudit): Record<string, unknown> {
  const computable = audit.results.filter((r) => r.readVerified !== undefined)
  const readRatio =
    computable.length === 0
      ? null
      : Number(
          (
            computable.filter((r) => r.readVerified === true).length / computable.length
          ).toFixed(3),
        )
  return {
    checked: audit.checked,
    passed: evidencePassed(audit),
    violations: audit.results
      .filter((r) => r.error !== undefined)
      .map((r) => ({ file: r.file, line: r.line, lineTotal: r.lineTotal, verified: r.verified, error: r.error })),
    readVerifiedRatio: readRatio,
  }
}