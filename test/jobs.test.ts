import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithJob } from '../src/jobs.ts'

/** Minimal ctx with a fake `jobs` registry recording starts + outcomes. */
function fakeJobs() {
  const started: { kind: string; label: string; done: Promise<unknown> }[] = []
  return {
    registry: {
      start(spec: { kind: string; label: string; run(): { done: Promise<unknown> } }) {
        started.push({ kind: spec.kind, label: spec.label, done: spec.run().done })
        return `job-${started.length}`
      },
    },
    started,
  }
}

test('runWithJob: no jobs service -> fn runs untouched, jobId null', async () => {
  const seen: string[] = []
  const { result, jobId } = await runWithJob({}, 'iterate-review', 'label', async () => {
    seen.push('ran')
    return { ok: true }
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(jobId, null)
  assert.deepEqual(seen, ['ran'])
})

test('runWithJob: jobs.start throws -> fn runs untouched, jobId null', async () => {
  const ctx = {
    jobs: {
      start() {
        throw new Error('background jobs unavailable: no job controller serves this agent')
      },
    },
  }
  const { result, jobId } = await runWithJob(ctx, 'iterate-fix', 'label', () => ({ ok: true }))
  assert.deepEqual(result, { ok: true })
  assert.equal(jobId, null)
})

test('runWithJob: a throwing jobs.start GETTER degrades to no-jobs instead of escaping', async () => {
  // The defensive `typeof jobs.start` read used to happen OUTSIDE the try —
  // a Proxy whose `start` getter throws escaped runWithJob entirely instead
  // of degrading to plain execution like every other registry failure.
  const ctx = {
    get jobs() {
      return {
        get start() {
          throw new Error('no job registry attached')
        },
      }
    },
  }
  const { result, jobId } = await runWithJob(ctx, 'iterate-review', 'label', () => ({ ok: true }))
  assert.deepEqual(result, { ok: true })
  assert.equal(jobId, null)
})

test('runWithJob: success settles the job completed and returns its id', async () => {
  const { registry, started } = fakeJobs()
  const { result, jobId } = await runWithJob({ jobs: registry }, 'iterate-review', 'iterate_review plan (dry-run)', () => ({
    operation: 'plan',
    found: true,
  }))
  assert.deepEqual(result, { operation: 'plan', found: true })
  assert.equal(jobId, 'job-1')
  assert.equal(started.length, 1)
  assert.equal(started[0]!.kind, 'iterate-review')
  assert.equal(started[0]!.label, 'iterate_review plan (dry-run)')
  assert.deepEqual(await started[0]!.done, { status: 'completed', detail: 'done' })
})

test('runWithJob: failure settles the job failed and rethrows', async () => {
  const { registry, started } = fakeJobs()
  const error = new Error('boom')
  await assert.rejects(
    runWithJob({ jobs: registry }, 'iterate-fix', 'iterate_fix src/a.ts', async () => {
      throw error
    }),
    /boom/,
  )
  assert.equal(started.length, 1)
  assert.deepEqual(await started[0]!.done, { status: 'failed', detail: 'boom' })
})

test('runWithJob: cancel records the request but the record settles with the TRUE outcome', async () => {
  // JobHooks requires a `cancel`, but the wrapped tool fn has no abort
  // channel — settling `killed` while fn() keeps running would be a lie in
  // the Job Panel. The honest contract: cancel marks the request (idempotent,
  // first reason wins), the progress line hints at it, and the record settles
  // only when fn actually finishes, carrying fn's real outcome + the request.
  let capturedCancel: ((reason?: string) => void) | undefined
  let internalDone: Promise<unknown> | undefined
  const progressLines: string[] = []
  const registry = {
    start(spec: { run(job: { updateProgress?(line: string): void }): { done: Promise<unknown>; cancel: (reason?: string) => void } }) {
      const hooks = spec.run({ updateProgress: (line: string) => { progressLines.push(line) } })
      capturedCancel = hooks.cancel
      internalDone = hooks.done
      return 'job-1'
    },
  }
  // Keep `fn` pending until the gate releases, so cancel() can be invoked
  // BEFORE runWithJob settles the job.
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const runPromise = runWithJob({ jobs: registry }, 'iterate-review', 'label', async () => {
    await gate
    return { ok: true }
  })
  // jobs.start() runs synchronously inside runWithJob, so the hooks are
  // captured by now.
  assert.equal(typeof capturedCancel, 'function')
  capturedCancel!('panel kill')
  // Second cancel must be idempotent (first reason wins).
  capturedCancel!('second kill ignored')

  // The record must NOT be terminal while fn() is still running.
  const raced = await Promise.race([
    internalDone!.then(() => 'settled' as const),
    new Promise((r) => setTimeout(() => r('pending' as const), 50)),
  ])
  assert.equal(raced, 'pending')

  release()
  const { result } = await runPromise
  assert.deepEqual(result, { ok: true })
  // fn completed → the record says completed (not killed), with the request
  // annotated so the panel explains why a "kill" didn't stop anything.
  const outcome = (await internalDone) as { status: string; detail?: string }
  assert.equal(outcome.status, 'completed')
  assert.match(String(outcome.detail), /cancel requested/)
  assert.match(String(outcome.detail), /panel kill/)
  assert.doesNotMatch(String(outcome.detail), /second kill ignored/)
  // Best-effort progress hint surfaced while stopping.
  assert.ok(progressLines.some((l) => /cancel requested/.test(l)))
})

test('runWithJob: a cancel requested AFTER settlement is a no-op', async () => {
  let ctxCancel: ((reason?: string) => void) | undefined
  let done: Promise<unknown> | undefined
  const ctx = {
    jobs: {
      start(spec: {
        kind: string
        label: string
        run(): { done: Promise<unknown>; cancel: (reason?: string) => void }
      }) {
        const hooks = spec.run()
        ctxCancel = hooks.cancel
        done = hooks.done
        return 'job-1'
      },
    },
  }
  const { result } = await runWithJob(ctx, 'iterate-fix', 'label', () => ({ ok: true }))
  assert.deepEqual(result, { ok: true })
  // The job already settled 'completed'; a late cancel must not rewrite it.
  ctxCancel!('too late')
  assert.deepEqual(await done, { status: 'completed', detail: 'done' })
})
