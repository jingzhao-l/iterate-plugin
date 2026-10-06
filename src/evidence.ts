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
 * - a finding with an explicit line must reference an INTEGER line that
 *   actually exists in that file (`line_out_of_range`); a fractional line
 *   (e.g. 42.5) can never anchor to real code and fails the gate, and so
 *   does a PRESENT-but-non-numeric line (`"42"`, `true`) — only an absent or
 *   null line keeps the whole-file semantics;
 * - files that exist but cannot be line-addressed report a DISTINCT error:
 *   `file_too_large` (over MAX_EVIDENCE_BYTES) or `binary_file` (NUL bytes),
 *   so the meta-review can describe the actual reason instead of lumping
 *   every non-addressable file into `line_out_of_range`;
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

/**
 * Why a finding's location could not be verified.
 *
 * `file_too_large` / `binary_file` are intentionally distinct from
 * `line_out_of_range`: the finding still fails the evidence gate (any error
 * does), but consumers (meta-review detail text, tool payloads) can describe
 * the real reason. `line_out_of_range` keeps covering "line anchor does not
 * exist in this file" and "target is not a regular file (dir/device)".
 */
export type EvidenceError =
  | 'file_not_found'
  | 'line_out_of_range'
  | 'file_too_large'
  | 'binary_file'

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

/**
 * Cached outcome of the per-file filesystem probe (containment + stat + size
 * cap + full read + NUL check + line count). Computed once per resolved path
 * per audit and reused for every finding anchored to that file; the
 * per-finding line-bounds check still runs against each finding's own `line`.
 */
export interface FileProbe {
  /** Lexical resolved path (null only when the path escapes the root). */
  resolvedPath: string | null
  /** `'text'` = line-addressable; anything else is the EvidenceError to report. */
  outcome: 'text' | EvidenceError
  /** Physical line count when `outcome === 'text'`; null otherwise. */
  lineTotal: number | null
}

/**
 * Point-in-time per-file probe cache keyed by resolved (lexical) path.
 *
 * `verifyFindings` creates one per call by default, so results always reflect
 * the filesystem at audit time. Supplying your own via `opts.cache` shares it
 * across calls — later calls then answer from the FIRST probe (a deliberate
 * snapshot; they do not re-stat/re-read).
 */
export type EvidenceFileCache = Map<string, FileProbe>

