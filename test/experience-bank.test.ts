import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerExperienceBankTool, clampLimit } from '../src/tools/experience-bank.ts'

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
  registerExperienceBankTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_experience was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
    isConcurrencySafe: (args) => (def!.isConcurrencySafe?.(args) ?? false),
    presentResult: (args, result) => def!.presentResult?.(args, result) as { card?: string; title?: string } | undefined,
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

  it('remove deletes a recorded entry and persists the smaller bank', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const added = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      const id = (added.entry as { id: string }).id

      const removed = (await tool.execute({ operation: 'remove', path: dir, id })) as Record<string, unknown>
      assert.equal(removed.ok, true)
      assert.equal(removed.operation, 'remove')
      assert.equal(removed.count, 0)
      assert.equal(removed.totalHits, 1)

      const bankPath = join(dir, '.iterate', 'experience.json')
      const persisted = JSON.parse(readFileSync(bankPath, 'utf-8'))
      assert.equal(persisted.entries.length, 0)

      const got = (await tool.execute({ operation: 'get', path: dir, id })) as Record<string, unknown>
      assert.equal(got.ok, false)
    } finally {
      cleanup()
    }
  })

  it('remove reports an unknown id without modifying the bank', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'remove', path: dir, id: 'nope' })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.match(result.error as string, /not found/)
    } finally {
      cleanup()
    }
  })

  it('remove requires an id argument', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'remove', path: dir })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.match(result.error as string, /id is required/)
    } finally {
      cleanup()
    }
  })

  it('renders the remove result as readable text', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'remove' }, {
      ok: true,
      kind: 'experience',
      operation: 'remove',
      count: 3,
      totalHits: 9,
    })
    assert.equal(blocks.length, 1)
    assert.match(blocks[0]!.text, /Removed experience entry/)
    assert.match(blocks[0]!.text, /3 entries/)
  })
})

describe('iterate_experience concurrency safety', () => {
  it('excludes every write shape (add + remove) from the parallel dispatch group', () => {
    const tool = captureTool()
    assert.equal(tool.isConcurrencySafe({ operation: 'list' }), true)
    assert.equal(tool.isConcurrencySafe({ operation: 'search' }), true)
    assert.equal(tool.isConcurrencySafe({ operation: 'get' }), true)
    assert.equal(tool.isConcurrencySafe({}), true) // default = list
    assert.equal(tool.isConcurrencySafe({ operation: 'add' }), false)
    assert.equal(tool.isConcurrencySafe({ operation: 'remove' }), false)
  })
})

// ─── read operations: defaults, filters, limits, required args ──────────────

/** Seed a hand-edited bank directly (cheaper than N add round-trips). */
function seedBank(dir: string, entries: Array<Record<string, unknown>>): void {
  mkdirSync(join(dir, '.iterate'), { recursive: true })
  writeFileSync(
    join(dir, '.iterate', 'experience.json'),
    JSON.stringify({ entries, lastUpdated: '2026-01-01T00:00:00.000Z', totalHits: entries.length }),
    'utf-8',
  )
}

const seededEntry = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `exp-seed-${i}`,
  timestamp: '2026-01-01T00:00:00.000Z',
  dimension: 'correctness',
  pattern: `pattern ${i}`,
  description: 'desc',
  verifiedFix: 'fix',
  findingSummary: 'summary',
  severity: 'low',
  files: [`src/f${i}.ts`],
  tags: ['t1'],
  hitCount: 1,
  ...over,
})

const smallBank = [
  seededEntry(0, { pattern: 'alpha null guard' }),
  seededEntry(1, { dimension: 'security', pattern: 'beta sqli', tags: ['t2'] }),
  seededEntry(2, { pattern: 'gamma null', tags: ['t1', 't2'] }),
  seededEntry(3, { dimension: 'security', pattern: 'delta xss', tags: [] }),
]

