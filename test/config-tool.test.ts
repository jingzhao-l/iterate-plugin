import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerConfigTool } from '../src/tools/config.ts'

// ─── Test harness (mirrors config-write.test.ts; that file belongs to another
// agent, so the tool-level tests for config.ts live here) ────────────────────

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
  const dir = mkdtempSync(join(tmpdir(), 'iterate-config-tool-test-'))
  if (config !== undefined) writeFileSync(join(dir, 'iterate.config.yaml'), config, 'utf-8')
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

const CONFIG_FILE = 'iterate.config.yaml'

// ─── section reads must not resolve through the prototype chain ──────────────

describe('iterate_config section reads', () => {
  it('treats prototype-chain names (toString, constructor, __proto__) as missing sections', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      // `config["toString"]` / `config["constructor"]` resolve to FUNCTIONS via
      // the prototype chain (non-JSON → tool output error) and `config["__proto__"]`
      // returns Object.prototype — an "existing" section that serializes as {}.
      // Object.hasOwn pins the lookup to the config's own keys instead.
      for (const name of ['toString', 'constructor', '__proto__']) {
        const res = (await configTool({ path: dir, section: name })) as Record<string, unknown>
        assert.equal(res.found, true)
        assert.equal(res.data, undefined, `section "${name}" must not return data`)
        assert.equal(res.error, `Section "${name}" not found in config.`)
        assert.ok(Array.isArray(res.availableSections))
        assert.ok((res.availableSections as string[]).includes('goal'))
      }

      // A genuine own-property section still resolves normally.
      const ok = (await configTool({ path: dir, section: 'goal' })) as Record<string, unknown>
      assert.equal(ok.error, undefined)
      assert.equal(ok.data, 'g')
    } finally {
      cleanup()
    }
  })
})

// ─── write must refuse an empty update instead of re-dumping the file ────────

describe('iterate_config write with empty updates', () => {
  it('refuses missing, null, and empty updates without touching the file or backups', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const before = readFileSync(join(dir, CONFIG_FILE), 'utf-8')
      // Without updates there is nothing to merge: the write used to "succeed"
      // anyway, re-serializing the config and losing hand-written comments
      // while reporting ok:true plus a spurious backup.
      for (const updates of [undefined, null, {}] as const) {
        const args: Record<string, unknown> = { operation: 'write', path: dir }
        if (updates !== undefined) args.updates = updates
        const res = (await configTool(args)) as Record<string, unknown>
        assert.equal(res.ok, false, `updates=${JSON.stringify(updates)} must be refused`)
        assert.equal(res.error, 'updates is required (and must be non-empty) for operation "write"')
      }
      // No re-dump, no backup: the config file is byte-for-byte untouched.
      assert.equal(readFileSync(join(dir, CONFIG_FILE), 'utf-8'), before)
      assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0)
    } finally {
      cleanup()
    }
  })

  it('still applies a non-empty update', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const res = (await configTool({
        operation: 'write',
        path: dir,
        updates: { max_rounds: 7 },
      })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal((res.config as Record<string, unknown>).max_rounds, 7)
    } finally {
      cleanup()
    }
  })
})

// ─── validate must not report silent defaults as a valid file ────────────────

describe('iterate_config validate', () => {
  it('reports a well-formed config as valid with a validation report section', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject(MINIMAL_CONFIG)
    try {
      const res = (await configTool({ path: dir, validate: true })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.valid, true)
      assert.equal(res.errors, null)
      assert.equal(res.section, 'validation_report')
    } finally {
      cleanup()
    }
  })

  it('reports an unparsable config as invalid instead of validating the fallback defaults', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject('goal: [unclosed')
    try {
      // loadEffectiveConfig never throws: an unparsable file silently degrades
      // to the built-in defaults, which validate cleanly. Reporting
      // `valid: true` here would wave through the broken file, so the validate
      // branch re-reads the raw file and surfaces the parse failure.
      const res = (await configTool({ path: dir, validate: true })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.valid, false)
      assert.equal(res.section, 'validation_report')
      const errors = res.errors as string[]
      assert.ok(Array.isArray(errors) && errors.length > 0)
      assert.match(errors[0]!, /iterate\.config\.yaml is not usable/)
    } finally {
      cleanup()
    }
  })

  it('reports a YAML array root (list config) as invalid', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const { dir, cleanup } = tempProject('- goal: "g"')
    try {
      // A sequence root parses fine as YAML but is not a config mapping —
      // loadEffectiveConfig drops it to defaults just like a parse failure.
      const res = (await configTool({ path: dir, validate: true })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.valid, false)
      assert.match((res.errors as string[])[0]!, /iterate\.config\.yaml is not usable/)
    } finally {
      cleanup()
    }
  })

  it('treats a missing or whitespace-only config as valid defaults', async () => {
    const [configTool] = captureTools([registerConfigTool]) as [Tool]
    const missing = tempProject()
    const blank = tempProject('  \n\t\n')
    try {
      for (const { dir } of [missing, blank]) {
        const res = (await configTool({ path: dir, validate: true })) as Record<string, unknown>
        assert.equal(res.found, false)
        assert.equal(res.valid, true)
        assert.equal(res.section, 'validation_report')
      }
      assert.equal(existsSync(join(missing.dir, CONFIG_FILE)), false)
    } finally {
      missing.cleanup()
      blank.cleanup()
    }
  })
})
