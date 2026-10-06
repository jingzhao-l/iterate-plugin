import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  acquireLogLock,
  registerDecisionLogTool,
  appendDecisionEntry,
  invalidateLogCountCache,
  readDecisionEntries,
  recountEntries,
  LOG_COUNT_CACHE_CAP,
  logCountCacheSize,
} from '../src/tools/decision-log.ts'
import { writeTextAtomic } from '../src/atomic-fs.ts'

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-decision-log-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function captureDecisionLogTool(): { execute: (args: unknown) => Promise<Record<string, unknown>> } {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerDecisionLogTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_decision_log was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: async (args) => (await def!.execute(args, exec as never)) as Record<string, unknown>,
  }
}

describe('iterate_decision_log execute', () => {
  it('appends and reads an entry back through the tool', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      const appended = await tool.execute({
        operation: 'append',
        type: 'decision',
        round: 2,
        data: { note: 'hello' },
        path: dir,
      })
      assert.equal(appended.operation, 'append')
      assert.equal(appended.error, undefined)
      assert.equal(appended.entryCount, 1)

      // Persisted on disk.
      const entries = readDecisionEntries(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.type, 'decision')
      assert.equal(entries[0]!.round, 2)
      assert.deepEqual(entries[0]!.data, { note: 'hello' })

      // Read back through the tool.
      const read = await tool.execute({ operation: 'read', path: dir })
      assert.equal(read.operation, 'read')
      assert.equal(read.entryCount, 1)
      const list = read.entries as Array<{ type: string; data: Record<string, unknown> }>
      assert.equal(list[0]!.type, 'decision')
      assert.deepEqual(list[0]!.data, { note: 'hello' })
    } finally {
      cleanup()
    }
  })

  it('rejects an append with an unknown entry type', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const tool = captureDecisionLogTool()
      await assert.rejects(
        tool.execute({ operation: 'append', type: 'made_up_type', round: 1, data: {}, path: dir }),
        /must be one of/,
      )
      assert.equal(readDecisionEntries(dir).length, 0)
    } finally {
      cleanup()
    }
  })
})

describe('acquireLogLock', () => {
  it('releases cleanly and never leaves a lock file behind', () => {
    const { dir, cleanup } = tempProject()
    try {
      const release = acquireLogLock(dir)
      const lockPath = join(dir, '.iterate', '.decision-log.lock')
      assert.equal(existsSync(lockPath), true)
      assert.ok(readFileSync(lockPath, 'utf-8').trim().length > 0, 'lock holds the owner pid')
      release()
      assert.equal(existsSync(lockPath), false)
    } finally {
      cleanup()
    }
  })

  it('steals a lock owned by a dead pid immediately (no wait budget burned)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const lockPath = join(dir, '.iterate', '.decision-log.lock')
      writeFileSync(lockPath, '99999999', 'utf-8')
      const t0 = Date.now()
      const release = acquireLogLock(dir, { waitMs: 5000 })
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 1000, `dead-pid steal must not wait, took ${elapsed}ms`)
      // We own it now (our pid is stamped), so release really unlocks.
      assert.equal(readFileSync(lockPath, 'utf-8'), String(process.pid))
      release()
      assert.equal(existsSync(lockPath), false)
    } finally {
      cleanup()
    }
  })

  it('times out fast against a LIVE holder and degrades to a no-op release', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      const lockPath = join(dir, '.iterate', '.decision-log.lock')
      // Our own pid is alive → the lock is a live holder and must never be stolen.
      writeFileSync(lockPath, String(process.pid), 'utf-8')
      const t0 = Date.now()
      const release = acquireLogLock(dir, { waitMs: 150 })
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= 100, `should have waited for the budget, took ${elapsed}ms`)
      assert.ok(elapsed < 3000, `wait must honor waitMs, took ${elapsed}ms`)
      // The no-op release must NOT delete a lock we do not own.
      release()
      assert.equal(existsSync(lockPath), true)
      assert.equal(readFileSync(lockPath, 'utf-8'), String(process.pid))
    } finally {
      cleanup()
    }
  })
})

