import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { clampTimeout, runCommand, registerValidateTool } from '../src/tools/validate.ts'

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-validate-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function captureValidateTool(): (args: unknown) => Promise<Record<string, unknown>> {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerValidateTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_validate was not registered')
  const exec = { signal: new AbortController().signal }
  return async (args) => (await def!.execute(args, exec as never)) as Record<string, unknown>
}

describe('clampTimeout', () => {
  it('falls back to the default when timeout is undefined', () => {
    assert.equal(clampTimeout(undefined), 120_000)
  })

  it('falls back to the default when timeout is not a positive finite number', () => {
    assert.equal(clampTimeout(0), 120_000)
    assert.equal(clampTimeout(-5), 120_000)
    assert.equal(clampTimeout(NaN), 120_000)
    assert.equal(clampTimeout(Infinity), 120_000)
  })

  it('caps a timeout above the ceiling so a model cannot pin the tool open', () => {
    assert.equal(clampTimeout(Number.MAX_SAFE_INTEGER), 600_000)
  })

  it('passes a valid in-range timeout through unchanged', () => {
    assert.equal(clampTimeout(30_000), 30_000)
    assert.equal(clampTimeout(600_000), 600_000)
  })
})

describe('runCommand cancellation semantics', () => {
  it('reports success with stdout and no timeout/cancel flags', async () => {
    const result = await runCommand('echo hello', process.cwd(), 10_000)
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), 'hello')
    assert.equal(result.timedOut, false)
    assert.equal(result.canceled, false)
    assert.ok(result.durationMs >= 0)
  })

  it('kills the child and reports canceled (not timedOut) when the caller signal aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await runCommand('sleep 5', process.cwd(), 60_000, controller.signal)
    assert.equal(result.canceled, true)
    assert.equal(result.timedOut, false)
    // Killed before the natural exit code could be produced.
    assert.ok(result.exitCode !== 0)
    assert.ok(result.durationMs < 5_000, 'child must be killed promptly on abort')
  })

  it('reports timedOut (not canceled) when the command exceeds the deadline without a signal', async () => {
    const result = await runCommand('sleep 5', process.cwd(), 150)
    assert.equal(result.timedOut, true)
    assert.equal(result.canceled, false)
    assert.ok(result.durationMs < 5_000, 'deadline must kill the child promptly')
  })

  it('reports a non-zero exit code and stderr for failing commands', async () => {
    const result = await runCommand('echo boom >&2; exit 3', process.cwd(), 10_000)
    assert.equal(result.exitCode, 3)
    assert.equal(result.stderr.trim(), 'boom')
    assert.equal(result.timedOut, false)
    assert.equal(result.canceled, false)
  })

  it('reports a clean failure (no throw) when the binary cannot be spawned', async () => {
    // A nonexistent command is a spawn failure: exec shells out, so the shell
    // exits 127 ("command not found") — must surface as an integer exit code
    // without throwing or tripping the timeout/cancel flags.
    const result = await runCommand('no_such_binary_xyz_123', process.cwd(), 10_000)
    assert.equal(Number.isInteger(result.exitCode), true)
    assert.ok(result.exitCode !== 0, 'spawn failure must be a non-zero exit')
    assert.equal(result.timedOut, false)
    assert.equal(result.canceled, false)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not found/i)
  })
})

// ─── iterate_validate tool (end-to-end execute) ─────────────────────────────

describe('iterate_validate execute', () => {
  const CONFIG = [
    'validation:',
    '  commands:',
    '    default:',
    '      - echo ok',
    '      - "node -e \\"process.exit(3)\\""',
    '',
  ].join('\n')

  it('runs an allowed command and reports stdout + exit code', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG, 'utf-8')
      const execute = captureValidateTool()
      const out = await execute({ command: 'echo ok', path: dir })
      assert.equal(out.allowed, true)
      assert.equal(out.exitCode, 0)
      assert.equal(String(out.stdout).trim(), 'ok')
      assert.equal(out.rejectReason, undefined)
    } finally {
      cleanup()
    }
  })

  it('reports the real exit code of an allowed but failing command', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG, 'utf-8')
      const execute = captureValidateTool()
      const out = await execute({ command: 'node -e "process.exit(3)"', path: dir })
      assert.equal(out.allowed, true)
      assert.equal(out.exitCode, 3)
    } finally {
      cleanup()
    }
  })

  it('rejects a command that is not exactly in validation.commands', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG, 'utf-8')
      const execute = captureValidateTool()
      const out = await execute({ command: 'echo no-such-white-space-differs', path: dir })
      assert.equal(out.allowed, false)
      assert.equal(out.exitCode, -1)
      assert.match(String(out.rejectReason), /exactly match/i)
    } finally {
      cleanup()
    }
  })

  it('refuses when no config exists (defaults configure no trusted commands)', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const execute = captureValidateTool()
      const out = await execute({ command: 'echo ok', path: dir })
      assert.equal(out.allowed, false)
      assert.match(String(out.rejectReason), /No iterate\.config\.yaml/)
    } finally {
      cleanup()
    }
  })
})