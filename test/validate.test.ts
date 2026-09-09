import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampTimeout, runCommand } from '../src/tools/validate.ts'

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
})