/** Create an empty probe cache for `opts.cache`. */
export function createEvidenceCache(): EvidenceFileCache {
  return new Map()
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
 * Pure decision: does `line` anchor to an existing line in a file with
 * `lineTotal` lines? Shared by `verifyLineBounds` and the cached probe path
 * (which has the line count but not the text).
 */
function lineInBounds(line: number | null | undefined, lineTotal: number): boolean {
  // Whole-file findings (undefined/null/0 = WHOLE_FILE_LINE) are always
  // bounds-valid — semantics preserved from the original gate.
  if (line === undefined || line === null || line === WHOLE_FILE_LINE) return true
  // Only a positive INTEGER is a valid line anchor. A fractional line (e.g.
  // 42.5 from a bypassed schema), NaN, ±Infinity or a negative value is out of
  // bounds — a fractional line "within" the file would otherwise be accepted
  // and poison the evidence trail with a location nothing can jump to.
  if (line < 1 || !Number.isInteger(line)) return false
  return line <= lineTotal
}

/**
 * Pure check that `line` (if anchored) exists in `text`.
 * Whole-file findings (undefined/0) are always bounds-valid.
 *
 * Exported PUBLIC API: the production gate routes through the cached probe
 * path (`lineInBounds` + the per-file line count), while tests and external
 * consumers use this text-based form. Kept — not deleted — for that reason.
 */
export function verifyLineBounds(
  line: number | null | undefined,
  text: string,
): { inBounds: boolean; lineTotal: number } {
  const lineTotal = countLines(text)
  return { inBounds: lineInBounds(line, lineTotal), lineTotal }
}

/**
 * One filesystem probe for `root`/`resolved`: symlink containment, stat,
 * regular-file + size cap, full read, NUL check, line count. Everything a
 * finding needs beyond its own per-line check is captured in the result so
 * repeated findings on the same file never re-stat or re-read it.
 */
function probeEvidenceFile(root: string, resolved: string): FileProbe {
  // Symlink containment: resolveWithin is lexical only, but existsSync /
  // readFileSync follow symlinks. Verify the REAL path stays inside the REAL
  // project root so a finding path can never read (or line-count) a file
  // outside the project via a symlinked directory or file.
  const rootReal = safeRealpath(root)
  const real = safeRealpath(resolved)
  if (!isWithin(rootReal, real)) {
    return { resolvedPath: resolved, outcome: 'file_not_found', lineTotal: null }
  }

  // Regular-file + size guard: a directory, device file (/dev/zero), FIFO or
  // multi-GB file is not a line-addressable text target. statSync follows
  // symlinks, so a link to a device still lands here and is rejected.
  let st
  try {
    st = statSync(resolved)
  } catch {
    return { resolvedPath: resolved, outcome: 'file_not_found', lineTotal: null }
  }
  if (!st.isFile()) {
    // Directory / device / FIFO: exists but is not line-addressable at all.
    return { resolvedPath: resolved, outcome: 'line_out_of_range', lineTotal: null }
  }
  if (st.size > MAX_EVIDENCE_BYTES) {
    return { resolvedPath: resolved, outcome: 'file_too_large', lineTotal: null }
  }

  let raw: Buffer
  try {
    raw = readFileSync(resolved)
  } catch {
    return { resolvedPath: resolved, outcome: 'file_not_found', lineTotal: null }
  }

  // A file containing a NUL byte is a binary payload: anchored line numbers
  // on it cannot be trusted (mirrors the harness `evidence.py` NUL check).
  // Reported as `binary_file` so it is distinguishable from a plain
  // out-of-range line anchor.
  if (raw.includes(0)) {
    return { resolvedPath: resolved, outcome: 'binary_file', lineTotal: null }
  }
  return { resolvedPath: resolved, outcome: 'text', lineTotal: countLines(raw.toString('utf-8')) }
}

/** Shared options for `verifyFinding` / `verifyFindings`. */
export interface EvidenceVerifyOptions {
  /** Read set backing the non-gating `readVerified` hint. */
  readSet?: Set<string>
  /**
   * Optional shared probe cache. `verifyFindings` allocates one per call when
   * omitted; pass your own to reuse a prior snapshot across calls (see
   * `EvidenceFileCache`).
   */
  cache?: EvidenceFileCache
}

/** Verify a single finding's location against the real filesystem. */
export function verifyFinding(
  root: string,
  input: Locatable,
  opts: EvidenceVerifyOptions = {},
): FindingEvidence {
  // A null element / non-object finding (hostile or model-authored JSON) must
  // be reported as poisoned evidence, never crash `path.resolve` downstream.
  if (!input || typeof input !== 'object') {
    return {
      file: '',
      line: null,
      lineTotal: null,
      resolvedPath: null,
      verified: false,
      error: 'file_not_found',
    }
  }
  // A non-string `file` (number, object, …) would make `resolve` throw
  // ERR_INVALID_ARG_TYPE — coerce to "" so it fails closed as not-found.
  const relFile = typeof input.file === 'string' ? input.file : ''
  const rawLine: unknown = (input as { line?: unknown }).line
  const line = typeof rawLine === 'number' ? rawLine : null
  // A PRESENT `line` must be a number. `line: "42"` / `line: true` (schema-
  // bypassing JSON) is a claimed anchor we cannot resolve — fail closed as
  // poisoned evidence instead of silently degrading it to a whole-file
  // finding. Only an absent / null line keeps the WHOLE_FILE_LINE semantics.
  const badLineType = rawLine !== undefined && rawLine !== null && typeof rawLine !== 'number'

  // "" resolves to the project ROOT (resolve(root, '') === root), which then
  // trips the not-a-regular-file branch — but there is no file reference at
  // all. Report it as `file_not_found` upfront.
  if (relFile === '') {
    return {
      file: '',
      line,
      lineTotal: null,
      resolvedPath: null,
      verified: false,
      error: 'file_not_found',
    }
  }

  const resolved = resolveWithin(root, relFile)
  let probe: FileProbe
  if (resolved === null) {
    // Path escapes the root: no I/O happens, so nothing to cache.
    probe = { resolvedPath: null, outcome: 'file_not_found', lineTotal: null }
  } else {
    const cached = opts.cache?.get(resolved)
    if (cached) {
      probe = cached
    } else {
      if (!existsSync(resolved)) {
        probe = { resolvedPath: resolved, outcome: 'file_not_found', lineTotal: null }
      } else {
        probe = probeEvidenceFile(root, resolved)
      }
      // Cache every resolved-path outcome (including not-found) so repeated
      // findings on the same file cost one stat/read per audit, not one per
      // finding (O(F×bytes) → O(unique files × bytes)).
      if (opts.cache) opts.cache.set(resolved, probe)
    }
  }

  if (probe.outcome !== 'text') {
    return {
      file: relFile,
      line,
      lineTotal: null,
      resolvedPath: probe.resolvedPath,
      verified: false,
      error: probe.outcome,
    }
  }

  const lineTotal = probe.lineTotal ?? 0
  // Present-but-unanchorable line type (string/boolean/object): the file is
  // real, but the claimed location can never be verified → poisoned.
  if (badLineType) {
    return {
      file: relFile,
      line,
      lineTotal,
      resolvedPath: probe.resolvedPath,
      verified: false,
      error: 'line_out_of_range',
    }
  }
  if (!lineInBounds(line, lineTotal)) {
    return {
      file: relFile,
      line,
      lineTotal,
      resolvedPath: probe.resolvedPath,
      verified: false,
      error: 'line_out_of_range',
    }
  }

  const outcome: FindingEvidence = {
    file: relFile,
    line,
    lineTotal,
    resolvedPath: probe.resolvedPath,
    verified: true,
  }
  if (opts.readSet !== undefined) {
    // Per-finding, never cached: the read set may differ between calls sharing
    // a probe cache, and membership is a cheap in-memory lookup.
    outcome.readVerified = opts.readSet.has(resolved!)
  }
  return outcome
}

/** Attest every finding in a list (one shared per-file probe per call). */
export function verifyFindings(
  root: string,
  findings: Locatable[],
  opts: EvidenceVerifyOptions = {},
): EvidenceAudit {
  const cache = opts.cache ?? createEvidenceCache()
  const scoped: EvidenceVerifyOptions = opts.cache ? opts : { ...opts, cache }
  const results = findings.map((f) => verifyFinding(root, f, scoped))
  return { checked: results.length, results }
}

/** `passed` is true only when no real existence failure exists (read is a hint). */
export function evidencePassed(audit: EvidenceAudit): boolean {
  return audit.results.every((r) => r.error === undefined)
}

/**
 * Violating (non-grounded) results.
 *
 * Exported PUBLIC API (tests and integrations filter by it directly);
 * the production payload uses `evidenceToPlain`, which inlines the same
 * filter — so this stays as the named, shared accessor rather than being
 * folded into it.
 */
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