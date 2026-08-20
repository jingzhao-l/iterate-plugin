import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
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
