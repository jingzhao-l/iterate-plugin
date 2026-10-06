import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  defaultConfig,
  flattenCommands,
  isCommandAllowed,
  loadConfig,
  loadEffectiveConfig,
  mergeConfig,
  resolveProjectRoot,
  resolveProjectRootForExec,
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

  it('loadConfig rejects a YAML array root (list config bomb)', () => {
    const { dir, cleanup } = tempDir()
    try {
      // `- goal: x` is a sequence — coercing it to a config object would
      // merge its indices into the config (an effective bomb).
      writeConfig(dir, '- goal: "x"\n- goal: "y"\n')
      assert.equal(loadConfig(dir), null)
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

  it('reports root for a YAML-array-shaped config (never coerces)', () => {
    // typeof [] === 'object', so without the guard this would produce nested
    // "goals" instead of failing closed.
    assert.deepEqual(validateConfig([] as unknown as IterateConfig), ['root'])
    assert.deepEqual(validateConfig('text' as unknown as IterateConfig), ['root'])
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

  // ── STRICT checks: a PRESENT field must be well-formed ────────────────────
  // (YAML has no schema — the old validator only checked that goal/dimensions/
  //  validation were present, so `max_rounds: "ten"` or
  //  `reviewer: {evidence_validation: "yes"}` passed untouched.)

  it('bounds max_rounds to the config-bomb guard (1..100)', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    assert.deepEqual(validateConfig({ ...base, max_rounds: 100 }), [])
    assert.deepEqual(validateConfig({ ...base, max_rounds: 1 }), [])
    for (const bad of [101, 1_000_000, 0, -1, 2.5, 'ten', null]) {
      const errors = validateConfig({ ...base, max_rounds: bad })
      assert.ok(
        errors.some((e) => e.startsWith('max_rounds')),
        `max_rounds=${JSON.stringify(bad)} must be rejected: ${errors.join('; ')}`,
      )
    }
  })

  it('bounds atomic.max_lines / atomic.max_adjacent_methods', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    assert.deepEqual(validateConfig({ ...base, atomic: { max_lines: 10_000, max_adjacent_methods: 0 } }), [])
    for (const bad of [10_001, 0, -5, 1.5, 'many']) {
      const errors = validateConfig({ ...base, atomic: { max_lines: bad, max_adjacent_methods: 0 } })
      assert.ok(
        errors.some((e) => e.startsWith('atomic.max_lines')),
        `atomic.max_lines=${JSON.stringify(bad)} must be rejected: ${errors.join('; ')}`,
      )
    }
    for (const bad of [201, -1, 'five']) {
      const errors = validateConfig({
        ...base,
        atomic: { max_lines: 10, max_adjacent_methods: bad },
      })
      assert.ok(
        errors.some((e) => e.startsWith('atomic.max_adjacent_methods')),
        `atomic.max_adjacent_methods=${JSON.stringify(bad)} must be rejected: ${errors.join('; ')}`,
      )
    }
  })

  it('validates review.scope and language enums', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    assert.deepEqual(validateConfig({ ...base, review: { scope: 'changed-only' } }), [])
    assert.ok(validateConfig({ ...base, review: { scope: 'everything' } }).some((e) => e.includes('review.scope')))
    assert.ok(validateConfig({ ...base, language: 'fr' }).some((e) => e.includes('language')))
    assert.deepEqual(validateConfig({ ...base, language: 'zh' }), [])
  })

  it('validates git boolean fields and target_branch', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    assert.deepEqual(
      validateConfig({
        ...base,
        git: { target_branch: 'main', use_worktree: true, push_per_round: false, auto_merge: false },
      }),
      [],
    )
    for (const key of ['use_worktree', 'push_per_round', 'auto_merge'] as const) {
      const errors = validateConfig({ ...base, git: { ...base.git as object, [key]: 'yes' } })
      assert.ok(
        errors.some((e) => e.includes(`git.${key}`)),
        `git.${key}="yes" must be rejected: ${errors.join('; ')}`,
      )
    }
    const emptyBranch = validateConfig({ ...base, git: { ...base.git as object, target_branch: '' } })
    assert.ok(emptyBranch.some((e) => e.includes('git.target_branch')))
  })

  it('validates reviewer gate booleans and scope_chunk_size', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    for (const key of ['output_schema_validation', 'evidence_validation', 'coverage_validation'] as const) {
      const errors = validateConfig({ ...base, reviewer: { ...base.reviewer as object, [key]: 'no' } })
      assert.ok(
        errors.some((e) => e.includes(`reviewer.${key}`)),
        `reviewer.${key}="no" must be rejected: ${errors.join('; ')}`,
      )
    }
    // `false` is legal config (the approval prompt warns on write) — only the
    // TYPE is checked.
    assert.deepEqual(
      validateConfig({
        ...base,
        reviewer: { output_schema_validation: false, evidence_validation: false, coverage_validation: true, scope_chunk_size: 50 },
      }),
      [],
    )
    for (const bad of [0, 1001, 'ten']) {
      const errors = validateConfig({ ...base, reviewer: { ...base.reviewer as object, scope_chunk_size: bad } })
      assert.ok(
        errors.some((e) => e.includes('reviewer.scope_chunk_size')),
        `scope_chunk_size=${JSON.stringify(bad)} must be rejected: ${errors.join('; ')}`,
      )
    }
  })

  it('validates reasoning_effort and observatory enums/booleans', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    assert.deepEqual(validateConfig({ ...base, reasoning_effort: 'high' }), [])
    assert.deepEqual(validateConfig({ ...base, reasoning_effort: undefined }), [])
    assert.ok(
      validateConfig({ ...base, reasoning_effort: 'ultra' }).some((e) => e.includes('reasoning_effort')),
    )
    assert.ok(
      validateConfig({ ...base, reasoning_effort: 4 }).some((e) => e.includes('reasoning_effort')),
    )
    assert.deepEqual(validateConfig({ ...base, observatory: { capture: true, approval: 'deny' } }), [])
    assert.ok(
      validateConfig({ ...base, observatory: { capture: 'yes' } }).some((e) => e.includes('observatory.capture')),
    )
    assert.ok(
      validateConfig({ ...base, observatory: { approval: 'always' } }).some((e) => e.includes('observatory.approval')),
    )
  })

  it('requires dimensions to be a NON-EMPTY list of non-empty strings', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    const empty = validateConfig({ ...base, dimensions: [] })
    assert.ok(empty.some((e) => e.includes('dimensions')), empty.join('; '))
    assert.match(empty.join('; '), /non-empty/)
    assert.ok(validateConfig({ ...base, dimensions: [''] }).some((e) => e.includes('dimensions')))
    assert.ok(validateConfig({ ...base, dimensions: ['ok', 7] }).some((e) => e.includes('dimensions')))
    assert.deepEqual(validateConfig({ ...base, dimensions: ['correctness'] }), [])
    // A non-array scalar still reports the bare `dimensions` path.
    assert.ok(validateConfig({ ...base, dimensions: 'all' }).includes('dimensions'))
  })

  it('requires validation.commands to be a mapping of module → string[]', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    // The ARRAY shape must be refused: `typeof [] === 'object'` used to let it
    // through, and flattenCommands then dropped every entry (a whitelist that
    // read as configured while matching nothing).
    const asArray = validateConfig({ ...base, validation: { command_whitelist: [], commands: ['npm t'] } })
    assert.ok(asArray.some((e) => e.includes('validation.commands')), asArray.join('; '))
    const badValues = validateConfig({
      ...base,
      validation: { command_whitelist: [], commands: { 'src/a.ts': 'npm t' } },
    })
    assert.ok(badValues.some((e) => e.includes('validation.commands')), badValues.join('; '))
    const good = validateConfig({
      ...base,
      validation: { command_whitelist: ['npm test'], commands: { 'package.json': ['npm test'] } },
    })
    assert.deepEqual(good, [], good.join('; '))
    // command_whitelist entries must be strings.
    const badWhitelist = validateConfig({ ...base, validation: { command_whitelist: [1], commands: {} } })
    assert.ok(badWhitelist.some((e) => e.includes('validation.command_whitelist')), badWhitelist.join('; '))
  })

  it('rejects unknown top-level keys instead of silently ignoring them', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    const errors = validateConfig({ ...base, maxRounds: 5, task_mode: 'iterate' })
    const unknown = errors.filter((e) => e.includes('is not a supported config key'))
    assert.equal(unknown.length, 2, `expected both unknown keys flagged: ${errors.join('; ')}`)
    assert.match(unknown[0]!, /maxRounds|task_mode/)
    assert.deepEqual(validateConfig(base), [])
  })

  it('refuses a section that is a YAML sequence (typeof [] === "object")', () => {
    const base = { ...defaultConfig(), goal: 'g' } as unknown as Record<string, unknown>
    for (const key of ['review', 'reviewer', 'atomic', 'git', 'validation', 'observatory']) {
      const errors = validateConfig({ ...base, [key]: [] })
      assert.ok(
        errors.includes(key),
        `${key}: [] must be reported as an invalid section: ${errors.join('; ')}`,
      )
    }
  })
})

