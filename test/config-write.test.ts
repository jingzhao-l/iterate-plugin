import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import yaml from 'js-yaml'
import {
  CONFIG_FILE,
  configBackupSuffix,
  validateConfigUpdates,
  applyConfigUpdates,
  readRawConfig,
  writeConfigFile,
} from '../src/config-write.ts'
import { registerConfigTool } from '../src/tools/config.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

type ToolDef = { execute: (a: unknown, e: unknown) => Promise<unknown> }
type Tool = (args: unknown) => Promise<unknown>

function captureTools(
  registrars: Array<(ctx: { tools: { register: (d: unknown) => void } }) => void>,
): Array<Tool> {
  const defs: ToolDef[] = []
  for (const reg of registrars) {
    reg({ tools: { register: (d: unknown) => { defs.push(d as ToolDef) } } })
  }
  const exec = { signal: new AbortController().signal }
  return defs.map((def) => (args: unknown) => def.execute(args, exec as never) as Promise<unknown>)
}

function tempProject(config?: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-config-write-test-'))
  if (config !== undefined) writeFileSync(join(dir, CONFIG_FILE), config, 'utf-8')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const MINIMAL_CONFIG = [
  'goal: "g"',
  'dimensions:',
  '  - correctness',
  'validation:',
  '  command_whitelist: []',
  '  commands: {}',
].join('\n')

// ─── configBackupSuffix ──────────────────────────────────────────────────────

describe('configBackupSuffix', () => {
  it('produces a filesystem-safe suffix', () => {
    const suffix = configBackupSuffix(new Date('2026-08-16T12:34:56.789Z'))
    assert.ok(!suffix.includes(':'))
    assert.ok(!suffix.includes('.'))
    assert.match(suffix, /^[0-9TZ-]+$/)
  })

  it('never collides for writes in the SAME millisecond', () => {
    // Regression: two backups created in the same ms built the identical
    // `config.bak-<iso>` path — the second overwrote the first and one
    // snapshot was silently lost. The helper now appends a monotonic
    // counter to repeats (a clock stepping backwards counts as a repeat).
    const t = new Date('2026-08-17T00:00:00.000Z')
    const first = configBackupSuffix(t)
    const second = configBackupSuffix(t)
    const third = configBackupSuffix(t)
    assert.notEqual(first, second)
    assert.notEqual(second, third)
    assert.notEqual(first, third)
    // The fresh-ms form stays verbatim (chronological sort); repeats only
    // gain a `-N` disambiguator, still filesystem-safe.
    assert.match(second, /^2026-08-17T00-00-00-000Z-1$/)
    assert.match(third, /^2026-08-17T00-00-00-000Z-2$/)
    for (const s of [first, second, third]) {
      assert.match(s, /^[0-9TZ-]+$/)
    }
    // A LATER millisecond resets to the clean form.
    const later = configBackupSuffix(new Date('2026-08-17T00:00:00.001Z'))
    assert.equal(later, '2026-08-17T00-00-00-001Z')
  })
})

// ─── validateConfigUpdates ───────────────────────────────────────────────────

describe('validateConfigUpdates', () => {
  it('accepts a valid update', () => {
    assert.deepEqual(
      validateConfigUpdates({ goal: 'g', dimensions: ['correctness'], max_rounds: 5 }),
      [],
    )
  })

  it('rejects a non-object update', () => {
    assert.deepEqual(validateConfigUpdates(null as unknown as Record<string, unknown>), ['updates must be a JSON object'])
    assert.deepEqual(validateConfigUpdates([] as unknown as Record<string, unknown>), ['updates must be a JSON object'])
  })

  it('flags every invalid field type', () => {
    const errors = validateConfigUpdates({
      goal: 42,
      language: 'fr',
      dimensions: ['ok', 7, ''],
      max_rounds: 0,
      review: { scope: 'partial' },
      atomic: { max_lines: 0 },
      git: { target_branch: 7, use_worktree: 'yes' },
      validation: { commands: 'nope' },
      personalization: 'x',
      onboarding: 1,
    } as unknown as Record<string, unknown>)
    assert.ok(errors.some((e) => e.includes('goal')))
    assert.ok(errors.some((e) => e.includes('language')))
    assert.ok(errors.some((e) => e.includes('dimensions')))
    assert.ok(errors.some((e) => e.includes('max_rounds')))
    assert.ok(errors.some((e) => e.includes('review.scope')))
    assert.ok(errors.some((e) => e.includes('atomic.max_lines')))
    assert.ok(errors.some((e) => e.includes('git.target_branch')))
    assert.ok(errors.some((e) => e.includes('git.use_worktree')))
    assert.ok(errors.some((e) => e.includes('validation.commands')))
    assert.ok(errors.some((e) => e.includes('personalization')))
    assert.ok(errors.some((e) => e.includes('onboarding')))
  })

  it('accepts valid nested updates', () => {
    assert.deepEqual(
      validateConfigUpdates({
        review: { scope: 'changed-only' },
        atomic: { max_lines: 30, max_adjacent_methods: 5 },
        git: { target_branch: 'dev', use_worktree: true, push_per_round: false, auto_merge: true },
      }),
      [],
    )
  })

  it('accepts observatory updates that do not touch the approval policy', () => {
    assert.deepEqual(
      validateConfigUpdates({ observatory: { capture: true } }),
      [],
    )
  })

  it('rejects an observatory approval change fail-closed', () => {
    // The model must not be able to flip the human-consent gate to `allow`.
    const errors = validateConfigUpdates({ observatory: { approval: 'allow' } })
    assert.ok(errors.some((e) => e.includes('observatory.approval')))
    assert.match(errors.join('; '), /human-controlled/)
  })

  it('rejects absurdly large numeric fields (config bomb guard)', () => {
    const errors = validateConfigUpdates({
      max_rounds: 1_000_000,
      atomic: { max_lines: 1_000_000, max_adjacent_methods: 1_000_000 },
    } as unknown as Record<string, unknown>)
    assert.ok(errors.some((e) => e.includes('max_rounds')))
    assert.ok(errors.some((e) => e.includes('atomic.max_lines')))
    assert.ok(errors.some((e) => e.includes('atomic.max_adjacent_methods')))
    // The valid boundary values are still accepted.
    assert.deepEqual(
      validateConfigUpdates({ max_rounds: 100, atomic: { max_lines: 10000, max_adjacent_methods: 200 } }),
      [],
    )
  })

  it('rejects a malformed observatory block', () => {
    assert.ok(validateConfigUpdates({ observatory: 'x' }).some((e) => e.includes('observatory')))
    assert.ok(validateConfigUpdates({ observatory: { capture: 'yes' } }).some((e) => e.includes('observatory.capture')))
    assert.ok(validateConfigUpdates({ observatory: { approval: 'ask', capture: false } }).some((e) => e.includes('observatory.approval')))
  })

  it('rejects unknown top-level keys with a structured error', () => {
    // Unknown keys used to be merged straight into iterate.config.yaml, where
    // they persisted forever and were never read by anything (a typo such as
    // `maxRounds` silently became "config").
    const errors = validateConfigUpdates({
      maxRounds: 5,
      task_mode: 'iterate',
      validation: { command_whitelist: [] },
    } as unknown as Record<string, unknown>)
    assert.ok(errors.some((e) => e.includes('updates.maxRounds')), `got: ${errors.join('; ')}`)
    assert.ok(errors.some((e) => e.includes('updates.task_mode')), `got: ${errors.join('; ')}`)
    const unknown = errors.filter((e) => e.includes('not a supported config key'))
    assert.equal(unknown.length, 2, `expected exactly the 2 unknown keys to be flagged: ${errors.join('; ')}`)
    // The error tells the caller what IS accepted.
    assert.match(unknown[0]!, /supported: .*goal/)
    // A known key in the same update is not misreported.
    assert.equal(errors.some((e) => e.includes('updates.validation')), false)
  })

  it('accepts every supported key when its value is well-formed', () => {
    const errors = validateConfigUpdates({
      goal: 'g',
      language: 'en',
      dimensions: ['correctness'],
      max_rounds: 5,
      reasoning_effort: 'high',
      review: { scope: 'full' },
      reviewer: { scope_chunk_size: 10 },
      atomic: { max_lines: 20 },
      git: { use_worktree: false },
      validation: { command_whitelist: [] },
      observatory: { capture: false },
      personalization: {},
      onboarding: {},
    })
    assert.deepEqual(errors, [], errors.join('; '))
  })

  it('validates the reviewer section: gate booleans must be booleans', () => {
    // M2: a write path without a `reviewer` branch let
    // `reviewer: {evidence_validation: "yes"}` (or the value `false` in a
    // malformed shape) through unvalidated — the reviewer gates are policy.
    const errors = validateConfigUpdates({
      reviewer: {
        evidence_validation: 'yes',
        coverage_validation: 1,
        output_schema_validation: 'false',
        scope_chunk_size: 1_000_000,
      },
    } as unknown as Record<string, unknown>)
    assert.ok(errors.some((e) => e.includes('reviewer.evidence_validation')), errors.join('; '))
    assert.ok(errors.some((e) => e.includes('reviewer.coverage_validation')), errors.join('; '))
    assert.ok(errors.some((e) => e.includes('reviewer.output_schema_validation')), errors.join('; '))
    assert.ok(errors.some((e) => e.includes('reviewer.scope_chunk_size')), errors.join('; '))

    // A reviewer that is not an object at all (array/scalar) is refused…
    assert.ok(validateConfigUpdates({ reviewer: [] as unknown as Record<string, unknown> }).some((e) => e.includes('reviewer')))
    assert.ok(validateConfigUpdates({ reviewer: 'on' as unknown as Record<string, unknown> }).some((e) => e.includes('reviewer')))
    // …while well-formed gates (including `false`, which is legal config —
    // the approval prompt warns about it) are accepted.
    assert.deepEqual(
      validateConfigUpdates({ reviewer: { evidence_validation: false, coverage_validation: true, scope_chunk_size: 1 } }),
      [],
    )
  })

  it('bounds reasoning_effort to the provider enum', () => {
    assert.deepEqual(validateConfigUpdates({ reasoning_effort: 'low' }), [])
    assert.deepEqual(validateConfigUpdates({ reasoning_effort: 'medium' }), [])
    assert.deepEqual(validateConfigUpdates({ reasoning_effort: 'high' }), [])
    for (const bad of ['ultra', 'MAXIMUM', 4, {}]) {
      const errors = validateConfigUpdates({ reasoning_effort: bad } as unknown as Record<string, unknown>)
      assert.ok(
        errors.some((e) => e.includes('reasoning_effort')),
        `reasoning_effort=${JSON.stringify(bad)} must be rejected: ${errors.join('; ')}`,
      )
    }
  })

  it('refuses an empty dimensions list (it validated clean and meant "review nothing")', () => {
    const errors = validateConfigUpdates({ dimensions: [] })
    assert.ok(errors.some((e) => e.includes('dimensions')), errors.join('; '))
    assert.match(errors.join('; '), /non-empty/)
    // Whitespace-only entries are equally meaningless.
    assert.ok(validateConfigUpdates({ dimensions: ['  '] }).some((e) => e.includes('dimensions')))
    assert.deepEqual(validateConfigUpdates({ dimensions: ['correctness'] }), [])
  })

  it('refuses validation.commands as an ARRAY (flattenCommands would drop it all)', () => {
    // `typeof [] === 'object'` used to let `commands: ["npm t"]` validate
    // clean; flattenCommands then discarded every entry — an allow-list that
    // read as configured while matching nothing.
    const asArray = validateConfigUpdates({ validation: { commands: ['npm t'] } } as unknown as Record<string, unknown>)
    assert.ok(asArray.some((e) => e.includes('validation.commands')), asArray.join('; '))
    assert.match(asArray.join('; '), /mapping/)
    // Values must be string arrays too.
    const badValues = validateConfigUpdates({
      validation: { commands: { 'src/a.ts': [42] } },
    } as unknown as Record<string, unknown>)
    assert.ok(badValues.some((e) => e.includes('validation.commands')), badValues.join('; '))
    // The real shape passes.
    assert.deepEqual(validateConfigUpdates({ validation: { commands: { 'src/a.ts': ['npm t'] } } }), [])
  })
})

// ─── applyConfigUpdates ──────────────────────────────────────────────────────

describe('applyConfigUpdates', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const base = { goal: 'g', dimensions: ['a', 'b'], atomic: { max_lines: 20 }, git: { use_worktree: false } }
    const next = applyConfigUpdates(base, {
      dimensions: ['a'],
      atomic: { max_lines: 40 },
    })
    assert.deepEqual(next.dimensions, ['a'])
    assert.deepEqual(next.atomic, { max_lines: 40 })
    assert.equal((next.git as { use_worktree: boolean }).use_worktree, false)
  })

  it('skips undefined values and does not mutate the base', () => {
    const base = { goal: 'g' }
    const snapshot = JSON.stringify(base)
    const next = applyConfigUpdates(base, { goal: undefined, max_rounds: 3 })
    assert.equal(next.goal, 'g')
    assert.equal(next.max_rounds, 3)
    assert.equal(JSON.stringify(base), snapshot)
  })

  it('refuses prototype-pollution keys', () => {
    // A JSON-parsed update can carry `__proto__` / `constructor` / `prototype`
    // as own keys; they must never be plain-assigned onto the merged config.
    const base = { goal: 'g', safe: true }
    const poison = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "prototype": {"y": 2}, "goal": "h"}')
    const next = applyConfigUpdates(base, poison as Record<string, unknown>)
    assert.equal(next.goal, 'h')
    // The merged config's prototype is untouched (not polluted).
    assert.equal((Object.getPrototypeOf(next) as Record<string, unknown>).polluted, undefined)
    // None of the pollution keys landed as own enumerable properties.
    assert.equal(Object.prototype.hasOwnProperty.call(next, '__proto__'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(next, 'constructor'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(next, 'prototype'), false)
    // base is untouched.
    assert.equal(base.goal, 'g')
  })
})