describe('appendDecisionEntry never throws on a broken filesystem layout (F8)', () => {
  const sample = {
    timestamp: '2026-01-01T00:00:00.000Z',
    round: 1,
    type: 'decision' as const,
    data: { note: 'x' },
  }

  it('reports a structured error when .iterate exists as a REGULAR FILE', () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const res = appendDecisionEntry(dir, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.equal(res.count, 0)
    } finally {
      cleanup()
    }
  })

  it('reports a structured error when the PROJECT ROOT itself is a regular file (mkdir ENOTDIR)', () => {
    const { dir, cleanup } = tempProject()
    try {
      // The real escape hatch: logPath()'s mkdirSync used to run OUTSIDE the
      // try/catch, so an ENOTDIR propagated out of appendDecisionEntry and
      // aborted the caller's whole iterate_fix/iterate_prune invocation.
      const rootAsFile = join(dir, 'root.json')
      writeFileSync(rootAsFile, '', 'utf-8')
      const res = appendDecisionEntry(rootAsFile, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.match(res.error!, /ENOTDIR/)
      assert.equal(res.count, 0)
    } finally {
      cleanup()
    }
  })

  it('reports a structured error when the log path is a DIRECTORY (EISDIR)', () => {
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, '.iterate', 'decision-log.jsonl'), { recursive: true })
      const res = appendDecisionEntry(dir, sample)
      assert.equal(typeof res.error, 'string')
      assert.match(res.error!, /failed to append decision log/)
      assert.match(res.error!, /EISDIR/)
      assert.equal(res.count, 0)
    } finally {
      cleanup()
    }
  })

  it('surfaces the failure through the tool instead of rejecting the call', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const tool = captureDecisionLogTool()
      const out = await tool.execute({
        operation: 'append', type: 'decision', round: 1, data: {}, path: dir,
      })
      assert.equal(out.success, false)
      assert.match(String(out.error), /failed to append decision log/)
    } finally {
      cleanup()
    }
  })
})

describe('recountEntries failure fallback', () => {
  it('returns the cached count (never a fabricated 1) for a path counted before', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = join(dir, '.iterate', 'decision-log.jsonl')
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision', data: { a: 1 } })
      appendDecisionEntry(dir, { timestamp: '2026-01-01T00:00:00.001Z', round: 1, type: 'decision', data: { a: 2 } })
      // Warm the cache to 2, then make the file unreadable by REPLACING it
      // with a directory of the same path.
      rmSync(logFile)
      mkdirSync(logFile)
      const res = recountEntries(logFile)
      assert.equal(res.ok, false)
      assert.equal(res.count, 2, 'fallback is the last known count, not a fabricated 1')
    } finally {
      cleanup()
    }
  })

  it('returns 0 / ok:false for a path that was never counted', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.deepEqual(recountEntries(join(dir, 'never-existed.jsonl')), { count: 0, ok: false })
    } finally {
      cleanup()
    }
  })

  it('a failed read-back does not poison the cache for later appends', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = join(dir, '.iterate', 'decision-log.jsonl')
      const e = (tag: string) => ({ timestamp: new Date().toISOString(), round: 1, type: 'decision' as const, data: { tag } })
      appendDecisionEntry(dir, e('one'))
      appendDecisionEntry(dir, e('two')) // cache warm: {size: S2, count: 2}

      // Append succeeds but the READ-BACK fails: make the file write-only
      // (0222), so appendFileSync lands while readFileSync gets EACCES.
      appendFileSync(logFile, JSON.stringify(e('three')) + '\n', 'utf-8')
      chmodSync(logFile, 0o222)
      const failed = appendDecisionEntry(dir, e('four'))
      assert.equal(failed.error, undefined, 'the append itself landed')
      assert.equal(failed.count, 2, 'reports the last KNOWN count when read-back fails')
      chmodSync(logFile, 0o644)

      // If the failed read had been cached under the post-append byte size,
      // this append would take the size fast-path and report 2 + 1 = 3.
      // The cache must have been left untouched → full recount → the true 5.
      const after = appendDecisionEntry(dir, e('five'))
      assert.equal(after.error, undefined)
      assert.equal(after.count, 5)
      const lines = readFileSync(logFile, 'utf-8').split('\n').filter((l) => l.trim().length > 0)
      assert.equal(lines.length, 5)
    } finally {
      cleanup()
    }
  })
})

