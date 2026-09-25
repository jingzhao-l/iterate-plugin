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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeTextAtomicAsync } from "../atomic-fs.js";
import { dirname } from 'node:path';
import { loadEffectiveConfig, resolveProjectRootForExec, } from "../config-loader.js";
import { transcriptPath } from "../paths.js";
import { ReviewTranscriptBuilder } from "../transcript.js";
import { readLive } from "../live.js";
/** Build per-dimension threads for one round from its (dimension-tagged) findings. */
function captureRound(builder, round) {
    if (!round || typeof round !== 'object')
        return;
    const r = round;
    const roundNo = typeof r.round === 'number' && Number.isFinite(r.round) ? Math.floor(r.round) : 0;
    // NaN round values (`Math.floor(NaN) === NaN`, and `NaN <= 0` is false) would
    // fall through the guard below; a finite check rejects them outright so a
    // malformed round can never collapse into round 1 via the builder's coercion.
    if (roundNo <= 0)
        return;
    builder.roundStart(roundNo);
    const findings = Array.isArray(r.findings) ? r.findings : [];
    const readFiles = Array.isArray(r.readFiles) ? r.readFiles : [];
    // Group the round's findings by dimension → one reviewer thread each.
    const byDim = new Map();
    for (const f of findings) {
        if (!f || typeof f !== 'object')
            continue;
        const rec = f;
        const dim = typeof rec.dimension === 'string' && rec.dimension ? rec.dimension : 'review';
        const list = byDim.get(dim) ?? [];
        list.push(f);
        byDim.set(dim, list);
    }
    if (byDim.size === 0) {
        builder.reviewerSnapshot('review', [], readFiles);
    }
    else {
        for (const [dim, list] of byDim)
            builder.reviewerSnapshot(dim, list, readFiles);
    }
}
/** Normalize the checkpoint shape if present. */
function normalizeCheckpoint(input) {
    if (!input || typeof input !== 'object')
        return null;
    const c = input;
    // Number.isFinite: a NaN round must not pass `round <= 0` (which is false for
    // NaN) and later coerce into a phantom round 1 row.
    const round = typeof c.round === 'number' && Number.isFinite(c.round) ? c.round : 0;
    if (round <= 0)
        return null;
    return {
        mode: c.mode === 'dry-run' || c.mode === 'normal' ? c.mode : 'normal',
        round,
        maxRounds: typeof c.maxRounds === 'number' && Number.isFinite(c.maxRounds) ? c.maxRounds : 0,
        fixedCount: typeof c.fixedCount === 'number' && Number.isFinite(c.fixedCount) ? c.fixedCount : 0,
        resumeCount: typeof c.resumeCount === 'number' && Number.isFinite(c.resumeCount) ? c.resumeCount : 0,
        updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : new Date().toISOString(),
    };
}
/** Normalize a fix record. */
function normalizeFix(input) {
    if (!input || typeof input !== 'object')
        return null;
    const f = input;
    const id = typeof f.id === 'string' ? f.id : '';
    const file = typeof f.file === 'string' ? f.file : '';
    if (!id || !file)
        return null;
    return {
        id,
        timestamp: typeof f.timestamp === 'string' ? f.timestamp : new Date().toISOString(),
        round: typeof f.round === 'number' && Number.isFinite(f.round) ? f.round : 0,
        file,
        summary: typeof f.summary === 'string' ? f.summary : '',
        linesAdded: typeof f.linesAdded === 'number' ? f.linesAdded : 0,
        linesRemoved: typeof f.linesRemoved === 'number' ? f.linesRemoved : 0,
        success: f.success !== false,
    };
}
/** Register the `iterate_transcript` tool. */
export function registerTranscriptTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_transcript',
        // `read` never writes; `capture`/`nudge` persist transcript state → only
        // read joins a parallel dispatch group.
        isConcurrencySafe: (args) => args.operation === 'read',
        description: 'Runtime-observatory transcript for the iterate workflow. ' +
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
            taskMode: {
                type: 'string',
                description: 'For `capture`: harness execution mode ("code" | "iterate"). Default derives from the review loop (iterate).',
                enum: ['code', 'iterate'],
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
            stoppedReason: { type: 'string', description: 'For `capture`: why the run ended — "converged" | "max_rounds_reached" | "aborted_by_validation" | "aborted_by_config" | "schema_invalid" | "no_usable_reviewer_output" | "inconclusive". When omitted, derived from the convergence trend (trailing 0 = converged, otherwise = max_rounds_reached once a round ran).' },
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
                    live: { type: 'json', description: 'Recent live reviewer-activity entries (newest first).' },
                    updated: { type: 'boolean' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { operation: args.operation, error: resolved.reason };
            const projectRoot = resolved.root;
            const file = transcriptPath(projectRoot);
            const { config } = loadEffectiveConfig(projectRoot);
            const approval = config.observatory?.approval ?? 'ask';
            if (args.operation === 'read') {
                const live = await readLive(projectRoot);
                if (!existsSync(file)) {
                    return {
                        operation: 'read',
                        found: false,
                        live: live,
                        transcript: new ReviewTranscriptBuilder({
                            project: projectRoot,
                            approval,
                        }).serialize(),
                    };
                }
                try {
                    const raw = await readFile(file, 'utf-8');
                    const parsed = JSON.parse(raw);
                    return {
                        operation: 'read',
                        found: true,
                        live: live,
                        transcript: parsed,
                    };
                }
                catch (err) {
                    return {
                        operation: 'read',
                        found: false,
                        error: `Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`,
                    };
                }
            }
            if (args.operation === 'nudge') {
                let manifest = null;
                if (existsSync(file)) {
                    try {
                        const parsed = JSON.parse(await readFile(file, 'utf-8'));
                        manifest = parsed;
                    }
                    catch {
                        manifest = null;
                    }
                }
                // Rehydrating a parsed-but-malformed manifest (e.g. `rounds: [null]`
                // or a non-object) must never crash the nudge — degrade to a fresh
                // builder so the steering text still lands. The fallback must keep
                // the ORIGINAL run identity (mode/taskMode/goal/maxRounds) so a
                // stray malformed field can never silently rewrite a dry-run run
                // into a `normal` one.
                const fallbackOpts = {
                    project: projectRoot,
                    mode: (manifest?.mode === 'dry-run' || manifest?.mode === 'normal' ? manifest.mode : null),
                    taskMode: (manifest?.taskMode === 'code' || manifest?.taskMode === 'iterate' ? manifest.taskMode : null),
                    approval,
                    goal: typeof manifest?.goal === 'string' ? manifest.goal : '',
                    maxRounds: typeof manifest?.maxRounds === 'number' ? manifest.maxRounds : 0,
                };
                let builder;
                if (manifest) {
                    try {
                        builder = rehydrateBuilder(manifest, approval);
                    }
                    catch {
                        builder = new ReviewTranscriptBuilder(fallbackOpts);
                    }
                }
                else {
                    builder = new ReviewTranscriptBuilder({ project: projectRoot, mode: 'normal', approval });
                }
                builder.setNudge(typeof args.text === 'string' && args.text.trim() ? args.text : null);
                const persisted = await persistChecked(file, builder.serialize());
                if (!persisted.ok) {
                    return { operation: 'nudge', updated: false, error: persisted.error };
                }
                return {
                    operation: 'nudge',
                    updated: true,
                    transcript: builder.serialize(),
                };
            }
            // capture
            const mode = args.mode === 'normal' ? 'normal' : 'dry-run';
            const taskMode = args.taskMode === 'code' || args.taskMode === 'iterate' ? args.taskMode : undefined;
            const goal = typeof args.goal === 'string' ? args.goal : '';
            const maxRounds = typeof args.maxRounds === 'number' ? Math.floor(args.maxRounds) : 0;
            const builder = new ReviewTranscriptBuilder({ project: projectRoot, mode, taskMode, approval, goal, maxRounds });
            const report = args.report;
            const reportFindings = report && typeof report === 'object' && Array.isArray(report.findings)
                ? report.findings
                : [];
            const convergence = Array.isArray(args.findingsByRound) ? args.findingsByRound
                : report && typeof report === 'object' && report.convergence
                    ? report.convergence.findingsByRound ?? []
                    : [];
            const rounds = Array.isArray(args.rounds) ? args.rounds : [];
            for (const r of rounds)
                captureRound(builder, r);
            if (rounds.length === 0) {
                // No pre-grouped rounds: fall back to the report's flattened findings.
                const readFiles = Array.isArray(args.refReadFiles) ? args.refReadFiles : [];
                const byDim = new Map();
                for (const f of reportFindings) {
                    if (!f || typeof f !== 'object')
                        continue;
                    const rec = f;
                    const dim = typeof rec.dimension === 'string' && rec.dimension ? rec.dimension : 'review';
                    const list = byDim.get(dim) ?? [];
                    list.push(f);
                    byDim.set(dim, list);
                }
                for (const [dim, list] of byDim)
                    builder.reviewerSnapshot(dim, list, readFiles);
            }
            // Convergence series from the report (position per round).
            for (let i = 0; i < convergence.length; i += 1) {
                const n = convergence[i];
                if (typeof n === 'number')
                    builder.snapshotConvergence(i + 1, n);
            }
            const roundsExecuted = typeof args.roundsExecuted === 'number' ? Math.floor(args.roundsExecuted) : rounds.length;
            if (roundsExecuted > 0)
                builder.roundStart(roundsExecuted, maxRounds);
            builder.recordCheckpoint(normalizeCheckpoint(args.checkpoint));
            if (Array.isArray(args.fixes)) {
                for (const fx of args.fixes) {
                    const record = normalizeFix(fx);
                    if (record)
                        builder.fix(record);
                }
            }
            // End state: an explicit stoppedReason wins; otherwise derive it from
            // the trend. A run that settled closes as "converged"; a run that did
            // real work but never trended to 0 closes as "max_rounds_reached";
            // a capture with no rounds stays "active" (nothing recorded yet).
            const explicitReason = typeof args.stoppedReason === 'string' && args.stoppedReason.trim()
                ? args.stoppedReason.trim()
                : '';
            const last = convergence[convergence.length - 1];
            if (explicitReason)
                builder.finish(explicitReason);
            else if (convergence.length > 0 && last === 0)
                builder.finish('converged');
            else if (roundsExecuted > 0)
                builder.finish('max_rounds_reached');
            const persisted = await persistChecked(file, builder.serialize());
            if (!persisted.ok) {
                return { operation: 'capture', found: true, updated: false, error: persisted.error };
            }
            const live = await readLive(projectRoot);
            return {
                operation: 'capture',
                found: true,
                updated: true,
                live: live,
                transcript: builder.serialize(),
            };
        },
    }));
}
/** Rebuild a builder from a persisted manifest so nudge edits preserve history. */
function rehydrateBuilder(manifest, approval) {
    const builder = new ReviewTranscriptBuilder({
        project: manifest.project,
        mode: manifest.mode ?? null,
        taskMode: manifest.taskMode ?? null,
        approval,
        goal: manifest.goal,
        maxRounds: manifest.maxRounds,
    });
    for (const r of Array.isArray(manifest.rounds) ? manifest.rounds : []) {
        // A malformed/null round row must be skipped, never a throw (the caller
        // wraps rehydrate in a fallback, but preserving sibling rows is better).
        if (!r || typeof r !== 'object')
            continue;
        builder.roundStart(r.round, manifest.maxRounds);
        for (const t of Array.isArray(r.threads) ? r.threads : []) {
            // restoreThread (not reviewerStart + reviewerMessage(join)) preserves the
            // message ARRAY boundaries and the thread's own dimension: rehydration
            // previously collapsed each thread's messages into one string and, once a
            // round hit the per-round thread cap, silently DROPPED the extra threads
            // / mis-merged their findings into the previous dimension's thread.
            builder.restoreThread(r.round, {
                dimension: t.dimension,
                attempt: t.attempt,
                messages: t.messages,
                readFiles: t.readFiles,
                findings: t.findings,
            });
        }
    }
    for (let idx = 0; idx < (manifest.convergence ?? []).length; idx += 1) {
        const n = manifest.convergence[idx];
        if (typeof n === 'number' && n >= 0)
            builder.snapshotConvergence(idx + 1, n);
    }
    if (manifest.checkpoint)
        builder.recordCheckpoint(manifest.checkpoint);
    if (Array.isArray(manifest.fixes))
        for (const fx of manifest.fixes)
            builder.fix(fx);
    if (Array.isArray(manifest.timeline))
        for (const e of manifest.timeline)
            builder.decision(e);
    builder.setNudge(manifest.nudge?.text ?? null);
    if (!manifest.active)
        builder.finish(manifest.stoppedReason ?? undefined);
    return builder;
}
/** Atomically persist a manifest (unique temp + rename) under `.iterate/`. */
async function persist(file, manifest) {
    await mkdir(dirname(file), { recursive: true });
    await writeTextAtomicAsync(file, JSON.stringify(manifest, null, 2));
}
/** persist wrapped with a structured error channel so disk failures surface
 *  as a structured tool result instead of rejecting the whole execute (matches
 *  every other write path in this codebase). */
async function persistChecked(file, manifest) {
    try {
        await persist(file, manifest);
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: `failed to persist transcript: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/**
 * Mark one applied fix as rolled back in the PERSISTED transcript, so the
 * client observatory (F4 fix/rollback tab) reflects the reversal instead of
 * showing the fix as still "成功" after a rollback.
 *
 * Best-effort and fail-safe: a missing/corrupt transcript is ignored, and a
 * persistence failure never throws into the caller (rollback itself is the
 * primary operation; the transcript is a secondary UI projection).
 *
 * @returns true when a transcript existed and was updated.
 */
export async function markFixRolledBackInTranscript(projectRoot, id) {
    const file = transcriptPath(projectRoot);
    if (!existsSync(file))
        return false;
    try {
        const parsed = JSON.parse(await readFile(file, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.fixes))
            return false;
        const { config } = loadEffectiveConfig(projectRoot);
        const approval = config.observatory?.approval ?? 'ask';
        const builder = rehydrateBuilder(parsed, approval);
        builder.markFixRolledBack(id);
        await persist(file, builder.serialize());
        return true;
    }
    catch {
        // Never let the secondary transcript write break the rollback flow.
        return false;
    }
}