// ─── readRawConfig / writeConfigFile ─────────────────────────────────────────

describe('readRawConfig / writeConfigFile', () => {
  it('readRawConfig returns {} for a missing file', () => {
    const { dir, cleanup } = tempProject()
    try {
      assert.deepEqual(readRawConfig(join(dir, CONFIG_FILE)), {})
    } finally {
      cleanup()
    }
  })

  it('readRawConfig throws on an unparsable config', () => {
    const { dir, cleanup } = tempProject('goal: [unclosed')
    try {
      assert.throws(() => readRawConfig(join(dir, CONFIG_FILE)), /not a valid YAML mapping/)
    } finally {
      cleanup()
    }
  })

  it('readRawConfig refuses a YAML array root (list config bomb)', () => {
    // `- goal: "g"` parses as a sequence, not a mapping — writing over it
    // would destroy data, so the read must reject it like any malformed file.
    const { dir, cleanup } = tempProject('- goal: "g"')
    try {
      assert.throws(() => readRawConfig(join(dir, CONFIG_FILE)), /not a valid YAML mapping/)
    } finally {
      cleanup()
    }
  })

  it('writeConfigFile creates a new file without a backup', () => {
    const { dir, cleanup } = tempProject()
    try {
      const res = writeConfigFile(dir, { goal: 'g' })
      assert.equal(res.ok, true)
      if (res.ok) assert.equal(res.backupPath, null)
      assert.equal(existsSync(join(dir, CONFIG_FILE)), true)
    } finally {
      cleanup()
    }
  })

  it('writeConfigFile backs up an existing file before overwriting', () => {
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const res = writeConfigFile(dir, { goal: 'new' })
      assert.equal(res.ok, true) // narrows res to the ok:true member (assert/strict has an asserts signature)
      assert.ok(res.backupPath)
      assert.equal(readFileSync(res.backupPath, 'utf-8'), MINIMAL_CONFIG)
      const backups = readdirSync(dir).filter((f) => f.startsWith('iterate.config.yaml.bak-'))
      assert.equal(backups.length, 1)
    } finally {
      cleanup()
    }
  })

  it('bounds the accumulated backup pile after many successful writes', () => {
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      for (let i = 0; i < 12; i += 1) {
        const res = writeConfigFile(dir, { goal: `g${i}` })
        assert.equal(res.ok, true)
      }
      const backups = readdirSync(dir).filter((f) => f.startsWith('iterate.config.yaml.bak-'))
      // Every write keeps at most MAX_CONFIG_BACKUPS snapshots — a long-lived
      // project never collects an unbounded pile of config backups.
      assert.ok(backups.length <= 5, `expected ≤ 5 backups, got ${backups.length}`)
      const newest = backups.slice().sort().at(-1)
      assert.ok(newest, 'at least one backup exists')
    } finally {
      cleanup()
    }
  })

  it('writeConfigFile restores the original file when serialization fails', () => {
    // The write path is atomic: a config the YAML dumper cannot serialize
    // throws BEFORE the temp file is written, so the target keeps its original
    // bytes and the backup copy made a moment earlier is restored over it.
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const before = readFileSync(join(dir, CONFIG_FILE), 'utf-8')
      const unserializable: Record<string, unknown> = { goal: 'g' }
      Object.defineProperty(unserializable, 'boom', {
        enumerable: true,
        get() { throw new Error('unserializable') },
      })
      const res = writeConfigFile(dir, unserializable)
      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.match(res.error, /failed to write config/)
        assert.ok(!res.error.includes('rollback also failed'), `rollback should succeed: ${res.error}`)
      }
      // We really did get past the backup step into the write-failure branch.
      assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 1)
      // The target was never modified and never left half-written.
      assert.equal(readFileSync(join(dir, CONFIG_FILE), 'utf-8'), before)
    } finally {
      cleanup()
    }
  })

  it('writeConfigFile reports when the rollback itself also fails', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root ignores file modes — the rollback cannot be made to fail')
      return
    }
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const configPath = join(dir, CONFIG_FILE)
      // Read-only target: the backup copy (a read) succeeds, serialization
      // throws, and the restoring copy is denied by the mode → the failure of
      // the failure path is surfaced instead of being swallowed silently.
      chmodSync(configPath, 0o444)
      const unserializable: Record<string, unknown> = { goal: 'g' }
      Object.defineProperty(unserializable, 'boom', {
        enumerable: true,
        get() { throw new Error('unserializable') },
      })
      const res = writeConfigFile(dir, unserializable)
      assert.equal(res.ok, false)
      if (!res.ok) {
        assert.match(res.error, /failed to write config/)
        assert.match(res.error, /rollback also failed/)
      }
      assert.equal(readFileSync(configPath, 'utf-8'), MINIMAL_CONFIG)
    } finally {
      chmodSync(join(dir, CONFIG_FILE), 0o644)
      cleanup()
    }
  })

  it('writeConfigFile fails before touching anything when the backup cannot be made', () => {
    // `iterate.config.yaml` existing as a DIRECTORY: the backup copy fails, so
    // the write must bail out with a backup error rather than proceed to
    // replace the path (and there is nothing to roll back yet).
    const { dir, cleanup } = tempProject()
    try {
      mkdirSync(join(dir, CONFIG_FILE))
      const res = writeConfigFile(dir, { goal: 'g' })
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.error, /failed to create backup/)
      assert.ok(existsSync(join(dir, CONFIG_FILE)), 'the directory must be left in place')
    } finally {
      cleanup()
    }
  })
})

