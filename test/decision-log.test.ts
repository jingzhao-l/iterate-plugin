import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireLogLock, registerDecisionLogTool } from '../src/tools/decision-log.ts'
import { readDecisionEntries } from '../src/tools/decision-log.ts'

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