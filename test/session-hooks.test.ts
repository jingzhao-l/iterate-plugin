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
  readonly signal?: AbortSignal
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

  it('gates iterate_config WRITES under the session policy while reads stay free', () => {
    // M2: iterate.config.yaml carries the approval policy, the reviewer gates,
    // and the command allow-list — a write must route through consent exactly
    // like iterate_fix, but blocking READS would lock the model out of the
    // workflow it is supposed to follow.
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const session = { session: { header: { cwd: dir } } }
      const write = gateDecision(
        exec({
          name: 'iterate_config',
          arguments: { operation: 'write', updates: { reviewer: { evidence_validation: false } } },
          agent: session,
        }),
      )
      assert.equal(write.kind, 'deny')
      if (write.kind === 'deny') {
        assert.match(String(write.reason), /iterate\.config\.yaml/)
        // Fail-closed denials carry the structured info seam.
        assert.equal(write.info?.code, 'APPROVAL_DENIED')
      }

      // A read (no operation / section read) is always allowed, even under deny.
      for (const args of [{}, { section: 'dimensions' }, { operation: 'validate' }]) {
        assert.deepEqual(
          gateDecision(exec({ name: 'iterate_config', arguments: args, agent: session })),
          { kind: 'allow' },
          `read args=${JSON.stringify(args)}`,
        )
      }
    } finally {
      cleanup()
    }
  })

  it('iterate_config write ASKS under the default fail-safe policy', () => {
    // No config at all → policy degrades to `ask` → the write must prompt.
    const { dir, cleanup } = tempDir()
    try {
      const d = gateDecision(
        exec({
          name: 'iterate_config',
          arguments: { operation: 'write', updates: { max_rounds: 5 } },
          agent: { session: { header: { cwd: dir } } },
        }),
      )
      assert.equal(d.kind, 'ask')
      if (d.kind === 'ask') assert.match(String(d.reason), /max_rounds/)
    } finally {
      cleanup()
    }
  })

  it('session cwd policy WINS over a model-controlled path pointing at `allow`', () => {
    // Regression: the gate used to read the policy from the path-resolved
    // root first, so `path:` at an `approval: allow` directory let the model
    // self-grant despite the human's `deny` in the session workspace.
    const session = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    const elsewhere = tempDir({ 'iterate.config.yaml': configYaml('allow') })
    try {
      const d = gateDecision(
        exec({
          name: 'iterate_fix',
          arguments: { path: elsewhere.dir },
          agent: { session: { header: { cwd: session.dir } } },
        }),
      )
      assert.equal(d.kind, 'deny')
    } finally {
      session.cleanup()
      elsewhere.cleanup()
    }
  })

  it('session cwd `deny` still applies when the path points at a dir with NO config', () => {
    const session = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    const bare = tempDir()
    try {
      const d = gateDecision(
        exec({
          name: 'iterate_fix',
          arguments: { path: bare.dir },
          agent: { session: { header: { cwd: session.dir } } },
        }),
      )
      assert.equal(d.kind, 'deny')
    } finally {
      session.cleanup()
      bare.cleanup()
    }
  })

  it('session cwd `allow` wins over a path pointing at `deny` (path ignored both ways)', () => {
    const session = tempDir({ 'iterate.config.yaml': configYaml('allow') })
    const elsewhere = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(
        exec({
          name: 'iterate_fix',
          arguments: { path: elsewhere.dir },
          agent: { session: { header: { cwd: session.dir } } },
        }),
      )
      assert.equal(d.kind, 'allow')
    } finally {
      session.cleanup()
      elsewhere.cleanup()
    }
  })

  it('without a session cwd the path-resolved config is still honored (headless/tests)', () => {
    // No session cwd → the path fallback is the only policy source there is;
    // this is the pre-existing behavior the gate keeps for headless callers.
    const withAllow = tempDir({ 'iterate.config.yaml': configYaml('allow') })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: withAllow.dir } }))
      assert.equal(d.kind, 'allow')
    } finally {
      withAllow.cleanup()
    }
    const withDeny = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: withDeny.dir } }))
      assert.equal(d.kind, 'deny')
    } finally {
      withDeny.cleanup()
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

  it('a caller-aborted destructive call is canceled before any policy reads', () => {
    // dsh 0.1.6-alpha.1: an already-aborted invocation must resolve to `cancel`
    // — a dead request must never run, prompt for consent, or be allow-listed.
    const aborted = new AbortController()
    aborted.abort()
    const withConfig = tempDir({ 'iterate.config.yaml': configYaml('allow') })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: withConfig.dir }, signal: aborted.signal }))
      assert.equal(d.kind, 'cancel')
    } finally {
      withConfig.cleanup()
    }

    // Cancellation takes precedence over the deny policy too.
    const withDeny = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(exec({ name: 'iterate_rollback', arguments: { path: withDeny.dir }, signal: aborted.signal }))
      assert.equal(d.kind, 'cancel')
    } finally {
      withDeny.cleanup()
    }
  })

  it('a live (unaborted) destructive call is not canceled', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: dir }, signal: new AbortController().signal }))
      assert.equal(d.kind, 'deny')
    } finally {
      cleanup()
    }
  })

  it('deny carries structured info (dsh 0.1.6-alpha.1 deny.info)', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('deny') })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: dir } }))
      assert.equal(d.kind, 'deny')
      if (d.kind === 'deny') {
        assert.equal(d.info?.name, 'iterate-approval-gate')
        assert.equal(d.info?.code, 'APPROVAL_DENIED')
        assert.ok(d.info?.reason && d.info.reason.length > 0)
      }
    } finally {
      cleanup()
    }
  })
})