// ─── End-to-end iterate_config write operation ───────────────────────────────

describe('iterate_config write operation', () => {
  it('merges a valid partial update into an existing config with a backup', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { goal: 'new goal', max_rounds: 5 },
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.operation, 'write')
      assert.ok(String(res.backupPath).includes('.bak-'))

      const cfg = res.config as Record<string, unknown>
      assert.equal(cfg.goal, 'new goal')
      assert.equal(cfg.max_rounds, 5)
      assert.deepEqual(cfg.dimensions, ['correctness'])
    } finally {
      cleanup()
    }
  })

  it('creates a config from scratch when none exists', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: {
          goal: 'g',
          dimensions: ['correctness', 'security'],
          validation: { command_whitelist: [], commands: {} },
        },
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.backupPath, null)
      const parsed = yaml.load(readFileSync(join(dir, CONFIG_FILE), 'utf-8')) as Record<string, unknown>
      assert.equal(parsed.goal, 'g')
    } finally {
      cleanup()
    }
  })

  it('accepts a PARTIAL update on a fresh project by merging built-in defaults', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject()
    try {
      // A bare `{max_rounds: 5}` must not fail schema validation with a
      // misleading "missing goal" — the write merges against the defaults so
      // the documented partial-update contract works out of the box.
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { max_rounds: 5 },
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.error, undefined)
      assert.equal(res.backupPath, null)
      const parsed = yaml.load(readFileSync(join(dir, CONFIG_FILE), 'utf-8')) as Record<string, unknown>
      assert.equal(parsed.max_rounds, 5)
      // Defaults were materialized so the file is a complete, valid config.
      assert.equal(typeof parsed.goal, 'string')
      assert.ok(Array.isArray(parsed.dimensions))
      assert.equal(typeof parsed.validation, 'object')
    } finally {
      cleanup()
    }
  })

  it('rejects an invalid update without writing', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    const before = readFileSync(join(dir, CONFIG_FILE), 'utf-8')
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { goal: 42, dimensions: [''] },
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.ok(Array.isArray(res.errors))
      assert.equal(readFileSync(join(dir, CONFIG_FILE), 'utf-8'), before)
      assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0)
    } finally {
      cleanup()
    }
  })

  it('refuses an unknown update key without writing', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    const before = readFileSync(join(dir, CONFIG_FILE), 'utf-8')
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { maxRounds: 5 },
      } as unknown as Record<string, unknown>)) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.ok(Array.isArray(res.errors))
      assert.ok(
        (res.errors as string[]).some((e) => e.includes('maxRounds')),
        `expected a structured unknown-key error: ${JSON.stringify(res.errors)}`,
      )
      // Nothing on disk changed — no stray key, no backup.
      assert.equal(readFileSync(join(dir, CONFIG_FILE), 'utf-8'), before)
      assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0)
    } finally {
      cleanup()
    }
  })

  it('refuses to write over an unparsable config', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const malformed = 'goal: [unclosed'
    const { dir, cleanup } = tempProject(malformed)
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { goal: 'g' },
      })) as Record<string, unknown>
      assert.equal(res.ok, false)
      assert.match(String(res.error), /failed to read config/)
      assert.equal(readFileSync(join(dir, CONFIG_FILE), 'utf-8'), malformed)
    } finally {
      cleanup()
    }
  })

  it('still supports read operations', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const res = (await configTool({ path: dir, section: 'dimensions' })) as Record<string, unknown>
      assert.equal(res.section, 'dimensions')
      assert.deepEqual(res.data, ['correctness'])
    } finally {
      cleanup()
    }
  })
})
