import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  defaultConfig,
  flattenCommands,
  isCommandAllowed,
  loadConfig,
  loadEffectiveConfig,
  mergeConfig,
  validateConfig,
} from '../src/config-loader.ts'
import type { IterateConfig } from '../src/types.ts'

/** Create a temp project dir and return a cleanup fn. */
function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-config-test-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, 'iterate.config.yaml'), content, 'utf-8')
}

describe('defaultConfig', () => {
  it('provides every required field with sensible defaults', () => {
    const c = defaultConfig()
    assert.ok(c.goal.length > 0)
    assert.equal(typeof c.max_rounds, 'number')
    assert.ok(['zh', 'en'].includes(c.language))
    assert.ok(Array.isArray(c.dimensions) && c.dimensions.length > 0)
    assert.deepEqual(c.review, { scope: 'full' })
    assert.equal(c.atomic.max_lines, 20)
    assert.equal(c.git.target_branch, 'main')
    // Security: defaults configure NO trusted validation commands.
    assert.deepEqual(c.validation.command_whitelist, [])
    assert.deepEqual(c.validation.commands, {})
    assert.equal(c.reviewer.output_schema_validation, true)
  })
})

describe('mergeConfig', () => {
  it('fills missing keys from base without mutating inputs', () => {
    const base = { goal: 'g', atomic: { max_lines: 20, max_adjacent_methods: 3 } }
    const override = { goal: 'new goal' }
    const merged = mergeConfig(base, override)
    assert.equal(merged.goal, 'new goal')
    assert.deepEqual(merged.atomic, base.atomic)
    // The base input was not mutated.
    assert.equal(base.goal, 'g')
    assert.equal((base.atomic as { max_lines: number }).max_lines, 20)
  })

  it('merges nested objects recursively, arrays are replaced wholesale', () => {
    const base = {
      atomic: { max_lines: 20, max_adjacent_methods: 3 },
      dimensions: ['a', 'b'],
      validation: { command_whitelist: ['pytest'], commands: { python: ['pytest tests/'] } },
    }
    const override = {
      atomic: { max_lines: 50 }, // partial nested override
      dimensions: ['c'], // array override replaces entirely
      validation: { commands: { python: ['pytest tests/ -x'] } },
    }
    const merged = mergeConfig(base, override)
    assert.equal((merged.atomic as { max_lines: number }).max_lines, 50)
    assert.equal((merged.atomic as { max_adjacent_methods: number }).max_adjacent_methods, 3)
    assert.deepEqual(merged.dimensions, ['c'])
    // command_whitelist preserved from base; commands replaced by override
    const v = merged.validation as { command_whitelist: string[]; commands: Record<string, string[]> }
    assert.deepEqual(v.command_whitelist, ['pytest'])
    assert.deepEqual(v.commands, { python: ['pytest tests/ -x'] })
  })

  it('returns a shallow copy of base when override is undefined/null', () => {
    const base = { a: 1, nested: { b: 2 } }
    assert.deepEqual(mergeConfig(base, undefined), base)
    assert.deepEqual(mergeConfig(base, null as unknown as Record<string, unknown>), base)
  })
})

describe('loadConfig / loadEffectiveConfig', () => {
  it('loadConfig returns null for a directory without a config file', () => {
    const { dir, cleanup } = tempDir()
    try {
      assert.equal(loadConfig(dir), null)
    } finally {
      cleanup()
    }
  })

  it('loadConfig parses a valid YAML config', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(dir, 'goal: "Test goal"\ndimensions:\n  - correctness\n')
      const c = loadConfig(dir)
      assert.ok(c)
      assert.equal(c.goal, 'Test goal')
      assert.deepEqual(c.dimensions, ['correctness'])
    } finally {
      cleanup()
    }
  })

  it('loadEffectiveConfig returns defaults when no project config exists', () => {
    const { dir, cleanup } = tempDir()
    try {
      const { config, source, override } = loadEffectiveConfig(dir)
      assert.equal(source, 'defaults')
      assert.equal(override, null)
      assert.deepEqual(config.validation.commands, {})
      assert.ok(config.dimensions.length > 0)
    } finally {
      cleanup()
    }
  })

  it('loadEffectiveConfig merges partial overrides on top of defaults', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(
        dir,
        'goal: "Project goal"\ndimensions:\n  - correctness\nvalidation:\n  commands:\n    python:\n      - "pytest tests/ -x -q"\n',
      )
      const { config, source, override } = loadEffectiveConfig(dir)
      assert.equal(source, 'override')
      assert.ok(override)
      // Overridden fields win.
      assert.equal(config.goal, 'Project goal')
      assert.deepEqual(config.dimensions, ['correctness'])
      assert.deepEqual(config.validation.commands, { python: ['pytest tests/ -x -q'] })
      // Unmentioned fields fall back to defaults.
      assert.equal(config.max_rounds, defaultConfig().max_rounds)
      assert.equal(config.atomic.max_lines, 20)
      assert.equal(config.git.target_branch, 'main')
    } finally {
      cleanup()
    }
  })
})

describe('isCommandAllowed / flattenCommands', () => {
  it('isCommandAllowed requires an EXACT match after trim', () => {
    const allowed = ['pytest tests/ -x -q', 'npm run compile']
    assert.ok(isCommandAllowed('pytest tests/ -x -q', allowed))
    assert.ok(isCommandAllowed('  pytest tests/ -x -q  ', allowed)) // trims whitespace
    assert.ok(!isCommandAllowed('pytest', allowed)) // prefix is NOT enough
    assert.ok(!isCommandAllowed('pytest tests/ -x -q --extra', allowed)) // suffix not allowed
    assert.ok(!isCommandAllowed('python3 -c "import os; os.system(\'rm -rf /\')"', allowed))
    assert.ok(!isCommandAllowed('', allowed))
  })

  it('isCommandAllowed returns false for an empty command list', () => {
    assert.ok(!isCommandAllowed('pytest', []))
  })

  it('flattenCommands concatenates all module command arrays', () => {
    const commands = {
      python: ['pytest tests/ -x -q', 'ruff check src/'],
      typescript: ['npm run compile'],
    }
    assert.deepEqual(flattenCommands(commands), ['pytest tests/ -x -q', 'ruff check src/', 'npm run compile'])
  })

  it('flattenCommands handles undefined / empty / non-object input safely', () => {
    assert.deepEqual(flattenCommands(undefined), [])
    assert.deepEqual(flattenCommands({}), [])
    // Malformed config (a value that is not an array) is ignored, not a crash.
    assert.deepEqual(flattenCommands({ python: 'not-an-array' } as unknown as Record<string, string[]>), [])
  })
})

describe('validateConfig', () => {
  it('reports missing root when config is null', () => {
    assert.deepEqual(validateConfig(null), ['root'])
  })

  it('reports missing required fields', () => {
    const errors = validateConfig({})
    assert.ok(errors.includes('goal'))
    assert.ok(errors.includes('dimensions'))
    assert.ok(errors.includes('validation'))
  })

  it('passes a complete config', () => {
    const c: IterateConfig = {
      ...defaultConfig(),
      goal: 'g',
    }
    assert.deepEqual(validateConfig(c), [])
  })
})
