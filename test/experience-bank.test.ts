import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerExperienceBankTool } from '../src/tools/experience-bank.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown>; output: { render: (a: unknown, v: unknown) => unknown } } | null = null
  registerExperienceBankTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_experience was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
  }
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-experience-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const entryArgs = {
  pattern: 'missing null guard',
  dimension: 'correctness',
  description: 'guard values before dereferencing',
  verifiedFix: 'add an early null guard and a fallback',
  files: ['src/a.ts'],
  tags: ['null-safety'],
  findingSummary: 'Nullable dereference in hot path',
  severity: 'high',
}

describe('iterate_experience add', () => {
  it('records a new entry, persists it, and can read it back', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      assert.equal(result.ok, true)
      assert.equal(result.operation, 'add')
      assert.equal(result.added, true)
      assert.equal(result.count, 1)
      assert.equal(result.totalHits, 1)

      const bankPath = join(dir, '.iterate', 'experience.json')
      assert.equal(existsSync(bankPath), true)
      const persisted = JSON.parse(readFileSync(bankPath, 'utf-8'))
      assert.equal(persisted.totalHits, 1)
      assert.equal(persisted.entries.length, 1)

      const entry = result.entry as { id: string; pattern: string }
      const got = (await tool.execute({ operation: 'get', path: dir, id: entry.id })) as Record<string, unknown>
      assert.equal(got.operation, 'get')
      assert.equal((got.entry as { pattern: string }).pattern, 'missing null guard')
    } finally {
      cleanup()
    }
  })

  it('re-adding the same pattern+dimension bumps the hit count, not a duplicate', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const first = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      const firstId = (first.entry as { id: string }).id
      const second = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      assert.equal(second.added, false)
      assert.equal(second.totalHits, 2)
      assert.equal((second.entry as { id: string }).id, firstId)
      assert.equal((second.entry as { hitCount: number }).hitCount, 2)
      assert.equal(second.count, 1)
    } finally {
      cleanup()
    }
  })

  it('rejects an invalid entry without writing anything', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'add', path: dir, entry: { pattern: 'only a pattern' } })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.ok(Array.isArray(result.errors))
      assert.ok((result.errors as string[]).length >= 4)
      assert.equal(existsSync(join(dir, '.iterate')), false)
    } finally {
      cleanup()
    }
  })

  it('rejects an unknown operation via the enum', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ operation: 'bogus' }), /must be one of/)
  })

  it('renders the add result as readable text', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'add' }, {
      ok: true,
      kind: 'experience',
      operation: 'add',
      added: true,
      count: 1,
      totalHits: 1,
      entry: { id: 'exp-1', pattern: 'missing null guard', dimension: 'correctness', description: 'd', verifiedFix: 'f', files: ['a.ts'], tags: ['t'], hitCount: 1 },
    })
    assert.equal(blocks.length, 1)
    assert.match(blocks[0]!.text, /Recorded new experience: exp-1/)
    assert.match(blocks[0]!.text, /Pattern: missing null guard/)
  })

  it('add surfaces a persistence failure instead of reporting success', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // `.iterate` exists as a plain FILE — the entry cannot be persisted.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'add')
      assert.equal(result.entry, undefined)
      assert.match(result.error as string, /experience\.json/)
    } finally {
      cleanup()
    }
  })
})