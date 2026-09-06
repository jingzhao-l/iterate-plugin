import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerDefenseEventsTool } from '../src/tools/defense-events.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown>; output: { render: (a: unknown, v: unknown) => unknown } } | null = null
  registerDefenseEventsTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_defense_events was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
  }
}

function tempProject(config?: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-defense-test-'))
  if (config !== undefined) writeFileSync(join(dir, 'iterate.config.yaml'), config, 'utf-8')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const recordArgs = {
  round: 2,
  type: 'rollback',
  description: 'type-check failed after the fix',
  defense: 'atomic rollback on validation failure',
  outcome: 'the change was reverted and the file restored',
  severity: 'high',
}

describe('iterate_defense_events record', () => {
  it('persists a new event, bumps its count, and lists it back', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(result.ok, true)
      assert.equal(result.operation, 'record')
      assert.equal(result.language, 'en')
      const event = result.event as { id: string; round: number; type: string }
      assert.ok(event.id.startsWith('def-'))
      assert.equal(event.round, 2)
      const counts = result.counts as Record<string, number>
      assert.equal(counts.rollback, 1)

      const eventsPath = join(dir, '.iterate', 'defense-events.json')
      assert.equal(existsSync(eventsPath), true)
      const persisted = JSON.parse(readFileSync(eventsPath, 'utf-8'))
      assert.equal(persisted.counts.rollback, 1)
      assert.equal(persisted.events.length, 1)

      const listed = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      assert.equal((listed.events as unknown[]).length, 1)
    } finally {
      cleanup()
    }
  })

  it('honours the project language for labels in counts output', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: "g"\nlanguage: zh\n')
    try {
      await tool.execute({ operation: 'record', path: dir, round: 1, type: 'precondition_failed', description: 'd', defense: 'def', outcome: 'o', severity: 'medium' })
      const counts = (await tool.execute({ operation: 'counts', path: dir })) as Record<string, unknown>
      assert.equal(counts.language, 'zh')
      const blocks = tool.render({ operation: 'counts' }, counts)
      assert.match(blocks[0]!.text, /前置校验失败: 1/)
      // en override still works
      assert.equal(((await tool.execute({ operation: 'counts', path: dir, language: 'en' })) as Record<string, unknown>).language, 'en')
    } finally {
      cleanup()
    }
  })

  it('rejects an invalid record without writing anything', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'record',
        path: dir,
        round: -1,
        type: 'nope',
        description: '',
        defense: '',
        outcome: '',
        severity: 'uhoh',
      })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.ok(Array.isArray(result.errors))
      assert.equal(result.counts, undefined)
      assert.equal(existsSync(join(dir, '.iterate')), false)
    } finally {
      cleanup()
    }
  })

  it('rejects a negative/non-integer line on record', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // A negative integer passes the argument schema (it IS an integer), so
      // the tool's own validation must reject it and never write.
      const neg = (await tool.execute({
        operation: 'record',
        path: dir,
        ...recordArgs,
        line: -1,
      })) as Record<string, unknown>
      assert.equal(neg.ok, false)
      assert.ok((neg.errors as string[]).some((e) => e.includes('line')))

      // Non-integer / non-numeric values are rejected by the argument schema
      // before execute runs (INVALID_ARGS).
      for (const line of [1.5, '42']) {
        await assert.rejects(
          () => tool.execute({ operation: 'record', path: dir, ...recordArgs, line }),
          /must be an integer/,
        )
      }
      assert.equal(existsSync(join(dir, '.iterate')), false)
    } finally {
      cleanup()
    }
  })

  it('accepts a valid line (0 = whole-file) on record', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const ok = (await tool.execute({
        operation: 'record',
        path: dir,
        ...recordArgs,
        file: 'src/a.ts',
        line: 0,
      })) as Record<string, unknown>
      assert.equal(ok.ok, true)
      assert.equal((ok.event as { file: string }).file, 'src/a.ts')
    } finally {
      cleanup()
    }
  })

  it('counts/record renders use the requested label language', async () => {
    const tool = captureTool()
    const zh = tool.render({ operation: 'record' }, {
      ok: true,
      kind: 'defense_events',
      operation: 'record',
      language: 'zh',
      event: { id: 'def-1', round: 3, type: 'invariant_violated', description: 'd', defense: 'def', outcome: 'o', severity: 'high' },
    })
    assert.match(zh[0]!.text, /不变量违反/)
    const en = tool.render({ operation: 'record' }, {
      ok: true,
      kind: 'defense_events',
      operation: 'record',
      language: 'en',
      event: { id: 'def-1', round: 3, type: 'invariant_violated', description: 'd', defense: 'def', outcome: 'o', severity: 'high' },
    })
    assert.match(en[0]!.text, /invariant violated/i)
  })

  it('rejects an unknown operation via the enum', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ operation: 'bogus' }), /must be one of/)
  })

  it('record surfaces a persistence failure instead of reporting success', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // `.iterate` exists as a plain FILE — the event cannot be persisted.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'record')
      assert.equal(result.event, undefined)
      assert.match(result.error as string, /defense-events\.json/)
    } finally {
      cleanup()
    }
  })
})