describe('iterate_experience read operations', () => {
  it('defaults to the list operation when operation is omitted', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, smallBank)
      const listed = (await tool.execute({ path: dir })) as Record<string, unknown>
      assert.equal(listed.ok, true)
      assert.equal(listed.operation, 'list')
      assert.equal(listed.count, 4)
      assert.equal(listed.totalHits, 4)
      assert.equal((listed.entries as unknown[]).length, 4)
    } finally {
      cleanup()
    }
  })

  it('filters the list by dimension and by tags (AND)', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, smallBank)
      const byDimension = (await tool.execute({ path: dir, dimension: 'security' })) as Record<string, unknown>
      assert.equal(byDimension.operation, 'list')
      assert.equal(byDimension.count, 2)
      assert.deepEqual(
        (byDimension.entries as Array<{ id: string }>).map((e) => e.id).sort(),
        ['exp-seed-1', 'exp-seed-3'],
      )

      const byTag = (await tool.execute({ path: dir, tags: ['t1'] })) as Record<string, unknown>
      assert.equal(byTag.count, 2)
      const byBothTags = (await tool.execute({ path: dir, tags: ['t1', 't2'] })) as Record<string, unknown>
      assert.equal(byBothTags.count, 1)
      assert.equal((byBothTags.entries as Array<{ id: string }>)[0]!.id, 'exp-seed-2')
    } finally {
      cleanup()
    }
  })

  it('search matches text and honours the dimension filter', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, smallBank)
      const found = (await tool.execute({ operation: 'search', path: dir, query: 'null' })) as Record<string, unknown>
      assert.equal(found.ok, true)
      assert.equal(found.operation, 'search')
      assert.equal(found.count, 2) // alpha null guard + gamma null

      const scoped = (await tool.execute({
        operation: 'search', path: dir, query: 'null', dimension: 'security',
      })) as Record<string, unknown>
      assert.equal(scoped.operation, 'search')
      assert.equal(scoped.count, 0)

      const other = (await tool.execute({ operation: 'search', path: dir, query: 'xss' })) as Record<string, unknown>
      assert.equal(other.count, 1)
      assert.equal((other.entries as Array<{ id: string }>)[0]!.id, 'exp-seed-3')
    } finally {
      cleanup()
    }
  })

  it('get with an unknown id is a structured not-found error', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'get', path: dir, id: 'exp-nope' })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'get')
      assert.match(result.error as string, /not found/)
    } finally {
      cleanup()
    }
  })

  it('get without an id errors instead of falling through to list', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, smallBank)
      const result = (await tool.execute({ operation: 'get', path: dir })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'get')
      assert.equal(result.error, 'id is required for get')
      // The old fall-through answered with a LIST payload (ok:true + entries).
      assert.equal(result.entries, undefined)
      assert.equal(result.entry, undefined)
    } finally {
      cleanup()
    }
  })

  it('search without a query errors instead of falling through to list', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, smallBank)
      const result = (await tool.execute({ operation: 'search', path: dir })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'search')
      assert.equal(result.error, 'query is required for search')
      assert.equal(result.entries, undefined)
    } finally {
      cleanup()
    }
  })

  it('clamps limit to the cap and truncates the returned entries', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      seedBank(dir, Array.from({ length: 105 }, (_, i) => seededEntry(i)))
      const capped = (await tool.execute({ path: dir, limit: 10_000 })) as Record<string, unknown>
      // MAX_LIMIT = 100 — an absurd limit must not dump the whole bank.
      assert.equal((capped.entries as unknown[]).length, 100)
      assert.equal(capped.count, 100)

      const one = (await tool.execute({ path: dir, limit: 1 })) as Record<string, unknown>
      assert.equal((one.entries as unknown[]).length, 1)
      assert.equal(one.count, 1)
    } finally {
      cleanup()
    }
  })

  it('clampLimit defaults for non-integer/out-of-range limits and caps large ones', () => {
    assert.equal(clampLimit(undefined), 50)
    assert.equal(clampLimit(2.5), 50)
    assert.equal(clampLimit(0), 50)
    assert.equal(clampLimit(-1), 50)
    assert.equal(clampLimit('10' as unknown as number), 50)
    assert.equal(clampLimit(10_000), 100)
    assert.equal(clampLimit(1), 1)
  })

  it('a non-integer limit is rejected by argument validation before the body runs', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ limit: 2.5 }), /must be an integer/)
  })
})

// ─── caller-supplied ids on add ─────────────────────────────────────────────

describe('iterate_experience add id validation', () => {
  it('rejects an oversized caller-supplied id for a NEW entry', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'add', path: dir, entry: { ...entryArgs, id: 'y'.repeat(201) },
      })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'add')
      assert.match(result.error as string, /entry\.id must be a printable string of at most 200 characters/)
      // Nothing may persist for a rejected identity.
      assert.equal(existsSync(join(dir, '.iterate', 'experience.json')), false)
    } finally {
      cleanup()
    }
  })

  it('rejects a control-byte caller-supplied id for a NEW entry', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'add', path: dir, entry: { ...entryArgs, id: 'bad\nid' },
      })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.match(result.error as string, /entry\.id must be/)
      assert.equal(existsSync(join(dir, '.iterate', 'experience.json')), false)
    } finally {
      cleanup()
    }
  })

  it('accepts a normal custom id and then updates BY that id', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const created = (await tool.execute({
        operation: 'add', path: dir, entry: { ...entryArgs, id: 'my-custom-id' },
      })) as Record<string, unknown>
      assert.equal(created.ok, true)
      assert.equal(created.added, true)
      assert.equal((created.entry as { id: string }).id, 'my-custom-id')

      // Update-by-id: same id, edited fields → replaces (documented contract).
      const updated = (await tool.execute({
        operation: 'add', path: dir,
        entry: { ...entryArgs, id: 'my-custom-id', description: 'updated description' },
      })) as Record<string, unknown>
      assert.equal(updated.ok, true)
      assert.equal(updated.added, false)
      const entry = updated.entry as { id: string; description: string; hitCount: number }
      assert.equal(entry.id, 'my-custom-id')
      assert.equal(entry.description, 'updated description')
      assert.equal(entry.hitCount, 2)
    } finally {
      cleanup()
    }
  })
})

