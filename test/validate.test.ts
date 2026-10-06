import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { clampTimeout, runCommand, registerValidateTool } from '../src/tools/validate.ts'

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-validate-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

type ValidateDef = {
  execute: (a: unknown, e: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

function registerValidateDef(): ValidateDef {
  let def: ValidateDef | null = null
  registerValidateTool({
    tools: { register: (d: never) => { def = d as ValidateDef } },
  } as never)
  if (!def) throw new Error('iterate_validate was not registered')
  return def
}

function captureValidateTool(): (args: unknown) => Promise<Record<string, unknown>> {
  const def = registerValidateDef()
  const exec = { signal: new AbortController().signal }
  return async (args) => (await def.execute(args, exec as never)) as Record<string, unknown>
}

/** Same tool, but also exposes `output.render` for render-level assertions. */
function captureValidateToolWithRender(): {
  execute: (args: unknown) => Promise<Record<string, unknown>>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  const def = registerValidateDef()
  const exec = { signal: new AbortController().signal }
  return {
    execute: async (args) => (await def.execute(args, exec as never)) as Record<string, unknown>,
    render: (args, value) => def.output.render(args, value),
  }
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

// ─── whitelist: exact match after trim, nothing more ─────────────────────────

describe('iterate_validate whitelist exact-match', () => {
  const CONFIG = [
    'validation:',
    '  commands:',
    '    default:',
    '      - echo ok',
    '',
  ].join('\n')

  it('rejects look-alike commands that only extend a whitelisted command', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG, 'utf-8')
      const execute = captureValidateTool()
      // A whitelisted `echo ok` must not vouch for a longer string: prefix
      // matching used to allow `echo ok-more` and, worse, `echo ok; <payload>`
      // — the whole string has to equal one whitelisted entry after trim.
      for (const command of ['echo ok extra', 'echo ok; touch pwned', 'echo ok && true', 'echo ok-more']) {
        const out = await execute({ command, path: dir })
        assert.equal(out.allowed, false, `"${command}" must be rejected`)
        assert.equal(out.exitCode, -1)
        assert.match(String(out.rejectReason), /exactly match/i)
      }
      // The separator payload never reached a shell.
      assert.equal(existsSync(join(dir, 'pwned')), false)
    } finally {
      cleanup()
    }
  })

  it('accepts a whitelisted command padded with surrounding whitespace', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG, 'utf-8')
      const execute = captureValidateTool()
      // Trim semantics: only the CANDIDATE is trimmed before the exact
      // comparison, so incidental padding is fine while extra arguments are not.
      const out = await execute({ command: ' echo ok ', path: dir })
      assert.equal(out.allowed, true)
      assert.equal(out.exitCode, 0)
      assert.equal(String(out.stdout).trim(), 'ok')
      assert.equal(out.truncated, false)
    } finally {
      cleanup()
    }
  })
})

// ─── runCommand never rejects; a cut stream is flagged, not guessed ──────────

describe('runCommand start failures and output caps', () => {
  it('resolves a structured startError instead of rejecting on a NUL-byte command', async () => {
    // exec() validates its arguments synchronously and THROWS for a NUL byte
    // before registering its callback — inside the promise executor that throw
    // would reject and escape `execute` as an unhandled tool crash.
    const result = await runCommand('echo ok\u0000', process.cwd(), 10_000)
    assert.equal(typeof result.startError, 'string')
    assert.match(String(result.startError), /null bytes/)
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.timedOut, false)
    assert.equal(result.canceled, false)
    assert.equal(result.truncated, false)
  })

  it('flags truncated output (not a timeout) when maxBuffer is exceeded', async () => {
    // maxBuffer is injectable so the cap is hit without generating 10 MB here;
    // `yes` never exits on its own, proving the cap kills the child too.
    const result = await runCommand('yes x', process.cwd(), 10_000, undefined, 1024)
    assert.equal(result.truncated, true)
    assert.equal(result.startError, undefined)
    assert.equal(result.timedOut, false)
    assert.equal(result.canceled, false)
    assert.equal(result.exitCode, 1)
    assert.ok(result.stdout.length > 0)
    assert.ok(result.stdout.length < 5_000, 'stdout must be cut short at the cap')
  })
})

// ─── failures surface as structured results through the tool ─────────────────

describe('iterate_validate failure surfacing', () => {
  it('turns a whitelisted command that cannot start into a structured rejection', async () => {
    const { dir, cleanup } = tempProject()
    try {
      // YAML's double-quoted `\0` escape embeds a real NUL byte, so the
      // whitelist itself can carry a command exec() refuses to spawn — the
      // crafted case that used to escape execute as an unhandled throw.
      const nulConfig = [
        'validation:',
        '  commands:',
        '    default:',
        '      - "echo ok\\0"',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'iterate.config.yaml'), nulConfig, 'utf-8')
      const execute = captureValidateTool()
      const out = await execute({ command: 'echo ok\u0000', path: dir })
      assert.equal(out.allowed, false)
      assert.equal(out.exitCode, 1)
      assert.match(String(out.rejectReason), /^command failed to start:/)
      assert.equal(out.timedOut, false)
      assert.equal(out.canceled, false)
      // Internal runCommand diagnostics must never leak into the tool output
      // (the output schema has no `startError` property).
      assert.equal('startError' in out, false)
    } finally {
      cleanup()
    }
  })

  it('reports truncation (and a render warning) when output exceeds the cap', async () => {
    const { dir, cleanup } = tempProject()
    try {
      // `yes` writes without bound, so the production 10 MB default cap is hit
      // and the child is killed — the reader must be told the tail was cut.
      const bigConfig = [
        'validation:',
        '  commands:',
        '    default:',
        '      - yes x',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'iterate.config.yaml'), bigConfig, 'utf-8')
      const { execute, render } = captureValidateToolWithRender()
      const out = await execute({ command: 'yes x', path: dir })
      assert.equal(out.allowed, true)
      assert.equal(out.truncated, true)
      assert.equal(out.exitCode, 1)
      assert.match(String(out.rejectReason), /truncated/)
      assert.equal(out.timedOut, false)
      assert.equal('startError' in out, false)
      assert.ok(String(out.stdout).length > 0, 'the partial output is still reported')

      const text = render({ command: 'yes x' }, out).map((b) => b.text).join('\n')
      assert.match(text, /⚠ .*truncated/)

      // A clean run renders without any warning markers.
      const cleanText = render({ command: 'echo ok' }, {
        allowed: true,
        command: 'echo ok',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        canceled: false,
        durationMs: 3,
        truncated: false,
      })
        .map((b) => b.text)
        .join('\n')
      assert.equal(cleanText.includes('⚠'), false)
    } finally {
      cleanup()
    }
  })
})