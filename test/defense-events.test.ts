import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerDefenseEventsTool, clampLimit } from '../src/tools/defense-events.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  isConcurrencySafe: (args: unknown) => boolean
  presentResult: (args: unknown, result: { content?: unknown; isError?: boolean }) => { card?: string; title?: string } | undefined
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
    isConcurrencySafe?: (a: unknown) => boolean
    presentResult?: (a: unknown, r: { content?: unknown; isError?: boolean }) => unknown
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
    presentResult: (args, result) => def!.presentResult?.(args, result) as { card?: string; title?: string } | undefined,
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

  it('rejects line 0 (not a usable position) and records a 1-based line', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // Positions are 1-based. `line: 0` passes the integer argument schema,
      // but the renderer prints the position only for a truthy line, so a
      // persisted 0 would come back as a bare file path — reject it and write
      // nothing.
      const zero = (await tool.execute({
        operation: 'record',
        path: dir,
        ...recordArgs,
        file: 'src/a.ts',
        line: 0,
      })) as Record<string, unknown>
      assert.equal(zero.ok, false)
      assert.ok((zero.errors as string[]).some((e) => e.includes('line')))
      assert.equal(existsSync(join(dir, '.iterate')), false)

      const ok = (await tool.execute({
        operation: 'record',
        path: dir,
        ...recordArgs,
        file: 'src/a.ts',
        line: 1,
      })) as Record<string, unknown>
      assert.equal(ok.ok, true)
      assert.equal((ok.event as { line?: number }).line, 1)
      const text = tool.render({ operation: 'record' }, ok)[0]!.text
      assert.match(text, /File: src\/a\.ts:1/)
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

// ─── list limit semantics, filters, and the record lock ─────────────────────

/** Seed a hand-edited stream directly (cheaper than N record round-trips). */
function seedEvents(dir: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(join(dir, '.iterate'), { recursive: true })
  writeFileSync(
    join(dir, '.iterate', 'defense-events.json'),
    JSON.stringify({ lastUpdated: '2026-01-01T00:00:00.000Z', events }),
    'utf-8',
  )
}

const seeded = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `def-seed-${i}`,
  timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
  round: 1,
  type: 'rollback',
  description: `seeded event ${i}`,
  defense: 'defense',
  outcome: 'outcome',
  severity: 'medium',
  ...over,
})

