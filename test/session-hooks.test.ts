import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gateDecision } from '../src/session-hooks.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

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
})