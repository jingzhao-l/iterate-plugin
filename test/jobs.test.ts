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

test('runWithJob: cancel hook settles the job killed', async () => {
  let capturedCancel: (() => void) | undefined
  let settleResolve: ((o: unknown) => void) | undefined
  const done = new Promise((resolve) => {
    settleResolve = resolve
  })
  const registry = {
    start(spec: { run(): { done: Promise<unknown>; cancel: () => void } }) {
      const hooks = spec.run()
      capturedCancel = hooks.cancel
      return 'job-1'
    },
  }
  const { result } = await runWithJob({ jobs: registry }, 'iterate-review', 'label', async () => ({ ok: true }))
  assert.deepEqual(result, { ok: true })
  assert.equal(typeof capturedCancel, 'function')
  capturedCancel!()
  assert.deepEqual(await done, { status: 'killed', detail: 'cancelled' })
})