describe('resolveProjectRoot', () => {
  it('resolves a caller-supplied absolute path to its real location', () => {
    const { dir } = tempDir()
    const res = resolveProjectRoot(dir)
    assert.equal(res.ok, true)
    // Symlinks are collapsed so two aliases of the same project share one
    // .iterate/ state: on macOS /var -> /private/var, so the tmpdir above may
    // be rewritten to its real path even though the caller passed a plain path.
    if (res.ok) assert.equal(res.root, realpathSync(dir))
  })

  it('falls back to the current working directory when path is empty', () => {
    const res = resolveProjectRoot('')
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, process.cwd())
  })

  it('refuses the filesystem root to block path-traversal escapes', () => {
    const res = resolveProjectRoot('/')
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.reason, /root/i)
  })

  it('collapses traversal that resolves up to the filesystem root', () => {
    // '/etc/../../..' normalizes to '/', which must be refused.
    const res = resolveProjectRoot('/etc/../../..')
    assert.equal(res.ok, false)
  })

  it('treats a non-string path input as "no explicit path" (never crashes)', () => {
    // A hostile/hand-rolled call can pass a number or array — the resolver
    // must fall back to cwd instead of throwing on `.trim()`.
    const res = resolveProjectRoot(123 as unknown as string)
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, process.cwd())
    const arr = resolveProjectRoot(['/tmp'] as unknown as string)
    assert.equal(arr.ok, true)
    if (arr.ok) assert.equal(arr.root, process.cwd())
  })
})

