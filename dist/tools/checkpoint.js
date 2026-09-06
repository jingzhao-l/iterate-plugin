/**
 * src/tools/checkpoint.ts — iteration checkpoint + status tools.
 *
 *   iterate_checkpoint — save / load / clear a resume checkpoint so a long
 *                        iteration can continue where it left off.
 *   iterate_status     — summarize the current iteration state from the
 *                        decision log, fix registry, and checkpoint.
 *
 * Checkpoint layout: `.iterate/checkpoint.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRootForExec } from "../config-loader.js";
import { checkpointPath, iterateDir, transcriptPath } from "../paths.js";
import { readRegistry } from "./fix.js";
import { readDecisionEntries } from "./decision-log.js";
import { readQualityGate } from "./quality-store.js";
import { readExperienceBank } from "./experience-store.js";
import { readDefenseEvents } from "./defense-store.js";
// ─── Pure helpers (exported for unit tests) ─────────────────────────────────
/** Read the current checkpoint from disk (missing/corrupt → null). */
export function readCheckpoint(projectRoot) {
    const file = checkpointPath(projectRoot);
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        if (parsed.mode !== 'dry-run' && parsed.mode !== 'normal')
            return null;
        if (typeof parsed.round !== 'number')
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** Read the harness task_mode from the persisted observatory transcript (code|iterate|null). */
export function readTranscriptTaskMode(projectRoot) {
    const file = transcriptPath(projectRoot);
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8'));
        const m = parsed && typeof parsed === 'object' ? parsed.taskMode : null;
        return m === 'code' || m === 'iterate' ? m : null;
    }
    catch {
        return null;
    }
}
/** Validate a checkpoint payload (returns error string or null). */
export function validateCheckpoint(input) {
    if (input.mode !== 'dry-run' && input.mode !== 'normal') {
        return 'mode must be "dry-run" or "normal"';
    }
    if (typeof input.round !== 'number' || !Number.isInteger(input.round) || input.round < 0) {
        return 'round must be a non-negative integer';
    }
    if (typeof input.maxRounds !== 'number' || !Number.isInteger(input.maxRounds) || input.maxRounds < 1) {
        return 'maxRounds must be a positive integer';
    }
    if (typeof input.fixedCount !== 'number' || !Number.isInteger(input.fixedCount) || input.fixedCount < 0) {
        return 'fixedCount must be a non-negative integer';
    }
    if (typeof input.architecturalCount !== 'number' || !Number.isInteger(input.architecturalCount) || input.architecturalCount < 0) {
        return 'architecturalCount must be a non-negative integer';
    }
    if (input.resumeCount !== undefined &&
        (typeof input.resumeCount !== 'number' || !Number.isInteger(input.resumeCount) || input.resumeCount < 0)) {
        return 'resumeCount must be a non-negative integer';
    }
    return null;
}
/**
 * Compute a status summary from the runtime artifacts.
 * Pure (no I/O) — all reads are injected, so it is unit-testable.
 */
export function computeStatus(input) {
    const checkpoint = input.checkpoint;
    const taskMode = input.taskMode ?? null;
    const entries = input.decisionEntries;
    const registry = input.fixRegistry;
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastUpdated = lastEntry?.timestamp ?? checkpoint?.updatedAt ?? null;
    // Round = checkpoint.round (explicit) or max round seen in the decision log.
    let currentRound = checkpoint?.round ?? 0;
    if (!checkpoint) {
        for (const e of entries) {
            if (typeof e.round === 'number' && e.round > currentRound)
                currentRound = e.round;
        }
    }
    const totalRounds = checkpoint?.maxRounds ?? currentRound;
    const registryFixed = registry.rounds.reduce((sum, r) => sum + r.fixedCount, 0);
    const failedCount = registry.rounds.reduce((sum, r) => sum + r.failedCount, 0);
    // When a checkpoint exists, its snapshot fields are authoritative for resume
    // (fixedCount / architecturalCount / findings); otherwise derive from the
    // live fix registry and decision log.
    const fixedCount = checkpoint ? checkpoint.fixedCount : registryFixed;
    const architecturalCount = checkpoint?.architecturalCount ?? 0;
    return {
        mode: checkpoint?.mode ?? null,
        taskMode,
        currentRound,
        totalRounds,
        fixedCount,
        architecturalCount,
        // A checkpoint may predate the `findings` field (or be hand-edited) — a
        // missing findings must degrade to 0, never throw.
        findingsCount: Array.isArray(checkpoint?.findings) ? checkpoint.findings.length : 0,
        totalDecisionLogEntries: entries.length,
        hasCheckpoint: checkpoint !== null,
        // A checkpoint left on disk means the previous run was interrupted before
        // it could clear it — this is the durable "interruption" signal.
        interrupted: checkpoint !== null,
        resumeCount: checkpoint?.resumeCount ?? 0,
        checkpoint,
        lastUpdated,
        // v3.0: quality command-center snapshots (present only when the caller
        // supplied a real snapshot — the status never fabricates one that is not
        // on disk, and never emits null for an absent optional field).
        ...(input.qualityGate != null ? { qualityGate: input.qualityGate } : {}),
        ...(input.experienceBank != null ? { experienceBank: input.experienceBank } : {}),
        ...(input.defenseEvents != null ? { defenseEvents: input.defenseEvents } : {}),
    };
}
// ─── iterate_checkpoint ──────────────────────────────────────────────────────
/**
 * Register the `iterate_checkpoint` tool.
 * Saves progress so the orchestrator can resume a long iteration.
 */
