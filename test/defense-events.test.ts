import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerDefenseEventsTool } from '../src/tools/defense-events.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  isConcurrencySafe: (args: unknown) => boolean
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
    isConcurrencySafe?: (a: unknown) => boolean
  } | null = null
  registerDefenseEventsTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_defense_events was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
    isConcurrencySafe: (args) => (def!.isConcurrencySafe?.(args) ?? false),
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

  it('lists a hand-edited file without crashing on missing timestamps/severity', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // Seed a hand-edited stream: one event missing `timestamp` (the list sort
      // would previously throw `b.timestamp.localeCompare is not a function`)
      // and one with a non-string severity.
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(join(dir, '.iterate', 'defense-events.json'), JSON.stringify({
        lastUpdated: 't',
        counts: { precondition_failed: 1, rollback: 0, invariant_violated: 0, assumption_falsified: 0 },
        events: [
          { id: 'd1', round: 1, type: 'precondition_failed', description: 'x', defense: 'y', outcome: 'z', severity: 'medium' },
          { id: 'd2', round: 1, type: 'rollback', description: 'desc', defense: 'def', outcome: 'out', severity: 'bogus' },
        ],
      }), 'utf-8')

      const listed = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      assert.equal(listed.ok, true)
      const events = listed.events as Array<Record<string, unknown>>
      assert.equal(events.length, 2)
      // Both events survive with a normalized timestamp string + valid severity.
      for (const e of events) {
        assert.equal(typeof e.timestamp, 'string')
        assert.ok(['critical', 'high', 'medium', 'low'].includes(e.severity as string))
      }
    } finally {
      cleanup()
    }
  })

  it('falls back to en for a config language that is not zh/en', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: "g"\nlanguage: fr\n')
    try {
      await tool.execute({ operation: 'record', path: dir, round: 1, type: 'rollback', description: 'd', defense: 'def', outcome: 'o', severity: 'high' })
      const counts = (await tool.execute({ operation: 'counts', path: dir })) as Record<string, unknown>
      assert.equal(counts.language, 'en')
    } finally {
      cleanup()
    }
  })

  it('clears a persisted stream and renders the fresh summary', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const recorded = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(recorded.ok, true)
      assert.equal(existsSync(join(dir, '.iterate', 'defense-events.json')), true)

      const cleared = (await tool.execute({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(cleared.ok, true)
      assert.equal(cleared.operation, 'clear')
      assert.equal(cleared.counted, true)
      assert.deepEqual(cleared.counts as Record<string, number>, {
        precondition_failed: 0,
        rollback: 0,
        invariant_violated: 0,
        assumption_falsified: 0,
      })
      assert.equal(existsSync(join(dir, '.iterate', 'defense-events.json')), false)

      // The render shows the empty-summary clear card without crashing.
      const blocks = tool.render({ operation: 'clear' }, { ok: true, operation: 'clear', counted: true })
      assert.match(blocks[0]!.text, /Defense event stream cleared/)
    } finally {
      cleanup()
    }
  })

  it('clear is idempotent when no stream exists yet', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const cleared = (await tool.execute({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(cleared.ok, true)
      assert.equal(cleared.counted, false)
      // Render of the no-op clear path.
      const blocks = tool.render({ operation: 'clear' }, { ok: true, operation: 'clear', counted: false })
      assert.match(blocks[0]!.text, /No persisted defense event stream/)
    } finally {
      cleanup()
    }
  })
})

describe('iterate_defense_events concurrency safety', () => {
  it('excludes every write shape (record + clear) from the parallel dispatch group', () => {
    const tool = captureTool()
    assert.equal(tool.isConcurrencySafe({ operation: 'list' }), true)
    assert.equal(tool.isConcurrencySafe({ operation: 'counts' }), true)
    assert.equal(tool.isConcurrencySafe({}), true) // default = list
    assert.equal(tool.isConcurrencySafe({ operation: 'record' }), false)
    assert.equal(tool.isConcurrencySafe({ operation: 'clear' }), false)
  })
})