describe('resolveProjectRootForExec', () => {
  it('takes the explicit path when present', () => {
    const { dir } = tempDir()
    const exec = { agent: { session: { header: { cwd: '/elsewhere' } } } }
    const res = resolveProjectRootForExec(exec, dir)
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, realpathSync(dir))
  })

  it('falls back to the session cwd when no path is given', () => {
    const { dir } = tempDir()
    const exec = { agent: { session: { header: { cwd: dir } } } }
    const res = resolveProjectRootForExec(exec)
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, realpathSync(dir))
  })

  it('never crashes on a null/empty exec', () => {
    const res = resolveProjectRootForExec(undefined)
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, process.cwd())
    const res2 = resolveProjectRootForExec({})
    assert.equal(res2.ok, true)
    if (res2.ok) assert.equal(res2.root, process.cwd())
  })
})

describe('session cwd rooted in the home directory', () => {
  it('honors homedir() as the session cwd instead of substituting the server cwd', () => {
    // Regression: `sessionCwd === homedir()` used to be discarded, so tools
    // fell back to the SERVER's cwd and read/wrote `.iterate` in the wrong
    // project. A session legitimately rooted at ~ must be honored.
    const res = resolveProjectRoot(undefined, homedir())
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.root, realpathSync(homedir()))
    // …and it must NOT have silently returned the process cwd.
    if (res.ok) assert.notEqual(res.root, process.cwd())
  })
})