describe('iterate_defense_events list limits and total', () => {
  it('clampLimit defaults for undefined, non-integer, zero, and negative limits', () => {
    assert.equal(clampLimit(undefined), 50)
    assert.equal(clampLimit(2.5), 50)
    assert.equal(clampLimit(NaN), 50)
    assert.equal(clampLimit(0), 50)
    assert.equal(clampLimit(-3), 50)
    // Hand-built args can smuggle a string past the schema into the body.
    assert.equal(clampLimit('10' as unknown as number), 50)
  })

  it('clampLimit caps at MAX_LIMIT (100) and keeps in-range values', () => {
    assert.equal(clampLimit(10_000), 100)
    assert.equal(clampLimit(100), 100)
    assert.equal(clampLimit(1), 1)
    assert.equal(clampLimit(7), 7)
  })

  it('a non-integer limit is rejected by argument validation before the body runs', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ operation: 'list', limit: 2.5 }), /must be an integer/)
  })

  it('returns the untruncated total next to the limit-truncated count', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedEvents(dir, [seeded(1), seeded(2), seeded(3)])
      const listed = (await tool.execute({ operation: 'list', path: dir, limit: 1 })) as Record<string, unknown>
      assert.equal(listed.ok, true)
      assert.equal((listed.events as unknown[]).length, 1)
      assert.equal(listed.count, 1) // what was returned
      assert.equal(listed.total, 3) // what matched BEFORE truncation

      const blocks = tool.render({ operation: 'list' }, listed)
      assert.match(blocks[0]!.text, /showing 1 of 3/)
      assert.doesNotMatch(blocks[0]!.text, /\(1 total\)/)
    } finally {
      cleanup()
    }
  })

  it('renders the full untruncated list when nothing is cut', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedEvents(dir, [seeded(1), seeded(2)])
      const listed = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      assert.equal(listed.count, 2)
      assert.equal(listed.total, 2)
      const blocks = tool.render({ operation: 'list' }, listed)
      assert.match(blocks[0]!.text, /showing 2 of 2/)
    } finally {
      cleanup()
    }
  })

  it('clamps limit 10_000 down to the cap instead of returning the whole stream', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedEvents(dir, Array.from({ length: 105 }, (_, i) => seeded(i)))
      const listed = (await tool.execute({ operation: 'list', path: dir, limit: 10_000 })) as Record<string, unknown>
      assert.equal(listed.ok, true)
      // MAX_LIMIT = 100: an absurd limit must clamp, but `total` still tells
      // the caller how many matches really exist.
      assert.equal((listed.events as unknown[]).length, 100)
      assert.equal(listed.count, 100)
      assert.equal(listed.total, 105)
    } finally {
      cleanup()
    }
  })

  it('falls back to the default limit for a non-integer limit', () => {
    // The `limit` parameter is declared `integer`, so the schema rejects 2.5
    // before the body runs (pinned above); the body-level clamp still defaults
    // for hand-constructed args — see clampLimit tests at the top of this file.
    assert.equal(clampLimit(2.5), 50)
  })

  it('sorts a timestamp-less event as the OLDEST (last in a newest-first list)', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // The missing-timestamp event is normalized to the epoch sentinel, so it
      // must never jump ahead of a genuinely newer event in the list.
      seedEvents(dir, [
        { id: 'no-ts', round: 1, type: 'rollback', description: 'd', defense: 'f', outcome: 'o', severity: 'low' },
        seeded(2, { timestamp: '2026-06-01T00:00:00.000Z' }),
      ])
      const listed = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      const ids = (listed.events as Array<{ id: string }>).map((e) => e.id)
      assert.deepEqual(ids, ['def-seed-2', 'no-ts'])
    } finally {
      cleanup()
    }
  })
})

describe('iterate_defense_events list filters', () => {
  const mixed = [
    seeded(1, { type: 'rollback', round: 1, severity: 'high' }),
    seeded(2, { type: 'rollback', round: 2, severity: 'low' }),
    seeded(3, { type: 'precondition_failed', round: 1, severity: 'high' }),
  ]

  it('filters by type, round, severity, and their combination', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedEvents(dir, mixed)
      const byType = (await tool.execute({ operation: 'list', path: dir, type: 'rollback' })) as Record<string, unknown>
      assert.equal(byType.total, 2)
      const byRound = (await tool.execute({ operation: 'list', path: dir, round: 1 })) as Record<string, unknown>
      assert.equal(byRound.total, 2)
      const bySeverity = (await tool.execute({ operation: 'list', path: dir, severity: 'high' })) as Record<string, unknown>
      assert.equal(bySeverity.total, 2)
      const combined = (await tool.execute({
        operation: 'list', path: dir, type: 'rollback', round: 2, severity: 'low',
      })) as Record<string, unknown>
      assert.equal(combined.total, 1)
      assert.equal((combined.events as Array<{ id: string }>)[0]!.id, 'def-seed-2')
      assert.equal(combined.count, 1)
    } finally {
      cleanup()
    }
  })

  it('an invalid type filter matches nothing instead of crashing', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedEvents(dir, mixed)
      const listed = (await tool.execute({ operation: 'list', path: dir, type: 'not-a-real-type' })) as Record<string, unknown>
      assert.equal(listed.ok, true)
      assert.equal((listed.events as unknown[]).length, 0)
      assert.equal(listed.total, 0)
      assert.equal(listed.count, 0)
      const blocks = tool.render({ operation: 'list' }, listed)
      assert.equal(blocks[0]!.text, 'No defense events recorded.')
    } finally {
      cleanup()
    }
  })
})