describe('language rule (#9)', () => {
  const bilingualConfig = `language: zh\nobservatory:\n  approval: ask\n`
  const enOnlyConfig = `language: en\nobservatory:\n  approval: ask\n`

  it('ask carries reason (English) + displayReason localized to config.language', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': bilingualConfig })
    try {
      const d = gateDecision(
        exec({
          name: 'iterate_config',
          arguments: { path: dir, operation: 'write', updates: { reviewer: { evidence_validation: false } } },
          agent: { session: { header: { cwd: dir } } },
        }),
      )
      assert.equal(d.kind, 'ask')
      if (d.kind === 'ask') {
        // Audited summary: English, machine-readable, no CJK.
        assert.match(String(d.reason), /^Update `iterate\.config\.yaml`/)
        assert.match(String(d.reason), /WARNING/)
        assert.doesNotMatch(String(d.reason), /[一-鿿]/)
        // Human prompt: follows the configured language; en stays available.
        assert.equal(typeof d.displayReason?.en, 'string')
        assert.match(d.displayReason?.zh ?? '', /将关闭/)
        assert.match(d.displayReason?.zh ?? '', /WARNING/)
      }
    } finally {
      cleanup()
    }
  })

  it('deny reason and deny.info.reason stay English under a zh config', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': `language: zh\nobservatory:\n  approval: deny\n` })
    try {
      const d = gateDecision(exec({ name: 'iterate_fix', arguments: { path: dir, file: 'src/a.ts' } }))
      assert.equal(d.kind, 'deny')
      if (d.kind === 'deny') {
        assert.equal(d.reason, 'Apply an atomic fix to `src/a.ts`')
        assert.doesNotMatch(d.reason, /[一-鿿]/)
        assert.equal(d.info?.reason, d.reason)
      }
    } finally {
      cleanup()
    }
  })

  it('an ask under an en config carries displayReason.en only', () => {
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': enOnlyConfig })
    try {
      const d = gateDecision(
        exec({ name: 'iterate_fix', arguments: { path: dir, file: 'src/a.ts' } }),
      )
      assert.equal(d.kind, 'ask')
      if (d.kind === 'ask') {
        assert.equal(d.displayReason?.en, d.reason)
        assert.equal(d.displayReason?.zh, undefined)
      }
    } finally {
      cleanup()
    }
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

  it('cancel decisions short-circuit without calling next', async () => {
    const { handler } = capture()
    const { dir, cleanup } = tempDir({ 'iterate.config.yaml': configYaml('allow') })
    try {
      let nextCalled = false
      const aborted = new AbortController()
      aborted.abort()
      const decision = await handler!(
        exec({ name: 'iterate_fix', arguments: { path: dir }, signal: aborted.signal }),
        () => {
          nextCalled = true
          return Promise.resolve({ kind: 'allow' })
        },
      )
      assert.equal(nextCalled, false, 'an aborted call must not fall through to next()')
      assert.equal(decision.kind, 'cancel')
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

  it('the fail-safe degraded ask still exposes displayReason.en (#9)', async () => {
    // The listener's catch path must produce a complete ask decision — dsh
    // 0.2.x renders `displayReason`, so an ask without it would show no prompt
    // text at all. Reaching the catch: `gateDecision` reads `exec.signal`
    // inside a try but dereferences `.aborted` OUTSIDE it, so a signal whose
    // `aborted` getter throws escapes to the listener's fail-safe branch.
    const { handler } = capture()
    const hostile = exec({
      name: 'iterate_fix',
      arguments: {},
      signal: { get aborted(): boolean { throw new Error('boom') } } as unknown as AbortSignal,
    })
    const decision = await handler!(hostile, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(decision.kind, 'ask')
    if (decision.kind === 'ask') {
      assert.match(String(decision.reason), /require consent/)
      assert.equal(decision.displayReason?.en, decision.reason)
      assert.equal(decision.displayReason?.zh, undefined)
    }
  })
})