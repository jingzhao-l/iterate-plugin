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
 *   - Privacy switch: when the project's effective config sets
 *     `observatory.capture: false`, nothing is persisted (the file stays
 *     absent/unchanged). An unreadable config keeps capture ON (defaults).
 *   - The live file is byte-capped (rewrite to last N lines when it grows too
 *     large) so it can never grow unbounded.
 *   - Any capture failure is swallowed (fire-and-forget) so it can never block
 *     or crash a tool call.
 */
import { mkdir, readFile, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeTextAtomicAsync } from "./atomic-fs.js";
import { join } from 'node:path';
import { loadEffectiveConfig, resolveProjectRoot } from "./config-loader.js";
/** Keep at most this many live activity entries. */
export const LIVE_MAX_ENTRIES = 300;
/** Rewrite the live file when its byte size exceeds this threshold. */
export const LIVE_MAX_BYTES = 64 * 1024;
/** File path of the live NDJSON feed for a project root. */
export function liveFilePath(projectRoot) {
    return join(projectRoot, '.iterate', 'transcript-live.ndjson');
}
/**
 * Module-level in-process queue serializing live-feed writes. The trim path
 * (read → rewrite → append) is a read-modify-write: two concurrent tool
 * results could interleave and one's rewrite would silently drop the other's
 * freshly-appended line. Chaining every append onto one tail makes the whole
 * read+rewrite+append atomic within the process (the only realistic mode for
 * the plugin); cross-process racing remains a theoretical hazard, but the
 * cap-trim makes a lost line a cosmetic issue, not a correctness one.
 */
let liveWriteQueue = Promise.resolve();
function enqueueLiveWrite(task) {
    const next = liveWriteQueue.then(task, task);
    liveWriteQueue = next.catch(() => { });
    return next;
}
/**
 * True when the project's effective config still allows live capture.
 * `observatory.capture: false` opts the project out — nothing is persisted.
 * Failure modes keep TODAY'S behavior: `loadEffectiveConfig` never throws on
 * an unreadable config (it falls back to defaults, capture on), and any
 * unexpected loader error here also degrades to capture ON rather than
 * silently eating activity the operator expected to see.
 */
function captureEnabled(projectRoot) {
    try {
        return loadEffectiveConfig(projectRoot).config.observatory?.capture !== false;
    }
    catch {
        return true;
    }
}
/**
 * Append one activity record to the project's live feed (byte-capped).
 * Never rejects: every failure (capture disabled, `.iterate` existing as a
 * regular file, locked/unwritable feed) is swallowed — the header promises
 * this path can never crash or block a tool call (`void appendLive(...)`
 * would otherwise turn a rejection into an unhandled rejection).
 */
export function appendLive(projectRoot, entry) {
    return enqueueLiveWrite(async () => {
        try {
            // Privacy: capture off → do not touch the feed at all.
            if (!captureEnabled(projectRoot))
                return;
            const file = liveFilePath(projectRoot);
            const line = JSON.stringify(entry) + '\n';
            // mkdir is INSIDE the guard: `.iterate` may be a regular file (or the
            // dir unwritable) — it must reject neither the caller nor the queue.
            await mkdir(join(projectRoot, '.iterate'), { recursive: true });
            // Amortized O(1): only read+rewrite when the file has grown past the cap.
            const st = await stat(file).catch(() => null);
            if (st && st.size > LIVE_MAX_BYTES) {
                const raw = await readFile(file, 'utf-8');
                const lines = raw.split('\n').filter(Boolean);
                const tail = lines.slice(-LIVE_MAX_ENTRIES);
                // Atomic rewrite (unique temp + rename) so a crash mid-trim never
                // truncates the live feed; the temp file is prunable by iterate_prune.
                await writeTextAtomicAsync(file, tail.join('\n') + '\n');
            }
            await appendFile(file, line, 'utf-8');
        }
        catch {
            // Fire-and-forget: never let live capture break a tool call.
        }
    });
}
/** Resolve the project root a tool execution belongs to, if any. */
function projectRootOf(exec) {
    const cwd = exec.agent?.session?.header?.cwd;
    if (!cwd)
        return null;
    const resolved = resolveProjectRoot(undefined, cwd);
    return resolved.ok ? resolved.root : null;
}
/** Classify a settled tool call into a live activity entry, or null to skip. */
export function classifyTool(name, args, projectRoot) {
    // `read_file` is the dsh-native file reader reviewers use to inspect code.
    if (name === 'read_file') {
        const file = args && typeof args === 'object' && typeof args.path === 'string'
            ? args.path
            : '';
        return file ? { ts: new Date().toISOString(), type: 'read', tool: name, target: file } : null;
    }
    // The iterate plugin's own tools — surface what the workflow is doing live.
    const records = {
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
        // v3.0 quality command-center tools — surface their activity in the live
        // feed too (previously these three never produced a live entry).
        iterate_experience: 'info',
        iterate_quality_gate: 'info',
        iterate_defense_events: 'info',
    };
    const type = records[name];
    if (!type)
        return null;
    let target = '';
    if (args && typeof args === 'object') {
        const a = args;
        if (typeof a.file === 'string' && a.file)
            target = a.file;
        else if (typeof a.path === 'string' && a.path)
            target = a.path;
        else if (typeof a.operation === 'string' && a.operation)
            target = a.operation;
        else if (name === 'iterate_rollback' && typeof a.id === 'string' && a.id) {
            target = `fix ${a.id}`;
        }
    }
    if (!target)
        target = name;
    return { ts: new Date().toISOString(), type, tool: name, target };
}
/** Read the live feed (newest first), capped at the last LIVE_MAX_ENTRIES. */
export async function readLive(projectRoot) {
    const file = liveFilePath(projectRoot);
    if (!existsSync(file))
        return [];
    try {
        const raw = await readFile(file, 'utf-8');
        const entries = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed.ts === 'string' && typeof parsed.type === 'string') {
                    entries.push(parsed);
                }
            }
            catch {
                // skip malformed lines
            }
        }
        return entries.slice(-LIVE_MAX_ENTRIES).reverse();
    }
    catch {
        return [];
    }
}
/**
 * Register a `tools/result` observer that captures reviewer activity into the
 * project's live feed. Fire-and-forget; failures are swallowed.
 */
export function registerLiveCapture(ctx) {
    ctx.on('tools/result', (exec) => {
        // Defensive: a hostile/proxied exec whose getters throw (`agent`,
        // `name`, `arguments`) must not abort the observer — unlike the guarded
        // siblings below, an unguarded throw here would lose the record and
        // surface an error from a read-only hook. Degrade to a no-op.
        try {
            const root = projectRootOf(exec);
            if (!root)
                return;
            const entry = classifyTool(exec.name, exec.arguments, root);
            if (!entry)
                return;
            void appendLive(root, entry);
        }
        catch {
            // An observer must never throw.
        }
    });
}