export function registerCheckpointTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_checkpoint',
        description: 'Save / load / resume / clear the iteration checkpoint. The workflow saves a checkpoint at the start of ' +
            'each round (so a long run can resume) and clears it when the iteration completes. ' +
            '`resume` loads an existing checkpoint, bumps its resumeCount, and persists it back — ' +
            'call it when continuing an interrupted run so the resume counter stays accurate.',
        parameters: {
            operation: {
                type: 'string',
                required: true,
                description: '"save" to persist the current progress, "load" to read it back, "resume" to load + count a resumption, "clear" to remove it.',
                enum: ['save', 'load', 'resume', 'clear'],
            },
            mode: { type: 'string', description: 'Required for save: "dry-run" or "normal".' },
            round: { type: 'integer', description: 'Required for save: current round number (0 = none started).' },
            maxRounds: { type: 'integer', description: 'Required for save: total round cap.' },
            fixedCount: { type: 'integer', description: 'Required for save: number of fixes applied so far.' },
            architecturalCount: { type: 'integer', description: 'Required for save: architectural findings left unfixed.' },
            resumeCount: { type: 'integer', description: 'Optional for save: how many times this checkpoint has already been resumed after an interruption (default 0).' },
            findings: { type: 'json', description: 'Optional for save: the current deduped findings to resume from.' },
            path: { type: 'string', description: 'Project root directory (default: current working directory).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    operation: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    checkpoint: { type: 'json' },
                    existed: { type: 'boolean' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { operation: args.operation, ok: false, error: resolved.reason };
            const projectRoot = resolved.root;
            if (args.operation === 'load') {
                const checkpoint = readCheckpoint(projectRoot);
                return { operation: 'load', ok: true, checkpoint: checkpoint };
            }
            if (args.operation === 'resume') {
                const current = readCheckpoint(projectRoot);
                if (!current) {
                    return { operation: 'resume', ok: false, error: 'no checkpoint to resume — run `save` first' };
                }
                const resumed = {
                    ...current,
                    resumeCount: (current.resumeCount ?? 0) + 1,
                    updatedAt: new Date().toISOString(),
                };
                try {
                    mkdirSync(iterateDir(projectRoot), { recursive: true });
                    const cpPath = checkpointPath(projectRoot);
                    const tmpPath = `${cpPath}.tmp-${Date.now()}`;
                    writeFileSync(tmpPath, JSON.stringify(resumed, null, 2), 'utf-8');
                    renameSync(tmpPath, cpPath);
                }
                catch (err) {
                    return { operation: 'resume', ok: false, error: `failed to persist resumed checkpoint: ${String(err)}` };
                }
                return { operation: 'resume', ok: true, checkpoint: resumed };
            }
            if (args.operation === 'clear') {
                const existed = existsSync(checkpointPath(projectRoot));
                if (existed) {
                    try {
                        rmSync(checkpointPath(projectRoot), { force: true });
                    }
                    catch (err) {
                        return { operation: 'clear', ok: false, existed, error: `failed to clear checkpoint: ${String(err)}` };
                    }
                }
                return { operation: 'clear', ok: true, existed };
            }
            if (args.operation === 'save') {
                const invalid = validateCheckpoint({
                    mode: args.mode,
                    round: args.round,
                    maxRounds: args.maxRounds,
                    fixedCount: args.fixedCount,
                    architecturalCount: args.architecturalCount,
                    resumeCount: args.resumeCount,
                });
                if (invalid)
                    return { operation: 'save', ok: false, error: invalid };
                const checkpoint = {
                    mode: args.mode,
                    round: args.round,
                    maxRounds: args.maxRounds,
                    fixedCount: args.fixedCount,
                    architecturalCount: args.architecturalCount,
                    resumeCount: (typeof args.resumeCount === 'number' ? args.resumeCount : 0),
                    findings: (Array.isArray(args.findings) ? args.findings : []),
                    startedAt: readCheckpoint(projectRoot)?.startedAt ?? new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                try {
                    mkdirSync(iterateDir(projectRoot), { recursive: true });
                    // Atomic write (temp + rename): a crash mid-write must not corrupt
                    // the checkpoint and silently lose the interruption state.
                    const cpPath = checkpointPath(projectRoot);
                    const tmpPath = `${cpPath}.tmp-${Date.now()}`;
                    writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
                    renameSync(tmpPath, cpPath);
                }
                catch (err) {
                    return { operation: 'save', ok: false, error: `failed to write checkpoint: ${String(err)}` };
                }
                return { operation: 'save', ok: true, checkpoint: checkpoint };
            }
            return { operation: args.operation, ok: false, error: 'unknown operation. Use "save", "load", "resume", or "clear".' };
        },
    }));
}
// ─── iterate_status ──────────────────────────────────────────────────────────
/**
 * Register the `iterate_status` tool.
 * Summarizes the current iteration state (mode, round, fixed count, findings).
 */