describe('appendDecisionEntry entry-count cache', () => {
  it('invalidates the cached count after a same-size rewrite so appends stay accurate', () => {
    const { dir, cleanup } = tempProject()
    try {
      const logFile = join(dir, '.iterate', 'decision-log.jsonl')

      // Append one entry and let the cache warm (count=1).
      const first = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.000Z',
        round: 1,
        type: 'decision',
        data: { a: 'first' },
      })
      assert.equal(first.error, undefined)
      assert.equal(first.count, 1)
      const sizeAfterFirst = statSync(logFile).size

      // Rewrite the log to a DIFFERENT number of entries with the EXACT same
      // total byte size (the cache's "same size ⇒ same count" assumption).
      const secondLine = '{"round":1,"type":"decision","data":{"b":"second"}}'
      // Pad one valid JSON object with whitespace so total length matches.
      const target = sizeAfterFirst - Buffer.byteLength(secondLine) - 2 // minus the \n separators
      const padLead = '{"d":"'
      const padTail = '"}'
      const spaces = Math.max(0, target - Buffer.byteLength(padLead) - Buffer.byteLength(padTail))
      const padded = padLead + ' '.repeat(spaces) + padTail
      const rewritten = padded + '\n' + secondLine + '\n'
      assert.equal(Buffer.byteLength(rewritten), sizeAfterFirst)
      writeTextAtomic(logFile, rewritten)

      // Without invalidation the next append would report 1 + 1 = 2 (stale);
      // the invalidated path recounts and reports the true 2 + 1 = 3.
      invalidateLogCountCache(logFile)
      const second = appendDecisionEntry(dir, {
        timestamp: '2026-01-01T00:00:00.001Z',
        round: 2,
        type: 'decision',
        data: { c: 'third' },
      })
      assert.equal(second.error, undefined)
      assert.equal(second.count, 3)
      // The `count` reflects the full on-disk file: 2 rewritten lines + 1 append.
      const nonEmptyLines = readFileSync(logFile, 'utf-8').split('\n').filter((l) => l.trim().length > 0).length
      assert.equal(nonEmptyLines, 3)
    } finally {
      cleanup()
    }
  })
})
describe('entry-count cache capacity (minor 3)', () => {
  it('never grows past LOG_COUNT_CACHE_CAP across many project roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'iterate-decision-log-cache-'))
    try {
      const e = { timestamp: '2026-01-01T00:00:00.000Z', round: 1, type: 'decision' as const, data: {} }
      const roots: string[] = []
      // CAP + 8 distinct log paths: without a capacity bound this Map grew
      // one entry per project, forever (a long-lived process never forgot).
      for (let i = 0; i < LOG_COUNT_CACHE_CAP + 8; i += 1) {
        const root = join(base, `p${i}`)
        roots.push(root)
        const res = appendDecisionEntry(root, e)
        assert.equal(res.error, undefined)
        assert.equal(res.count, 1)
      }
      assert.ok(
        logCountCacheSize() <= LOG_COUNT_CACHE_CAP,
        `cache size ${logCountCacheSize()} exceeded the ${LOG_COUNT_CACHE_CAP} cap`,
      )
      assert.equal(logCountCacheSize(), LOG_COUNT_CACHE_CAP, 'eviction keeps the cache exactly at its cap')

      // An EVICted path still recounts correctly on its next append (the fast
      // path is a cache miss, not a wrong answer).
      const evicted = roots[0]!
      const again = appendDecisionEntry(evicted, e)
      assert.equal(again.error, undefined)
      assert.equal(again.count, 2, 'an evicted path must recount from disk, not report a stale/guessed count')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
