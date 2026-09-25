import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireLogLock, registerDecisionLogTool, appendDecisionEntry, invalidateLogCountCache, readDecisionEntries } from '../src/tools/decision-log.ts'
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