describe('iterate_defense_events record locking', () => {
  it('serializes sequential records under the shared lock and leaves no residue', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const lockPath = join(dir, '.iterate', '.defense-events.lock')
      const first = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(first.ok, true)
      // The advisory lock is released as soon as the critical section ends —
      // no stale lock file may survive a successful record.
      assert.equal(existsSync(lockPath), false)

      const second = (await tool.execute({
        operation: 'record', path: dir, ...recordArgs, round: 3, type: 'invariant_violated',
      })) as Record<string, unknown>
      assert.equal(second.ok, true)
      assert.equal(existsSync(lockPath), false)

      const persisted = JSON.parse(readFileSync(join(dir, '.iterate', 'defense-events.json'), 'utf-8'))
      assert.equal(persisted.events.length, 2)
      assert.equal(persisted.counts.rollback, 1)
      assert.equal(persisted.counts.invariant_violated, 1)
    } finally {
      cleanup()
    }
  })

  it('still surfaces a persistence failure while holding the lock', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // `.iterate` exists as a plain FILE → nothing can be written under it.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.match(result.error as string, /defense-events\.json/)
      // Fail-open lock: an unwritable lock directory must not wedge the call,
      // and no lock file can exist under the file-turned directory anyway.
      assert.equal(existsSync(join(dir, '.iterate', '.defense-events.lock')), false)
    } finally {
      cleanup()
    }
  })

  it('clear runs under the same lock (a stale lock is stolen, none left behind)', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const recorded = (await tool.execute({ operation: 'record', path: dir, ...recordArgs })) as Record<string, unknown>
      assert.equal(recorded.ok, true)
      const lockPath = join(dir, '.iterate', '.defense-events.lock')
      // A crashed holder's lock: pid 99999999 is dead, so it is stale. Only a
      // clear that ACQUIRES the shared `defense-events` lock can steal it — an
      // unlocked clear (the old code) left the file behind AND raced a
      // concurrent record's read-modify-write.
      writeFileSync(lockPath, '99999999', 'utf-8')

      const cleared = (await tool.execute({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(cleared.ok, true)
      assert.equal(cleared.counted, true)
      assert.equal(existsSync(lockPath), false, 'the stale lock must be stolen and released by clear')
      assert.equal(existsSync(join(dir, '.iterate', 'defense-events.json')), false)
    } finally {
      cleanup()
    }
  })
})

describe('iterate_defense_events presentResult (#12)', () => {
  it('folds the counts summary into one headline; other operations decline', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      await tool.execute({ operation: 'record', path: dir, round: 1, type: 'rollback', description: 'd', defense: 'def', outcome: 'o', severity: 'high' })
      await tool.execute({ operation: 'record', path: dir, round: 1, type: 'precondition_failed', description: 'd', defense: 'def', outcome: 'o', severity: 'medium' })
      const args = { operation: 'counts', path: dir }
      const counts = await tool.execute(args)
      const content = tool.render(args, counts)
      const card = tool.presentResult(args, { content, isError: false })
      assert.equal(card?.card, 'generic')
      assert.match(card!.title!, /^Defense events: 2 recorded \(/, `headline: ${card!.title}`)
      // Only the types that fired are named (zero rows are dropped), labels
      // follow the configured language (default: en).
      assert.ok(card!.title!.includes('rollback: 1'), `headline: ${card!.title}`)
      assert.ok(card!.title!.includes('precondition failed: 1'), `headline: ${card!.title}`)
      assert.ok(!card!.title!.includes('invariant violated'), `zero types must not appear: ${card!.title}`)
      // `list`/`record` keep the default presentation; failures decline.
      assert.equal(tool.presentResult({ operation: 'list', path: dir }, { content, isError: false }), undefined)
      assert.equal(tool.presentResult(args, { content, isError: true }), undefined)
      // Unreadable content → decline rather than guess a total.
      assert.equal(tool.presentResult(args, { content: [{ type: 'text', text: 'garbage' }], isError: false }), undefined)
    } finally {
      cleanup()
    }
  })
})