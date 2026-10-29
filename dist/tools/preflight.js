/**
 * src/tools/preflight.ts — `iterate_preflight` tool.
 *
 * Answers one question BEFORE a run starts: "is this project ready to iterate
 * safely, and what must be fixed first?" It reads only local state (config,
 * git, persisted artifacts, checkpoint) and returns a structured checklist the
 * observatory renders as a preflight panel (F11).
 *
 * Why it exists: the most expensive failure mode is starting a run that cannot
 * prove anything — an empty `validation.commands` means the loop has no way to
 * tell a fix from a regression, and a stale FAIL certificate or a leftover
 * interrupted checkpoint makes the first round lie about its starting state.
 * Preflight surfaces those conditions before the model spends a round
 * discovering them mid-flight.
 *
 * Read-only: never mutates config, files, or artifacts.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRootForExec, loadEffectiveConfig, flattenCommands } from "../config-loader.js";
import { runGit } from "../git-scope.js";
import { readQualityGate } from "./quality-store.js";
import { readCheckpoint, computeStatus } from "./checkpoint.js";
import { readDecisionEntries } from "./decision-log.js";
import { readRegistry } from "./fix.js";
import { resultHeadline } from "./present.js";
/**
 * Build the readiness checklist from already-gathered facts (pure).
 *
 * The five checks and why each exists:
 *   1. `validation`            — empty command set ⇒ the loop cannot prove a
 *                                fix; the product is fail-closed here, so this
 *                                is a BLOCKING `fail`, not a warning.
 *   2. `git`                   — changed-only scope + `iterate_diff` need a
 *                                repository; full-scope review still works, so
 *                                absent is a `warn`.
 *   3. `dirty-tree`            — a run over uncommitted work mixes the user's
 *                                WIP with the plugin's fixes; advisory `warn`.
 *                                Unknown (null) is treated as pass so a git
 *                                hiccup never fabricates a warning.
 *   4. `stale-gate`            — a persisted FAIL certificate makes the first
 *                                round read stale; `warn` + clear before a
 *                                fresh run.
 *   5. `interrupted-checkpoint`— a leftover checkpoint from a run that never
 *                                progressed; `warn` + resume or clear.
 */
export function buildPreflightReport(input) {
    const checks = [
        {
            id: 'validation',
            status: input.validationCommandCount > 0 ? 'pass' : 'fail',
            detail: { commandCount: input.validationCommandCount },
        },
        {
            id: 'git',
            status: input.isGitRepo ? 'pass' : 'warn',
            detail: { isRepo: input.isGitRepo },
        },
        {
            id: 'dirty-tree',
            status: input.changedFiles !== null && input.changedFiles > 0 ? 'warn' : 'pass',
            detail: { changedFiles: input.changedFiles },
        },
        {
            id: 'stale-gate',
            status: input.gateOverallStatus === 'fail' ? 'warn' : 'pass',
            detail: { overallStatus: input.gateOverallStatus },
        },
        {
            id: 'interrupted-checkpoint',
            status: input.interrupted ? 'warn' : 'pass',
            detail: { interrupted: input.interrupted, resumeCount: input.resumeCount },
        },
    ];
    const blocking = checks.filter((c) => c.status === 'fail').length;
    const warnings = checks.filter((c) => c.status === 'warn').length;
    return { ok: true, ready: blocking === 0, blocking, warnings, checks };
}
/** Human-readable (English, for the model-facing render) description per check. */
function describeCheck(id, detail) {
    switch (id) {
        case 'validation': {
            const n = Number(detail.commandCount ?? 0);
            return n > 0
                ? `${n} validation command(s) configured`
                : 'no validation.commands configured — the run cannot prove fixes (blocking)';
        }
        case 'git':
            return detail.isRepo === true
                ? 'git repository detected'
                : 'not a git repository — changed-only scope and iterate_diff need one';
        case 'dirty-tree': {
            const n = detail.changedFiles;
            if (n === null || n === undefined)
                return 'uncommitted changes: unknown';
            const num = Number(n);
            return num > 0
                ? `${num} uncommitted/untracked file(s) — commit or stash before a run`
                : 'working tree clean';
        }
        case 'stale-gate': {
            const s = detail.overallStatus;
            if (s === 'fail')
                return 'a stale FAIL quality gate is persisted — clear it before a fresh run';
            return s ? `quality gate: ${String(s)}` : 'no persisted quality gate';
        }
        case 'interrupted-checkpoint': {
            if (detail.interrupted === true) {
                const rc = Number(detail.resumeCount ?? 0);
                return `an interrupted checkpoint is waiting (resumed ${rc}x) — resume or clear it`;
            }
            return 'no interrupted checkpoint';
        }
        default:
            return '';
    }
}
/**
 * Register the `iterate_preflight` tool.
 */
