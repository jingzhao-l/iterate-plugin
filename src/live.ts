/**
 * src/live.ts — live reviewer-activity feed for the iterate observatory (F1 live).
 *
 * Watches `tools/result` and, for tool calls we can attribute to a project root
 * (the caller agent's session cwd), appends one line to an append-only NDJSON
 * file `.iterate/transcript-live.ndjson`. The `iterate_transcript` tool then
 * mixes the most recent entries into its `read` / `capture` results so the
 * client observatory shows what reviewers are doing in near-real-time (which
 * files they read, which fixes/rollbacks/diffs land, where the run is).
 *
 * Why project-scoped (not per-thread):
 *   Tool executions carry the calling agent's session cwd but NOT the workflow
 *   sub-agent's `dimension` / `round` label, so we cannot reliably attribute a
 *   read to a specific reviewer thread without inventing data. We therefore
 *   record honest project-level activity and never fabricate an attribution.
 *   Per-thread narration stays the job of the final `iterate_transcript capture`.
 *
 * Safety:
 *   - Read-only observer: never mutates source files; writes only the NDJSON
 *     live file under `.iterate/`.
 *   - The live file is byte-capped (rewrite to last N lines when it grows too
 *     large) so it can never grow unbounded.
 *   - Any capture failure is swallowed (fire-and-forget) so it can never block
 *     or crash a tool call.
 */

import { mkdir, readFile, writeFile, stat, appendFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveProjectRoot } from './config-loader.ts'

/** Keep at most this many live activity entries. */
export const LIVE_MAX_ENTRIES = 300
/** Rewrite the live file when its byte size exceeds this threshold. */
export const LIVE_MAX_BYTES = 64 * 1024

/** One live activity record. */
export interface LiveActivityEntry {
  /** ISO 8601 timestamp of the tool result. */
  ts: string
  /** Coarse category used by the client for coloring/grouping. */
  type:
    | 'read'
    | 'fix'
    | 'rollback'
    | 'diff'
    | 'review'
    | 'triage'
    | 'checkpoint'
    | 'validate'
    | 'log'
    | 'prune'
    | 'info'
  /** The tool that produced the activity. */
  tool: string
  /**
   * The affected target: a source file path (relative to project root) for
   * read/fix/rollback/diff, else a summary string (e.g. the review operation).
   */
  target: string
}

/** File path of the live NDJSON feed for a project root. */
export function liveFilePath(projectRoot: string): string {
  return join(projectRoot, '.iterate', 'transcript-live.ndjson')
}

/** Resolve the project root a tool execution belongs to, if any. */
function projectRootOf(exec: ToolExecution): string | null {
  const cwd = exec.agent?.session?.header?.cwd
  if (!cwd) return null
  const resolved = resolveProjectRoot(undefined, cwd)
  return resolved.ok ? resolved.root : null
}

/** Classify a settled tool call into a live activity entry, or null to skip. */
export function classifyTool(
  name: string,
  args: unknown,
  projectRoot: string,
): LiveActivityEntry | null {
  // `read_file` is the dsh-native file reader reviewers use to inspect code.
  if (name === 'read_file') {
    const file =
      args && typeof args === 'object' && typeof (args as Record<string, unknown>).path === 'string'
        ? (args as Record<string, unknown>).path as string
        : ''
    return file ? { ts: new Date().toISOString(), type: 'read', tool: name, target: file } : null
  }

  // The iterate plugin's own tools — surface what the workflow is doing live.
  const records: Record<string, LiveActivityEntry['type']> = {
    iterate_fix: 'fix',
    iterate_rollback: 'rollback',
    iterate_diff: 'diff',
    iterate_review: 'review',
    iterate_triage: 'triage',
    iterate_checkpoint: 'checkpoint',
    iterate_validate: 'validate',
    iterate_decision_log: 'log',
    iterate_history: 'info',
    iterate_prune: 'prune',
    iterate_transcript: 'log',
    iterate_status: 'info',
    iterate_config: 'info',
    iterate_context: 'info',
  }
  const type = records[name]
  if (!type) return null

  let target = ''
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>
    if (typeof a.file === 'string' && a.file) target = a.file
    else if (typeof a.path === 'string' && a.path) target = a.path
    else if (typeof a.operation === 'string' && a.operation) target = a.operation
    else if (name === 'iterate_rollback' && typeof a.id === 'string' && a.id) {
      target = `fix ${a.id}`
    }
  }
  if (!target) target = name
  return { ts: new Date().toISOString(), type, tool: name, target }
}

/** Append one activity record to the project's live feed (byte-capped). */
export async function appendLive(projectRoot: string, entry: LiveActivityEntry): Promise<void> {
  const file = liveFilePath(projectRoot)
  const line = JSON.stringify(entry) + '\n'
  await mkdir(join(projectRoot, '.iterate'), { recursive: true })
  // Amortized O(1): only read+rewrite when the file has grown past the cap.
  try {
    const st = await stat(file).catch(() => null)
    if (st && st.size > LIVE_MAX_BYTES) {
      const raw = await readFile(file, 'utf-8')
      const lines = raw.split('\n').filter(Boolean)
      const tail = lines.slice(-LIVE_MAX_ENTRIES)
      const tmp = `${file}.trim.tmp`
      await writeFile(tmp, tail.join('\n') + '\n', 'utf-8')
      await rename(tmp, file)
    }
    await appendFile(file, line, 'utf-8')
  } catch {
    // Fire-and-forget: never let live capture break a tool call.
  }
}

/** Read the live feed (newest first), capped at the last LIVE_MAX_ENTRIES. */
export async function readLive(projectRoot: string): Promise<LiveActivityEntry[]> {
  const file = liveFilePath(projectRoot)
  if (!existsSync(file)) return []
  try {
    const raw = await readFile(file, 'utf-8')
    const entries: LiveActivityEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as LiveActivityEntry
        if (parsed && typeof parsed.ts === 'string' && typeof parsed.type === 'string') {
          entries.push(parsed)
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries.slice(-LIVE_MAX_ENTRIES).reverse()
  } catch {
    return []
  }
}

/**
 * Register a `tools/result` observer that captures reviewer activity into the
 * project's live feed. Fire-and-forget; failures are swallowed.
 */
export function registerLiveCapture(ctx: Context): void {
  ctx.on('tools/result', (exec: ToolExecution) => {
    const root = projectRootOf(exec)
    if (!root) return
    const entry = classifyTool(exec.name, exec.arguments, root)
    if (!entry) return
    void appendLive(root, entry)
  })
}