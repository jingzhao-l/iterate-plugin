/**
 * src/jobs.ts — dsh Job Panel integration for iterate tool executions.
 *
 * dsh's background-job registry (`ctx.jobs`, @deepseek-ai/dsh-jobs) lets
 * plugins surface long-running work in the client's Job Panel
 * (`conversation.session.header.actions` list). We register custom kinds via
 * declaration merging and wrap tool executions so each `iterate_review` /
 * `iterate_fix` call shows up as a tracked job (running -> completed/failed).
 *
 * Defensive by design (matches the plugin's overall philosophy):
 * - `ctx.jobs` only exists when the dsh host loaded a job registry + a
 *   controller serves the calling owner (`@deepseek-ai/dsh-tool-jobs` or an
 *   equivalent). When it is missing, `start()` throws or is absent — we
 *   detect both and fall through to plain execution, so the Job Panel is a
 *   pure enhancement and never breaks a tool call.
 * - The registry is memory-only and panel rows are read-only (no progress
 *   updates), so these jobs are completion records, not control channels.
 */
/**
 * Run `fn` wrapped in a dsh background job, settling it completed/failed
 * with the execution's outcome. When the host exposes no job registry (or
 * refuses the start), `fn` runs untouched and `null` is returned — the Job
 * Panel is an enhancement, never a dependency.
 *
 * @param ctx      the dsh plugin context (may or may not expose `jobs`).
 * @param kind     iterate job kind registered via {@link IterateJobKind}.
 * @param label    one-line job label shown in the panel.
 * @param fn       the tool execution to track.
 * @returns the registry-issued job id, or `null` when unavailable.
 */
export async function runWithJob(ctx, kind, label, fn) {
    const jobs = ctx?.jobs;
    if (!jobs || typeof jobs.start !== 'function') {
        return { result: await fn(), jobId: null };
    }
    let settle;
    const done = new Promise((resolve) => {
        settle = resolve;
    });
    let jobId = null;
    try {
        jobId = jobs.start({
            kind,
            label,
            run: () => ({
                done,
                cancel: () => settle({ status: 'killed', detail: 'cancelled' }),
            }),
        });
    }
    catch {
        // Registry present but refuses work (e.g. no controller serves this
        // owner) — run without panel tracking.
        return { result: await fn(), jobId: null };
    }
    try {
        const result = await fn();
        settle({ status: 'completed', detail: 'done' });
        return { result, jobId };
    }
    catch (error) {
        settle({
            status: 'failed',
            detail: error instanceof Error ? error.message : 'execution failed',
        });
        throw error;
    }
}