export function registerPreflightTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_preflight',
        // Pure read of on-disk state + git → safe to join a parallel group.
        isConcurrencySafe: () => true,
        presentResult: (_args, result) => {
            const title = resultHeadline(result);
            return title ? { card: 'generic', title } : undefined;
        },
        description: 'Read-only readiness check to run BEFORE starting an iterate run. Returns a checklist: whether ' +
            'validation.commands is configured (an empty set means the loop cannot prove fixes — blocking), ' +
            'whether the project is a git repository, how many files are uncommitted, whether a stale FAIL ' +
            'quality gate is persisted, and whether an interrupted checkpoint is waiting. Use it before a fresh ' +
            'run so you fix the environment first instead of discovering it mid-round.',
        parameters: {
            path: { type: 'string', description: 'Project root directory (default: current working directory).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    ready: { type: 'boolean' },
                    blocking: { type: 'integer' },
                    warnings: { type: 'integer' },
                    checks: { type: 'json', description: 'Per-check outcomes: { id, status: pass|warn|fail, detail }.' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.ok)
                    return [{ type: 'text', text: `preflight failed: ${value.error}` }];
                const checks = Array.isArray(value.checks) ? value.checks : [];
                const warnings = Number(value.warnings ?? 0);
                const noun = warnings === 1 ? 'warning' : 'warnings';
                const head = value.ready
                    ? `Preflight: READY (${Number(value.blocking ?? 0)} blocking, ${warnings} ${noun})`
                    : `Preflight: NOT READY (${Number(value.blocking ?? 0)} blocking, ${warnings} ${noun})`;
                const lines = checks.map((c) => {
                    const check = c;
                    const id = String(check.id ?? '?');
                    const status = String(check.status ?? '?').toUpperCase();
                    return `  ${status} ${id} — ${describeCheck(id, check.detail ?? {})}`;
                });
                return [{ type: 'text', text: [head, ...lines].join('\n') }];
            },
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok) {
                return { ok: false, ready: false, blocking: 0, warnings: 0, checks: [], error: resolved.reason };
            }
            const projectRoot = resolved.root;
            // 1. validation.commands — the load-bearing check.
            let validationCommandCount = 0;
            try {
                const effective = loadEffectiveConfig(projectRoot);
                validationCommandCount = flattenCommands(effective.config.validation?.commands).length;
            }
            catch {
                validationCommandCount = 0;
            }
            // 2/3. git repo + dirty tree (best-effort; any failure degrades to unknown).
            let isGitRepo = false;
            let changedFiles = null;
            try {
                const inside = await runGit(['rev-parse', '--is-inside-work-tree'], projectRoot, { signal: exec.signal });
                isGitRepo = inside.ok && inside.stdout.trim() === 'true';
                if (isGitRepo) {
                    const status = await runGit(['status', '--porcelain', '-z'], projectRoot, { signal: exec.signal });
                    if (status.ok) {
                        // `-z` NUL-terminates each entry; a rename emits two NUL-separated
                        // paths for one entry, but counting non-empty tokens is still a
                        // faithful "there is uncommitted work" signal (>=1 when dirty).
                        changedFiles = status.stdout.split('\u0000').filter((s) => s.length > 0).length;
                    }
                }
            }
            catch {
                isGitRepo = false;
                changedFiles = null;
            }
            // 4. stale quality gate.
            let gateOverallStatus = null;
            try {
                gateOverallStatus = readQualityGate(projectRoot).overallStatus ?? null;
            }
            catch {
                gateOverallStatus = null;
            }
            // 5. interrupted checkpoint (reuse the exact status logic so preflight
            //    and iterate_status can never disagree about "interrupted").
            let interrupted = false;
            let resumeCount = 0;
            try {
                const status = computeStatus({
                    checkpoint: readCheckpoint(projectRoot),
                    decisionEntries: readDecisionEntries(projectRoot),
                    fixRegistry: readRegistry(projectRoot),
                });
                interrupted = status.interrupted;
                resumeCount = status.resumeCount;
            }
            catch {
                interrupted = false;
                resumeCount = 0;
            }
            const report = buildPreflightReport({
                validationCommandCount,
                isGitRepo,
                changedFiles,
                gateOverallStatus,
                interrupted,
                resumeCount,
            });
            return { ...report, checks: report.checks };
        },
    }));
}