describe('resolveProjectRoot — session-anchored containment (tier a)', () => {
  it('accepts the session cwd itself and directories inside it', () => {
    const { dir, cleanup } = tempDir()
    try {
      const sub = join(dir, 'packages', 'app')
      mkdirSync(sub, { recursive: true })
      const self = resolveProjectRoot(dir, dir)
      assert.equal(self.ok, true)
      if (self.ok) assert.equal(self.root, realpathSync(dir))
      const inside = resolveProjectRoot(sub, dir)
      assert.equal(inside.ok, true)
      if (inside.ok) assert.equal(inside.root, realpathSync(sub))
    } finally {
      cleanup()
    }
  })

  it('refuses an explicit path outside the session cwd (sibling tree escape)', () => {
    const session = tempDir()
    const other = tempDir()
    try {
      const res = resolveProjectRoot(other.dir, session.dir)
      assert.equal(res.ok, false)
      // Structured failure — callers already short-circuit on { ok:false }.
      if (!res.ok) {
        assert.equal(typeof res.reason, 'string')
        assert.match(res.reason, /outside the session workspace/)
      }
      // A traversal that lands outside is refused even if it starts inside.
      const traverse = resolveProjectRoot(join(session.dir, '..', '..', 'elsewhere'), session.dir)
      assert.equal(traverse.ok, false)
    } finally {
      session.cleanup()
      other.cleanup()
    }
  })

  it('refuses a system path (/etc) even when a session cwd is known', () => {
    const { dir, cleanup } = tempDir()
    try {
      for (const p of ['/etc', '/etc/foo', '/usr']) {
        const res = resolveProjectRoot(p, dir)
        assert.equal(res.ok, false, `expected refusal for ${p}`)
      }
      // …while a session subdirectory still passes.
      assert.equal(resolveProjectRoot(dir, dir).ok, true)
    } finally {
      cleanup()
    }
  })

  it('is realpath-aware: a symlinked session cwd and its target agree', () => {
    const real = tempDir()
    const holder = tempDir()
    try {
      const link = join(holder.dir, 'link')
      symlinkSync(real.dir, link)
      // session cwd = symlink, path = real location (and vice versa).
      assert.equal(resolveProjectRoot(real.dir, link).ok, true)
      assert.equal(resolveProjectRoot(link, real.dir).ok, true)
      const notCreated = resolveProjectRoot(join(real.dir, 'new-pkg'), link)
      assert.equal(notCreated.ok, true)
      // The not-yet-created target keeps its LEXICAL path (documented) — the
      // containment check, not the returned root, is what got realpath'd.
      if (notCreated.ok) assert.equal(notCreated.root, join(real.dir, 'new-pkg'))
    } finally {
      real.cleanup()
      holder.cleanup()
    }
  })

  it('refuses a not-yet-created path reached through a symlinked parent', () => {
    // The tail doesn't exist (no whole-path realpath), so containment must
    // resolve the deepest EXISTING ancestor — otherwise "mkdir through this
    // link" would land outside the workspace unnoticed.
    const session = tempDir()
    const outside = tempDir()
    try {
      const esc = join(session.dir, 'esc')
      symlinkSync(outside.dir, esc)
      const res = resolveProjectRoot(join(esc, 'newdir'), session.dir)
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.reason, /outside the session workspace/)
      // A plain not-yet-created path INSIDE the workspace still passes.
      assert.equal(resolveProjectRoot(join(session.dir, 'newdir'), session.dir).ok, true)
    } finally {
      session.cleanup()
      outside.cleanup()
    }
  })

  it('falls back to the headless tier when the session cwd does not exist', () => {
    // A stale/bogus session header cannot bound containment — the tmpdir path
    // is then judged by the headless tier (allowed), not silently accepted
    // as an anchor for anything.
    const { dir, cleanup } = tempDir()
    try {
      const res = resolveProjectRoot(dir, '/no/such/session/cwd-xyz')
      assert.equal(res.ok, true)
      const escape = resolveProjectRoot('/etc', '/no/such/session/cwd-xyz')
      assert.equal(escape.ok, false)
    } finally {
      cleanup()
    }
  })
})

