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
} from '../src/tools/triage.ts'
import type { KnownIntentional } from '../src/types.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

/** Capture the registered tool definition and expose its execute/render. */
function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown>; render: (a: unknown, v: unknown) => unknown } | null = null
  registerTriageTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_triage was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.render(args, value) as Array<{ type: string; text: string }>,
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
      assert.equal(known[0].file, 'src/x.ts')
      assert.equal(known[0].line, 7)

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
      assert.equal(result.backupPath, undefined)
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
      assert.equal(entries[0].file, 'src/a.ts')
    } finally {
      cleanup()
    }
  })

  it('returns an error for an unknown operation', async () => {
    const tool = captureTool()
    const result = (await tool.execute({ operation: 'bogus' })) as Record<string, unknown>
    assert.match(String(result.error), /Unknown operation/)
  })

  it('renders the canonical value as JSON text', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'list' }, { operation: 'list', count: 0, entries: [] })
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /"operation": "list"/)
  })
})
