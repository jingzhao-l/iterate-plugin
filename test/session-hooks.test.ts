import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gateDecision, registerSessionHooks } from '../src/session-hooks.ts'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Minimal shape of what gateDecision actually reads from a ToolExecution:
 * name, arguments, and (optionally) agent.session.header.cwd. The real type's
 * fields are readonly, so we build a fake then cast it explicitly.
 * gateDecision is used for READ-ONLY access via passing into config resolution.
 */
interface FakeToolExecution {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: {
    readonly session?: { readonly header?: { readonly cwd?: string } }
  }
}

function exec(e: FakeToolExecution): ToolExecution {
  return e as unknown as ToolExecution
}

/** Create a temp project dir with the given files; returns a cleanup fn. */
function tempDir(files: Record<string, string> = {}): {
  dir: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-gate-test-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content, 'utf-8')
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const configYaml = (approval: string): string => `observatory:\n  approval: ${approval}\n`

describe('gateDecision', () => {
  it('allows non-destructive tools without reading any config', () => {
    assert.deepEqual(gateDecision(exec({ name: 'iterate_review' })), { kind: 'allow' })
    assert.deepEqual(gateDecision(exec({ name: 'unknown_tool', arguments: { path: '/' } })), {
      kind: 'allow',
    })
  })

  it('reads observatory.approval from the call path and gates iterate_fix accordingly', () => {
    const cases: Array<[string, 'deny' | 'allow' | 'ask']> = [
      ['deny', 'deny'],
      ['allow', 'allow'],
      ['ask', 'ask'],
    ]
    for (const [policy, expectedKind] of cases) {
      const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml(policy) })
      try {
        const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: dir } }))
        assert.equal(d.kind, expectedKind, `policy=${policy}`)
        if (d.kind === 'deny') assert.ok(d.reason.length > 0)
        if (d.kind === 'ask' && d.reason) assert.ok(d.reason.length > 0)
      } finally {
        cleanup()
      }
    }
  })

  it('gates from the session cwd when no path is given', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(
        exec({ name: 'iterate_rollback', arguments: {}, agent: { session: { header: { cwd: dir } } } }),
      )
      assert.equal(d.kind, 'deny')
    } finally {
      cleanup()
    }
  })

  it('falls back to ask on an invalid config via session cwd without throwing', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': ': not: yaml {' })
    try {
      const d = gateDecision(
        exec({ name: 'iterate_fix', arguments: {}, agent: { session: { header: { cwd: dir } } } }),
      )
      assert.equal(d.kind, 'ask')
    } finally {
      cleanup()
    }
  })

  it('missing config defaults to ask (fail-safe) rather than throw', () => {
    const { dir, cleanup } = tempDir()
    try {
      const d = gateDecision(
        exec({ name: 'iterate_fix', arguments: {}, agent: { session: { header: { cwd: dir } } } }),
      )
      assert.equal(d.kind, 'ask')
    } finally {
      cleanup()
    }
  })

  it('NUL-byte path degrades to ask (fail-safe) instead of throwing or allowing', () => {
    // A `\0` in the caller-supplied path used to make resolve() throw inside the
    // gate; that throw was previously swallowed by the listener's catch and
    // degraded to allow (fail-open) for a destructive call. Regression guard.
    const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: 'bad\u0000path' } }))
    assert.equal(d.kind, 'ask')
  })

  it('an unreadable proxied exec name degrades to allow without throwing', () => {
    // The gate must never throw just because an exec is a hostile/proxied
    // object; an unclassifiable name falls through to "not our tool" → allow.
    const hostile = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'name') throw new Error('cannot read name')
        return undefined
      },
    })
    assert.deepEqual(gateDecision(hostile as unknown as ToolExecution), { kind: 'allow' })
  })

  it('a throwing proxy exec for a destructive iterate tool degrades to ask', () => {
    // name is readable but argument access blows up — the gate must degrade to
    // ask (consent required) rather than throw or allow.
    const hostile = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'name') return 'iterate_fix'
        if (prop === 'arguments') throw new Error('cannot read arguments')
        return undefined
      },
    })
    const d = gateDecision(hostile as unknown as ToolExecution)
    assert.equal(d.kind, 'ask')
  })
})

describe('registerSessionHooks', () => {
  interface CapturedListener {
    ctx: Context
    handler: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | null
  }

  function capture(): CapturedListener {
    const captured: CapturedListener = { ctx: {} as Context, handler: null }
    captured.ctx = {
      on(_event: string, fn: unknown) {
        captured.handler = fn as CapturedListener['handler']
      },
    } as unknown as Context
    registerSessionHooks(captured.ctx)
    assert.ok(captured.handler, 'expected tools/pre-execute listener to register')
    return captured
  }

  it('ask decisions are returned directly — next() must NOT short-circuit to allow', async () => {
    const { ctx, handler } = capture()
    const { dir, cleanup } = tempDir()
    try {
      let nextCalled = false
      const decision = await handler!(
        exec({ name: 'iterate_fix', arguments: { path: dir } }),
        () => {
          nextCalled = true
          return Promise.resolve({ kind: 'allow' })
        },
      )
      assert.equal(nextCalled, false, 'consent must not be bypassed via next()')
      assert.equal(decision.kind, 'ask')
      assert.ok(ctx)
    } finally {
      cleanup()
    }
  })

  it('deny decisions short-circuit without calling next', async () => {
    const { handler } = capture()
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      let nextCalled = false
      const decision = await handler!(
        exec({ name: 'iterate_rollback', arguments: { path: dir } }),
        () => {
          nextCalled = true
          return Promise.resolve({ kind: 'allow' })
        },
      )
      assert.equal(nextCalled, false)
      assert.equal(decision.kind, 'deny')
    } finally {
      cleanup()
    }
  })

  it('allow decisions delegate to next() so later waterfall listeners still run', async () => {
    const { handler } = capture()
    let nextCalled = false
    const decision = await handler!(
      exec({ name: 'iterate_review' }),
      () => {
        nextCalled = true
        return Promise.resolve({ kind: 'allow' })
      },
    )
    assert.equal(nextCalled, true)
    assert.deepEqual(decision, { kind: 'allow' })
  })
})