describe('resolveProjectRoot — headless system-path refusal (tier b)', () => {
  it('refuses the sensitive system roots and their direct children', () => {
    const refused = ['/', '/etc', '/etc/foo', '/usr', '/usr/local.conf', '/var/x', '/System', '/System/foo', '/private/etc', '/bin', '/sbin', '/proc/self']
    for (const p of refused) {
      const res = resolveProjectRoot(p)
      assert.equal(res.ok, false, `expected refusal for ${p}`)
      if (!res.ok) assert.match(res.reason, /refusing/i)
    }
  })

  it('refuses the bare home directory but allows paths inside it', () => {
    const home = resolveProjectRoot(homedir())
    assert.equal(home.ok, false)
    if (!home.ok) assert.match(home.reason, /home directory/i)
    // NOT paths inside home — `/Users/<me>/project` must remain allowed.
    const inner = resolveProjectRoot(join(homedir(), 'definitely-not-a-real-project-xyz'))
    assert.equal(inner.ok, true)
    if (inner.ok) assert.equal(inner.root, join(homedir(), 'definitely-not-a-real-project-xyz'))
  })

  it('allows transient tmpdir paths (the /private prefix must not swallow them)', () => {
    // macOS tmpdir lives at /private/var/folders/… — a naive "/private" prefix
    // rule would refuse every test's temp project; the direct-child rule must not.
    const dir = mkdtempSync(join(tmpdir(), 'tierb-tmp-'))
    try {
      const res = resolveProjectRoot(dir)
      assert.equal(res.ok, true)
      if (res.ok) assert.equal(res.root, realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadEffectiveConfig field coercion (schema-less YAML)', () => {
  it('max_rounds: "ten" falls back to the default instead of flowing downstream', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(dir, 'max_rounds: "ten"\n')
      const { config } = loadEffectiveConfig(dir)
      assert.equal(config.max_rounds, defaultConfig().max_rounds)
      assert.equal(typeof config.max_rounds, 'number')
    } finally {
      cleanup()
    }
  })

  it('dimensions: "all" falls back to the default dimension list', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(dir, 'dimensions: "all"\n')
      const { config } = loadEffectiveConfig(dir)
      assert.deepEqual(config.dimensions, defaultConfig().dimensions)
    } finally {
      cleanup()
    }
  })

  it('a garbage observatory.approval falls back to "ask" (the default)', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(dir, 'observatory:\n  approval: sometimes\n  capture: "no"\n')
      const { config } = loadEffectiveConfig(dir)
      assert.equal(config.observatory?.approval, 'ask')
      // Boolean field coerced the same way — garbage capture falls back to on.
      assert.equal(config.observatory?.capture, true)
    } finally {
      cleanup()
    }
  })

  it('valid overrides survive coercion untouched (positive control)', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(
        dir,
        'goal: "Ship it"\nmax_rounds: 3\nlanguage: zh\ndimensions:\n  - correctness\nreview:\n  scope: changed-only\nobservatory:\n  capture: false\n  approval: deny\n',
      )
      const { config } = loadEffectiveConfig(dir)
      assert.equal(config.goal, 'Ship it')
      assert.equal(config.max_rounds, 3)
      assert.equal(config.language, 'zh')
      assert.deepEqual(config.dimensions, ['correctness'])
      assert.equal(config.review.scope, 'changed-only')
      assert.equal(config.observatory?.capture, false)
      assert.equal(config.observatory?.approval, 'deny')
    } finally {
      cleanup()
    }
  })

  it('a scalar section override is restored to the default section object', () => {
    const { dir, cleanup } = tempDir()
    try {
      // `review: "full"` wholesale-replaces the default section during the
      // merge — consumers reading `config.review.scope` must not see undefined.
      writeConfig(dir, 'review: "full"\nvalidation: 42\n')
      const { config } = loadEffectiveConfig(dir)
      assert.deepEqual(config.review, { scope: 'full' })
      assert.deepEqual(config.validation, defaultConfig().validation)
    } finally {
      cleanup()
    }
  })

  it('drops an invalid reasoning_effort (absent = provider default) and repairs bad commands', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeConfig(dir, 'reasoning_effort: "extreme"\nvalidation:\n  commands:\n    python: "not-an-array"\n')
      const { config } = loadEffectiveConfig(dir)
      assert.equal(config.reasoning_effort, undefined)
      // A malformed allow-list entry falls back to the default (empty) so a
      // garbage shape can never smuggle a command into the runtime allow-list.
      assert.deepEqual(config.validation.commands, {})
    } finally {
      cleanup()
    }
  })
})

