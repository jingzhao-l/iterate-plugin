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
 *   detect both (including a throwing `start` GETTER) and fall through to
 *   plain execution, so the Job Panel is a pure enhancement and never breaks
 *   a tool call.
 * - The registry is memory-only and panel rows are read-only (no progress
 *   updates), so these jobs are completion records, not control channels.
 * - Cancellation is honest, not theatrical. `JobHooks.cancel` is REQUIRED by
 *   `@deepseek-ai/dsh-jobs` (the registry calls it on kill/teardown), but the
 *   wrapped tool `fn` exposes no abort channel — a panel kill cannot stop it.
 *   So `cancel` records the REQUEST (synchronous + idempotent, first reason
 *   wins), best-effort surfaces it on the record's progress line, and lets the
 *   job settle with `fn`'s TRUE outcome, with the request annotated in
 *   `detail`. Settling the record `killed` while `fn()` keeps running would
 *   show a stopped job that is still running — a lie in the Job Panel.
 */

import type { JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'

/** Extend dsh's producer-kind registry with iterate's custom kinds. */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'iterate-review': 'iterate-review'
    'iterate-fix': 'iterate-fix'
  }
}

/** Custom job kinds this plugin registers. */
export type IterateJobKind = 'iterate-review' | 'iterate-fix'

/** The `JobHandle` surface we use (the registry passes the real one). */
interface JobHandleLike {
  updateProgress?(line: string): void
}

/** Shape of the `ctx.jobs` surface we rely on (duck-typed for safety). */
interface JobsLike {
  start(spec: {
    kind: IterateJobKind
    label: string
    // `cancel` mirrors JobHooks: required, synchronous, idempotent.
    run(job: JobHandleLike): { done: Promise<JobOutcome>; cancel: (reason?: string) => void }
  }): string
}

/**
 * Read `ctx.jobs` defensively: the dsh plugin context can be a Proxy whose
 * `jobs` getter throws (or is missing) when no job registry is present. A
 * Proxy throw on property access must degrade to "no jobs", never crash the
 * tool execution we are about to wrap.
 */
function safeJobs(ctx: unknown): JobsLike | undefined {
  try {
    return (ctx as { jobs?: JobsLike } | undefined)?.jobs
  } catch {
    return undefined
  }
}

/**
 * Read `jobs.start` defensively: the `start` GETTER itself can throw on a
 * hostile/proxied registry, and that read must degrade the same way as a
 * missing registry — never escape `runWithJob`.
 */
function safeStart(jobs: JobsLike | undefined): JobsLike['start'] | undefined {
  try {
    return jobs?.start
  } catch {
    return undefined
  }
}

/**
 * Run `fn` wrapped in a dsh background job, settling it completed/failed
 * with the execution's ACTUAL outcome (a requested cancel never falsifies it
 * — see the header). When the host exposes no job registry (or refuses the
 * start), `fn` runs untouched and `null` is returned — the Job Panel is an
 * enhancement, never a dependency.
 *
 * @param ctx      the dsh plugin context (may or may not expose `jobs`).
 * @param kind     iterate job kind registered via {@link IterateJobKind}.
 * @param label    one-line job label shown in the panel.
 * @param fn       the tool execution to track.
 * @returns the registry-issued job id, or `null` when unavailable.
 */
export async function runWithJob<T>(
  ctx: unknown,
  kind: IterateJobKind,
  label: string,
  fn: () => Promise<T> | T,
): Promise<{ result: T; jobId: string | null }> {
  const jobs = safeJobs(ctx)
  const start = safeStart(jobs)
  if (!jobs || !start || typeof start !== 'function') {
    return { result: await fn(), jobId: null }
  }

  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve
  })

  // Honest cancel bookkeeping: the request is recorded (first reason wins),
  // but `done` is NOT settled here — `fn()` is still running and the panel
  // must not claim otherwise. The settlement below carries `fn`'s real
  // outcome, annotated with the request.
  let cancelRequested: string | null = null
  const annotate = (detail: string): string =>
    cancelRequested === null
      ? detail
      : `${detail} (cancel requested: ${cancelRequested} — the wrapped tool call has no abort channel and ran to completion)`

  let jobId: string | null = null
  try {
    jobId = start.call(jobs, {
      kind,
      label,
      run: (job: JobHandleLike) => ({
        done,
        cancel: (reason?: string) => {
          if (cancelRequested !== null) return // idempotent — first reason wins
          cancelRequested = reason ?? 'cancel requested'
          // Best-effort panel hint while the record is stopping; the registry
          // drops writes it cannot apply, and a throwing update must not
          // propagate out of the registry's kill path.
          try {
            job?.updateProgress?.('cancel requested — waiting for the tool call to finish (no abort channel)')
          } catch {
            /* progress hint is cosmetic */
          }
        },
      }),
    })
  } catch {
    // Registry present but refuses work (e.g. no controller serves this
    // owner) — run without panel tracking.
    return { result: await fn(), jobId: null }
  }

  try {
    const result = await fn()
    settle({ status: 'completed', detail: annotate('done') })
    return { result, jobId }
  } catch (error) {
    settle({
      status: 'failed',
      detail: annotate(error instanceof Error ? error.message : 'execution failed'),
    })
    throw error
  }
}