export function registerStatusTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_status',
        description: 'Summarize the current iterate run: mode, current round vs total, fixes applied, architectural ' +
            'findings remaining, decision-log size, and whether a resume checkpoint exists.',
        parameters: {
            path: { type: 'string', description: 'Project root directory (default: current working directory).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    mode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    taskMode: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Harness execution mode from the observatory transcript ("code" | "iterate").' },
                    currentRound: { type: 'integer' },
                    totalRounds: { type: 'integer' },
                    fixedCount: { type: 'integer' },
                    architecturalCount: { type: 'integer' },
                    findingsCount: { type: 'integer' },
                    totalDecisionLogEntries: { type: 'integer' },
                    hasCheckpoint: { type: 'boolean' },
                    interrupted: { type: 'boolean', description: 'True when a checkpoint exists, meaning the previous run was interrupted before finishing.' },
                    resumeCount: { type: 'integer', description: 'How many times the current checkpoint has already been resumed.' },
                    lastUpdated: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    qualityGate: { type: 'json', description: 'v3.0: persisted quality-gate snapshot (.iterate/quality-gate.json), when present.' },
                    experienceBank: { type: 'json', description: 'v3.0: experience bank summary (.iterate/experience.json), when present.' },
                    defenseEvents: { type: 'json', description: 'v3.0: defense events summary (.iterate/defense-events.json), when present.' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.ok)
                    return [{ type: 'text', text: `status failed: ${value.error}` }];
                const lines = [
                    `Mode: ${value.mode ?? 'none'}${value.taskMode ? ` (${value.taskMode})` : ''}`,
                    `Round: ${value.currentRound} / ${value.totalRounds}`,
                    `Fixed: ${value.fixedCount} · Architectural remaining: ${value.architecturalCount}`,
                    `Findings in checkpoint: ${value.findingsCount}`,
                    `Decision-log entries: ${value.totalDecisionLogEntries}`,
                    `Checkpoint: ${value.hasCheckpoint ? 'yes' : 'no'}${value.interrupted ? ' (interrupted — resumable)' : ''}${value.resumeCount ? ` · resumed ${value.resumeCount}x` : ''}`,
                    value.lastUpdated ? `Last updated: ${value.lastUpdated}` : '',
                ];
                return [{ type: 'text', text: lines.filter(Boolean).join('\n') }];
            },
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { ok: false, error: resolved.reason };
            const projectRoot = resolved.root;
            // v3.0: surface the persisted quality command-center snapshots so a
            // single `iterate_status` call reports the whole run state — the gate,
            // the experience bank, and the defense event stream. Each read is
            // defensive (missing/malformed files yield an empty snapshot), so the
            // status never crashes on absent artifacts.
            const qualityGate = readQualityGate(projectRoot);
            const experienceBank = readExperienceBank(projectRoot);
            const defenseEvents = readDefenseEvents(projectRoot);
            const status = computeStatus({
                checkpoint: readCheckpoint(projectRoot),
                taskMode: readTranscriptTaskMode(projectRoot),
                decisionEntries: readDecisionEntries(projectRoot),
                fixRegistry: readRegistry(projectRoot),
                qualityGate: qualityGate.dimensions.length > 0 || qualityGate.overallStatus === 'pass' || qualityGate.overallStatus === 'fail'
                    ? qualityGate
                    : null,
                experienceBank: {
                    totalEntries: experienceBank.entries.length,
                    totalHits: experienceBank.totalHits ?? 0,
                },
                defenseEvents: {
                    totalEvents: defenseEvents.events.length,
                    counts: defenseEvents.counts,
                },
            });
            return {
                ok: true,
                mode: status.mode ?? null,
                taskMode: status.taskMode ?? null,
                currentRound: status.currentRound,
                totalRounds: status.totalRounds,
                fixedCount: status.fixedCount,
                architecturalCount: status.architecturalCount,
                findingsCount: status.findingsCount,
                totalDecisionLogEntries: status.totalDecisionLogEntries,
                hasCheckpoint: status.hasCheckpoint,
                interrupted: status.interrupted,
                resumeCount: status.resumeCount,
                lastUpdated: status.lastUpdated ?? null,
                qualityGate: status.qualityGate ? status.qualityGate : null,
                experienceBank: status.experienceBank ? status.experienceBank : null,
                defenseEvents: status.defenseEvents ? status.defenseEvents : null,
            };
        },
    }));
}