describe('effectiveCwd — DSH_SESSION_JSONL workspace decoding', () => {
  /** The documented workspace encoding: `--`-wrapped, `/` and special bytes
   *  percent-spelled as `~<hex>` (e.g. `…~2f…`, `…~20…`). */
  function encodeWorkspace(p: string): string {
    return '--' + p.slice(1).replace(/\//g, '~2f').replace(/ /g, '~20') + '--'
  }

  /** Run `body` with an unusable process cwd (`/`) and the given session env. */
  function withCwdAtRoot<T>(env: string | undefined, body: () => T): T {
    const savedCwd = process.cwd()
    const savedEnv = process.env.DSH_SESSION_JSONL
    try {
      process.chdir('/')
      if (env === undefined) delete process.env.DSH_SESSION_JSONL
      else process.env.DSH_SESSION_JSONL = env
      return body()
    } finally {
      process.chdir(savedCwd)
      if (savedEnv === undefined) delete process.env.DSH_SESSION_JSONL
      else process.env.DSH_SESSION_JSONL = savedEnv
    }
  }

  it('decodes a crafted session workspace ( --wrap + ~<hex> percent spelling)', () => {
    const base = mkdtempSync(join(tmpdir(), 'abc'))
    const workspace = join(base, 'sub dir') // exercises `~20`
    mkdirSync(workspace)
    try {
      withCwdAtRoot(
        `/x/sessions/${encodeWorkspace(workspace)}/sess-1/session.jsonl.zstd`,
        () => {
          const res = resolveProjectRoot('')
          assert.equal(res.ok, true)
          if (res.ok) assert.equal(res.root, realpathSync(workspace))
        },
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('falls back to the cwd when the env var is missing', () => {
    withCwdAtRoot(undefined, () => {
      // No session workspace to decode → effectiveCwd returns the process cwd
      // (`/` here), which the resolver then refuses like any filesystem root.
      const res = resolveProjectRoot('')
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.reason, /root/i)
    })
  })

  it('falls back to the cwd when the encoding is malformed (never throws)', () => {
    withCwdAtRoot('/x/sessions/--~zz--/sess-1/session.jsonl.zstd', () => {
      // `%zz` after the ~→% spelling is an invalid percent-escape;
      // decodeURIComponent throws and the resolver must degrade to the cwd.
      const res = resolveProjectRoot('')
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.reason, /root/i)
    })
  })

  it('a dash-style workspace that does not round-trip falls back to the cwd', () => {
    // The encoder maps `/` → `-`, but decoding cannot restore slashes from
    // dashes — a nonexistent candidate must fall through, not be trusted.
    withCwdAtRoot('/x/sessions/--somewhere-else--/sess-1/session.jsonl.zstd', () => {
      const res = resolveProjectRoot('')
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.reason, /root/i)
    })
  })
})

describe('.iterate symlink containment (minor 10)', () => {
  it('refuses a project root whose .iterate escapes the tree via a symlink', () => {
    const { dir, cleanup } = tempDir()
    const outside = mkdtempSync(join(tmpdir(), 'iterate-iterate-escape-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      symlinkSync(outside, join(dir, '.iterate'))
      const res = resolveProjectRoot(dir)
      assert.equal(res.ok, false, 'state written through a symlinked .iterate would leave the project')
      if (!res.ok) {
        assert.match(res.reason, /\.iterate/)
        assert.match(res.reason, /symlink escape/)
      }
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts a real .iterate and a .iterate symlink that stays inside the project', () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      assert.equal(resolveProjectRoot(dir).ok, true, 'a plain .iterate dir is the normal case')

      rmSync(join(dir, '.iterate'), { recursive: true, force: true })
      mkdirSync(join(dir, 'state'), { recursive: true })
      symlinkSync(join(dir, 'state'), join(dir, '.iterate'))
      const res = resolveProjectRoot(dir)
      assert.equal(res.ok, true, 'a link that realpaths inside the root keeps artifacts in the tree')
      if (res.ok) assert.equal(res.root, realpathSync(dir))
    } finally {
      cleanup()
    }
  })

  it('a dangling .iterate link is not followed (resolution keeps working, mkdir will fail later)', () => {
    const { dir, cleanup } = tempDir()
    try {
      symlinkSync(join(dir, 'never-created-state'), join(dir, '.iterate'))
      const res = resolveProjectRoot(dir)
      assert.equal(res.ok, true)
    } finally {
      cleanup()
    }
  })
})
