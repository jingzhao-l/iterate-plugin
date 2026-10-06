import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import yaml from 'js-yaml'
import {
  normalizeEntryLine,
  validateTriageEntries,
  entryKey,
  mergeKnownIntentional,
  buildConfigWithKnownIntentional,
  readKnownIntentional,
  backupSuffix,
  registerTriageTool,
  pruneOldConfigBackups,
  MAX_TRIAGE_BACKUPS,
  MAX_TOTAL_KNOWN_INTENTIONAL,
} from '../src/tools/triage.ts'
import type { KnownIntentional } from '../src/types.ts'
import * as evidence from '../src/evidence.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

/** Capture the registered tool definition and expose its execute/render. */
function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  presentCall: (args: unknown) => { card?: string; title?: string; kind?: string } | undefined
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
    presentCall?: (a: unknown) => unknown
  } | null = null
  registerTriageTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_triage was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
    presentCall: (args) => def!.presentCall?.(args) as { card?: string; title?: string; kind?: string } | undefined,
  }
}

/** Create a temp project dir with an optional config and return cleanup. */
function tempProject(initialConfig?: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-triage-test-'))
  if (initialConfig !== undefined) {
    writeFileSync(join(dir, 'iterate.config.yaml'), initialConfig, 'utf-8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const entry = (over: Partial<KnownIntentional> = {}): KnownIntentional => ({
  file: 'src/a.ts',
  dimension: 'security',
  reason: 'test only',
  ...over,
})

// ─── normalizeEntryLine ──────────────────────────────────────────────────────

describe('normalizeEntryLine', () => {
  it('returns a positive integer unchanged', () => {
    assert.equal(normalizeEntryLine(5), 5)
  })

  it('returns undefined for absent / zero / negative / non-integer values', () => {
    assert.equal(normalizeEntryLine(undefined), undefined)
    assert.equal(normalizeEntryLine(0), undefined)
    assert.equal(normalizeEntryLine(-3), undefined)
    assert.equal(normalizeEntryLine(1.5), undefined)
    assert.equal(normalizeEntryLine('5'), undefined)
    assert.equal(normalizeEntryLine(null), undefined)
  })
})

// ─── validateTriageEntries ───────────────────────────────────────────────────

describe('validateTriageEntries', () => {
  it('returns an error for a non-array', () => {
    assert.deepEqual(validateTriageEntries('nope'), ['entries must be an array'])
    assert.deepEqual(validateTriageEntries(undefined), ['entries must be an array'])
  })

  it('flags missing file / dimension / reason and bad lines', () => {
    const errors = validateTriageEntries([
      { file: '', dimension: '', reason: '', line: -2 },
    ])
    assert.equal(errors.length, 4)
    assert.ok(errors.some((e) => e.includes('.file')))
    assert.ok(errors.some((e) => e.includes('.dimension')))
    assert.ok(errors.some((e) => e.includes('.reason')))
    assert.ok(errors.some((e) => e.includes('.line')))
  })

  it('accepts valid entries (line optional)', () => {
    assert.deepEqual(validateTriageEntries([entry()]), [])
    assert.deepEqual(validateTriageEntries([entry({ line: 42 })]), [])
  })
})

// ─── entryKey ────────────────────────────────────────────────────────────────

describe('entryKey', () => {
  it('distinguishes whole-file from line-specific entries', () => {
    const whole = entryKey(entry())
    const specific = entryKey(entry({ line: 5 }))
    assert.notEqual(whole, specific)
  })

  it('is stable across equivalent entries', () => {
    assert.equal(entryKey(entry()), entryKey(entry()))
  })
})

// ─── mergeKnownIntentional ───────────────────────────────────────────────────

describe('mergeKnownIntentional', () => {
  it('adds new entries and skips duplicates by key', () => {
    const existing = [entry({ line: 5 })]
    const incoming = [entry({ line: 5 }), entry({ file: 'src/b.ts' })]
    const { merged, added, skipped } = mergeKnownIntentional(existing, incoming)
    assert.equal(added, 1)
    assert.equal(skipped, 1)
    assert.equal(merged.length, 2)
    assert.deepEqual(merged[0], existing[0])
  })

  it('does not mutate the existing list', () => {
    const existing = [entry()]
    const snapshot = JSON.stringify(existing)
    mergeKnownIntentional(existing, [entry({ file: 'src/new.ts' })])
    assert.equal(JSON.stringify(existing), snapshot)
  })

  it('reports dropped: 0 while the merged list is under the total cap', () => {
    const existing = Array.from({ length: 10 }, (_, i) => entry({ file: `src/f${i}.ts` }))
    const { merged, added, skipped, dropped } = mergeKnownIntentional(
      existing,
      [entry({ file: 'src/new.ts' })],
    )
    assert.equal(added, 1)
    assert.equal(skipped, 0)
    assert.equal(dropped, 0)
    assert.equal(merged.length, 11)
  })

  it('caps the TOTAL list at MAX_TOTAL_KNOWN_INTENTIONAL, evicting the oldest', () => {
    // Regression: MAX_ENTRIES only bounded ONE apply payload, so the list grew
    // without limit across sessions — filterKnownIntentional then ran
    // O(findings × entries) over an ever-longer list and the config file grew
    // with it. The merge result is now bounded, oldest-first.
    const existing = Array.from({ length: MAX_TOTAL_KNOWN_INTENTIONAL }, (_, i) =>
      entry({ file: `src/f${i}.ts` }),
    )
    const { merged, added, skipped, dropped } = mergeKnownIntentional(existing, [
      entry({ file: 'src/new1.ts' }),
      entry({ file: 'src/new2.ts' }),
    ])
    assert.equal(added, 2)
    assert.equal(skipped, 0)
    assert.equal(dropped, 2, 'the overflow count must be reported, not silent')
    assert.equal(merged.length, MAX_TOTAL_KNOWN_INTENTIONAL)
    // The two OLDEST entries were evicted…
    assert.equal(merged[0]?.file, 'src/f2.ts')
    // …while the freshly merged entries (appended at the END) survive.
    assert.equal(merged[merged.length - 1]?.file, 'src/new2.ts')
    assert.equal(merged[merged.length - 2]?.file, 'src/new1.ts')
  })

  it('duplicate incoming entries at the cap are skipped, not evicted', () => {
    const existing = Array.from({ length: MAX_TOTAL_KNOWN_INTENTIONAL }, (_, i) =>
      entry({ file: `src/f${i}.ts` }),
    )
    const { merged, added, skipped, dropped } = mergeKnownIntentional(existing, [
      entry({ file: 'src/f0.ts' }), // already known → skipped
    ])
    assert.equal(added, 0)
    assert.equal(skipped, 1)
    assert.equal(dropped, 0, 'nothing new → nothing evicted')
    assert.equal(merged.length, MAX_TOTAL_KNOWN_INTENTIONAL)
    assert.equal(merged[0]?.file, 'src/f0.ts')
  })
})

// ─── buildConfigWithKnownIntentional / readKnownIntentional ──────────────────

describe('config object helpers', () => {
  it('preserves unrelated top-level fields and sets personalization', () => {
    const config = { goal: 'g', dimensions: ['a'] }
    const next = buildConfigWithKnownIntentional(config, [entry()])
    assert.equal(next.goal, 'g')
    assert.deepEqual(next.dimensions, ['a'])
    const personalization = next.personalization as { known_intentional: KnownIntentional[] }
    assert.equal(personalization.known_intentional.length, 1)
    assert.equal((config as { personalization?: unknown }).personalization, undefined)
  })

  it('readKnownIntentional returns [] when absent or malformed', () => {
    assert.deepEqual(readKnownIntentional({}), [])
    assert.deepEqual(readKnownIntentional({ personalization: {} }), [])
    assert.deepEqual(readKnownIntentional({ personalization: { known_intentional: 'nope' } }), [])
  })

  it('readKnownIntentional filters out malformed entries', () => {
    const known = readKnownIntentional({
      personalization: { known_intentional: [entry(), { dimension: 'x' }, 42] },
    })
    assert.equal(known.length, 1)
  })
})

// ─── backupSuffix ────────────────────────────────────────────────────────────

describe('backupSuffix', () => {
  it('produces a filesystem-safe suffix (no colons or dots)', () => {
    const suffix = backupSuffix(new Date('2026-08-16T12:34:56.789Z'))
    assert.ok(!suffix.includes(':'))
    assert.ok(!suffix.includes('.'))
    assert.ok(/^[0-9TZ-]+$/.test(suffix))
  })

  it('never collides for backups taken in the SAME millisecond', () => {
    // The triage writer used to carry its OWN copy of the suffix helper —
    // two backups in the same ms built the identical `config.bak-<iso>` path
    // and the second silently overwrote the first. It now shares
    // config-write's monotonic-guarded implementation.
    const t = new Date('2026-08-17T00:00:00.000Z')
    const first = backupSuffix(t)
    const second = backupSuffix(t)
    const third = backupSuffix(t)
    assert.equal(new Set([first, second, third]).size, 3, `got: ${first}, ${second}, ${third}`)
    assert.match(second, /^2026-08-17T00-00-00-000Z-1$/)
    assert.match(third, /^2026-08-17T00-00-00-000Z-2$/)
    for (const s of [first, second, third]) assert.ok(/^[0-9TZ-]+$/.test(s), s)
  })
})

// ─── End-to-end tool execution ───────────────────────────────────────────────

describe('iterate_triage execute', () => {
  it('applies new entries to an existing config with a backup', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: "g"\ndimensions:\n  - correctness\n')
    try {
      const result = (await tool.execute({
        operation: 'apply',
        path: dir,
        entries: [entry({ file: 'src/x.ts', line: 7, dimension: 'security', reason: 'r' })],
      })) as Record<string, unknown>
      assert.equal(result.operation, 'apply')
      assert.equal(result.added, 1)
      assert.equal(result.skipped, 0)
      assert.equal(result.count, 1)

      const configPath = join(dir, 'iterate.config.yaml')
      const content = readFileSync(configPath, 'utf-8')
      const parsed = yaml.load(content) as Record<string, unknown>
      assert.equal(parsed.goal, 'g')
      const known = (parsed.personalization as { known_intentional: KnownIntentional[] }).known_intentional
      assert.equal(known.length, 1)
      assert.equal(known[0]!.file, 'src/x.ts')
      assert.equal(known[0]!.line, 7)

      // A timestamped backup of the ORIGINAL config exists.
      const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
      assert.equal(backups.length, 1)
      const backupContent = readFileSync(join(dir, backups[0] as string), 'utf-8')
      assert.match(backupContent, /goal: "g"/)
    } finally {
      cleanup()
    }
  })

  it('re-applying the same entries skips them', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: "g"\n')
    try {
      const args = {
        operation: 'apply',
        path: dir,
        entries: [entry()],
      }
      const first = (await tool.execute(args)) as Record<string, unknown>
      assert.equal(first.added, 1)
      const second = (await tool.execute(args)) as Record<string, unknown>
      assert.equal(second.added, 0)
      assert.equal(second.skipped, 1)
      assert.equal(second.count, 1)
    } finally {
      cleanup()
    }
  })

  it('apply reports `dropped` when the total known_intentional cap is hit', async () => {
    // MAX_TOTAL_KNOWN_INTENTIONAL bounds the LIST (not just one payload):
    // merging past it evicts the OLDEST entries and the tool result must
    // report how many were dropped instead of silently losing verdicts.
    const tool = captureTool()
    const existing = Array.from({ length: MAX_TOTAL_KNOWN_INTENTIONAL }, (_, i) => ({
      file: `src/f${i}.ts`,
      dimension: 'security',
      reason: 'intentional',
    }))
    const { dir, cleanup } = tempProject(
      yaml.dump({ goal: 'g', personalization: { known_intentional: existing } }),
    )
    try {
      const result = (await tool.execute({
        operation: 'apply',
        path: dir,
        entries: [entry({ file: 'src/new.ts', dimension: 'security', reason: 'fresh' })],
      })) as Record<string, unknown>
      assert.equal(result.added, 1)
      assert.equal(result.skipped, 0)
      assert.equal(result.dropped, 1, `expected dropped=1, got ${JSON.stringify(result)}`)
      assert.equal(result.count, MAX_TOTAL_KNOWN_INTENTIONAL)

      const parsed = yaml.load(readFileSync(join(dir, 'iterate.config.yaml'), 'utf-8')) as Record<string, unknown>
      const known = readKnownIntentional(parsed)
      assert.equal(known.length, MAX_TOTAL_KNOWN_INTENTIONAL)
      // The oldest entry (src/f0.ts) was evicted; the fresh one is last.
      assert.equal(known[0]?.file, 'src/f1.ts')
      assert.equal(known[known.length - 1]?.file, 'src/new.ts')
      // The backup still holds the pre-merge snapshot (1000 entries, f0 first).
      const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
      assert.equal(backups.length, 1)
      const backupParsed = yaml.load(readFileSync(join(dir, backups[0] as string), 'utf-8')) as Record<string, unknown>
      assert.equal(readKnownIntentional(backupParsed)[0]?.file, 'src/f0.ts')
    } finally {
      cleanup()
    }
  })

  it('creates the config file when none exists', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'apply',
        path: dir,
        entries: [entry()],
      })) as Record<string, unknown>
      assert.equal(result.added, 1)
      assert.equal(result.backupPath, null)
      assert.equal(existsSync(join(dir, 'iterate.config.yaml')), true)
    } finally {
      cleanup()
    }
  })

  it('refuses to overwrite an existing but unparsable config', async () => {
    const tool = captureTool()
    const malformed = 'goal: [unclosed'
    const { dir, cleanup } = tempProject(malformed)
    try {
      const result = (await tool.execute({
        operation: 'apply',
        path: dir,
        entries: [entry()],
      })) as Record<string, unknown>
      assert.equal(result.added, undefined)
      assert.match(String(result.error), /Failed to read config|not a valid YAML/)
      // The file is untouched and no backup was created.
      assert.equal(readFileSync(join(dir, 'iterate.config.yaml'), 'utf-8'), malformed)
      const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
      assert.equal(backups.length, 0)
    } finally {
      cleanup()
    }
  })

  it('list reports an error for an unparsable config', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: [unclosed')
    try {
      const result = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      assert.match(String(result.error), /Failed to read config/)
    } finally {
      cleanup()
    }
  })

  it('rejects invalid entries without touching the config', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('goal: "g"\n')
    const original = readFileSync(join(dir, 'iterate.config.yaml'), 'utf-8')
    try {
      const result = (await tool.execute({
        operation: 'apply',
        path: dir,
        entries: [{ file: '', dimension: '', reason: '' }],
      })) as Record<string, unknown>
      assert.equal(result.added, undefined)
      assert.ok(Array.isArray(result.errors))
      // No backup was created and the file is unchanged.
      const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
      assert.equal(backups.length, 0)
      assert.equal(readFileSync(join(dir, 'iterate.config.yaml'), 'utf-8'), original)
    } finally {
      cleanup()
    }
  })

  it('lists the known_intentional entries', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject('personalization:\n  known_intentional:\n    - file: src/a.ts\n      dimension: security\n      reason: r\n')
    try {
      const result = (await tool.execute({ operation: 'list', path: dir })) as Record<string, unknown>
      assert.equal(result.operation, 'list')
      assert.equal(result.count, 1)
      const entries = result.entries as KnownIntentional[]
      assert.equal(entries[0]!.file, 'src/a.ts')
    } finally {
      cleanup()
    }
  })

  it('rejects an unknown operation through args validation', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ operation: 'bogus' }), /must be one of/)
  })

  it('renders the canonical value as JSON text', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'list' }, { operation: 'list', count: 0, entries: [] })
    assert.equal(blocks[0]!.type, 'text')
    assert.match(blocks[0]!.text, /"operation": "list"/)
  })
})