// ─── add/remove locking ─────────────────────────────────────────────────────

describe('iterate_experience write locking', () => {
  it('serializes sequential add/remove under the shared lock and leaves no residue', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const lockPath = join(dir, '.iterate', '.experience-bank.lock')
      const first = (await tool.execute({ operation: 'add', path: dir, entry: entryArgs })) as Record<string, unknown>
      assert.equal(first.ok, true)
      assert.equal(existsSync(lockPath), false, 'lock released after add')

      const second = (await tool.execute({
        operation: 'add', path: dir,
        entry: { ...entryArgs, dimension: 'security', pattern: 'other pattern' },
      })) as Record<string, unknown>
      assert.equal(second.ok, true)
      assert.equal(second.added, true)
      assert.equal(existsSync(lockPath), false)

      const id = (second.entry as { id: string }).id
      const removed = (await tool.execute({ operation: 'remove', path: dir, id })) as Record<string, unknown>
      assert.equal(removed.ok, true)
      assert.equal(removed.count, 1)
      assert.equal(existsSync(lockPath), false, 'lock released after remove')

      const persisted = JSON.parse(readFileSync(join(dir, '.iterate', 'experience.json'), 'utf-8'))
      assert.equal(persisted.entries.length, 1)
    } finally {
      cleanup()
    }
  })

  it('releases the lock on a failed remove (unknown id) too', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      await tool.execute({ operation: 'add', path: dir, entry: entryArgs })
      const failed = (await tool.execute({ operation: 'remove', path: dir, id: 'exp-missing' })) as Record<string, unknown>
      assert.equal(failed.ok, false)
      assert.equal(existsSync(join(dir, '.iterate', '.experience-bank.lock')), false)
      // The bank itself is untouched by the failed remove.
      const persisted = JSON.parse(readFileSync(join(dir, '.iterate', 'experience.json'), 'utf-8'))
      assert.equal(persisted.entries.length, 1)
    } finally {
      cleanup()
    }
  })

  it('presentResult titles completed operations with the rendered headline (#12)', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const addArgs = { operation: 'add', path: dir, entry: entryArgs }
      const added = await tool.execute(addArgs)
      const addCard = tool.presentResult(addArgs, { content: tool.render(addArgs, added), isError: false })
      assert.equal(addCard?.card, 'generic')
      assert.match(addCard!.title!, /^Recorded new experience: /)

      const listArgs = { operation: 'list', path: dir }
      const listed = await tool.execute(listArgs)
      const listContent = tool.render(listArgs, listed)
      const listCard = tool.presentResult(listArgs, { content: listContent, isError: false })
      assert.match(listCard!.title!, /^Found 1 experience\(s\)/)
      // Failures decline the card (default presentation keeps the raw result).
      assert.equal(tool.presentResult(listArgs, { content: listContent, isError: true }), undefined)
      assert.equal(tool.presentResult(listArgs, { content: [], isError: false }), undefined)
    } finally {
      cleanup()
    }
  })
})
describe('iterate_experience parameter docs vs implementation (minor 11)', () => {
  it('the id description does not promise add-updates, and top-level id is ignored on add', async () => {
    type ExperienceToolDef = {
      parameters: { properties: { id: { description: string } } }
      execute: (a: unknown, e: unknown) => Promise<unknown>
    }
    let def: ExperienceToolDef | null = null
    registerExperienceBankTool({
      tools: { register: (d: never) => { def = d as ExperienceToolDef | null } },
    } as never)
    // (TS narrows a closure-assigned `let` to `never` after the null check —
    // re-materialize the declared shape through a local.)
    const registered = def as ExperienceToolDef | null
    if (!registered) throw new Error('iterate_experience was not registered')

    // The old description claimed `id` could "update a specific entry via
    // add", but add() only reads `entry.id` — the top-level `args.id` was
    // silently dropped. The description now says so explicitly.
    const desc = registered.parameters.properties.id.description
    assert.doesNotMatch(desc, /update a specific entry via add/)
    assert.match(desc, /entry\.id/)

    // Lock the implementation side of that contract too.
    const { dir, cleanup } = tempProject()
    try {
      const exec = { signal: new AbortController().signal }
      const res = (await registered.execute(
        { operation: 'add', path: dir, id: 'ignored-top-level', entry: entryArgs },
        exec as never,
      )) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.notEqual((res.entry as { id: string }).id, 'ignored-top-level')
      assert.match((res.entry as { id: string }).id, /^exp-/)
    } finally {
      cleanup()
    }
  })
})