describe('pruneOldConfigBackups', () => {
  it('deletes timestamped config backups beyond the newest keep, newest-first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-triage-prune-'))
    const configPath = join(dir, 'iterate.config.yaml')
    try {
      writeFileSync(configPath, 'goal: "g"\n', 'utf-8')
      for (let i = 1; i <= 9; i++) {
        const stamp = `2026-08-0${i}T00-00-00-000Z`
        writeFileSync(join(dir, `iterate.config.yaml.bak-${stamp}`), 'old', 'utf-8')
      }
      // Unrelated sibling files and OTHER config names are never touched.
      writeFileSync(join(dir, 'other.config.yaml.bak-2026-08-01T00-00-00-000Z'), 'x', 'utf-8')
      writeFileSync(join(dir, 'README.md'), 'x', 'utf-8')

      const removed = pruneOldConfigBackups(configPath, MAX_TRIAGE_BACKUPS)
      assert.equal(removed.length, 4) // 9 backups − keep 5
      const remaining = readdirSync(dir).filter((f) => f.startsWith('iterate.config.yaml.bak-'))
      assert.equal(remaining.length, MAX_TRIAGE_BACKUPS)
      // The 5 NEWEST survive (lexicographic ISO sort = oldest stamps removed).
      assert.deepEqual(remaining, [
        'iterate.config.yaml.bak-2026-08-05T00-00-00-000Z',
        'iterate.config.yaml.bak-2026-08-06T00-00-00-000Z',
        'iterate.config.yaml.bak-2026-08-07T00-00-00-000Z',
        'iterate.config.yaml.bak-2026-08-08T00-00-00-000Z',
        'iterate.config.yaml.bak-2026-08-09T00-00-00-000Z',
      ])
      assert.equal(existsSync(join(dir, 'other.config.yaml.bak-2026-08-01T00-00-00-000Z')), true)
      assert.equal(existsSync(join(dir, 'README.md')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when at or under the keep bound (and errors never surface)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-triage-prune-'))
    const configPath = join(dir, 'iterate.config.yaml')
    try {
      writeFileSync(configPath, 'goal: "g"\n', 'utf-8')
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(dir, `iterate.config.yaml.bak-2026-08-0${i}T00-00-00-000Z`), 'old', 'utf-8')
      }
      assert.deepEqual(pruneOldConfigBackups(configPath, MAX_TRIAGE_BACKUPS), [])
      // Missing config dir → best-effort no-op, returns [] without throwing.
      assert.deepEqual(
        pruneOldConfigBackups(join(dir, 'does-not-exist', 'iterate.config.yaml')),
        [],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('iterate_triage presentCall (#12)', () => {
  it('cards the apply write with its entry count; list keeps the default view', () => {
    const tool = captureTool()
    // `list` is a pure read → no custom card.
    assert.equal(tool.presentCall({ operation: 'list' }), undefined)

    const bare = tool.presentCall({ operation: 'apply' })
    assert.equal(bare?.card, 'generic')
    assert.equal(bare?.kind, 'edit')
    assert.equal(bare?.title, 'Apply known_intentional entries to iterate.config.yaml')

    const one = tool.presentCall({
      operation: 'apply',
      entries: [{ file: 'src/a.ts', dimension: 'correctness', reason: 'intended' }],
    })
    assert.equal(one?.title, 'Apply 1 known_intentional entry to iterate.config.yaml')

    const many = tool.presentCall({ operation: 'apply', entries: [{}, {}] })
    assert.match(many!.title!, /^Apply 2 known_intentional entries to iterate\.config\.yaml$/)

    // A non-array `entries` (shape the executor will reject) still gets a
    // truthful card without a fabricated count.
    const malformed = tool.presentCall({ operation: 'apply', entries: 'nope' })
    assert.equal(malformed?.title, 'Apply known_intentional entries to iterate.config.yaml')
    // Unknown/absent operation → default presentation, never a wrong card.
    assert.equal(tool.presentCall({}), undefined)
  })
})

describe('shared WHOLE_FILE_LINE constant (minor 9)', () => {
  it('entryKey uses evidence.ts WHOLE_FILE_LINE instead of a local copy that could drift', () => {
    // triage.ts used to keep `const WHOLE_FILE_LINE = 0` as a THIRD private
    // copy; it now imports the shared constant (evidence.ts pulls in only
    // node builtins + a type import, so there is no cycle).
    assert.equal(evidence.WHOLE_FILE_LINE, 0)
    const key = entryKey({ file: 'src/a.ts', dimension: 'correctness' } as KnownIntentional)
    assert.equal(key, `src/a.ts|correctness|${evidence.WHOLE_FILE_LINE}`)
    // Whole-file semantics agree with evidence.ts: an absent line and an
    // explicit 0 key to the same entry.
    assert.equal(
      entryKey({ file: 'src/a.ts', dimension: 'correctness', line: 0 } as KnownIntentional),
      key,
    )
  })
})
