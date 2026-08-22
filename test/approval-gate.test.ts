import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideApproval,
  toolGate,
  isDestructiveIterateTool,
} from '../src/approval-gate.ts'
import type { ToolExecutionLike } from '../src/approval-gate.ts'

const POLICIES = ['ask', 'deny', 'allow'] as const
type Policy = (typeof POLICIES)[number]

describe('decideApproval', () => {
  it('allows non-destructive and unknown tools under every policy', () => {
    for (const p of POLICIES) {
      assert.deepEqual(decideApproval({ name: 'iterate_review' }, p), { kind: 'allow' })
      assert.deepEqual(decideApproval({ name: 'totally_unknown' }, p), { kind: 'allow' })
      assert.deepEqual(decideApproval({ name: 'shell' }, p), { kind: 'allow' })
    }
  })

  it('iterate_fix follows the policy (allow/deny/ask)', () => {
    assert.deepEqual(decideApproval({ name: 'iterate_fix' }, 'allow'), { kind: 'allow' })

    const deny = decideApproval({ name: 'iterate_fix' }, 'deny')
    assert.equal(deny.kind, 'deny')
    if (deny.kind === 'deny') assert.ok(deny.reason.length > 0)

    const ask = decideApproval({ name: 'iterate_fix', arguments: { file: 'src/a.ts' } }, 'ask')
    assert.equal(ask.kind, 'ask')
    if (ask.kind === 'ask') assert.match(ask.reason, /src\/a\.ts/)
  })

  it('iterate_rollback is refused under deny policy', () => {
    const d = decideApproval(
      { name: 'iterate_rollback', arguments: { id: 'f1', file: 'src/a.ts' } },
      'deny',
    )
    assert.equal(d.kind, 'deny')
  })

  it('iterate_prune with dryRun default/true is always allowed', () => {
    for (const p of POLICIES) {
      assert.deepEqual(decideApproval({ name: 'iterate_prune' }, p), { kind: 'allow' })
      assert.deepEqual(decideApproval({ name: 'iterate_prune', arguments: { dryRun: true } }, p), {
        kind: 'allow',
      })
    }
  })

  it('iterate_prune with dryRun:false follows the policy', () => {
    assert.deepEqual(decideApproval({ name: 'iterate_prune', arguments: { dryRun: false } }, 'allow'), {
      kind: 'allow',
    })
    assert.equal(decideApproval({ name: 'iterate_prune', arguments: { dryRun: false } }, 'deny').kind, 'deny')
    assert.equal(decideApproval({ name: 'iterate_prune', arguments: { dryRun: false } }, 'ask').kind, 'ask')
  })

  it('empty or undefined name (or execution) is allowed', () => {
    assert.deepEqual(decideApproval({ name: '' }, 'deny'), { kind: 'allow' })
    assert.deepEqual(decideApproval({ name: undefined as unknown as string }, 'deny'), { kind: 'allow' })
    assert.deepEqual(decideApproval(undefined as unknown as ToolExecutionLike, 'deny'), { kind: 'allow' })
  })
})

describe('toolGate', () => {
  it('ask policy with approved=true runs', () => {
    assert.deepEqual(toolGate('ask', { name: 'iterate_fix' }, true), { ok: true })
  })

  it('ask policy without approved=true requires approval', () => {
    const r = toolGate('ask', { name: 'iterate_fix' }, false) as {
      ok: false
      requiresApproval: true
      reason: string
    }
    assert.equal(r.ok, false)
    assert.equal(r.requiresApproval, true)
    assert.ok(r.reason.length > 0)
  })

  it('deny policy returns a blocked error', () => {
    const r = toolGate('deny', { name: 'iterate_fix' }) as { ok: false; error: string }
    assert.equal(r.ok, false)
    assert.ok(r.error.length > 0)
    assert.match(r.error, /policy/i)
    assert.equal((r as { requiresApproval?: boolean }).requiresApproval, undefined)
  })

  it('allow policy runs', () => {
    assert.deepEqual(toolGate('allow', { name: 'iterate_fix' }), { ok: true })
  })
})

describe('isDestructiveIterateTool', () => {
  it('flags the three destructive iterate tools', () => {
    assert.equal(isDestructiveIterateTool('iterate_fix'), true)
    assert.equal(isDestructiveIterateTool('iterate_rollback'), true)
    assert.equal(isDestructiveIterateTool('iterate_prune'), true)
  })

  it('is false for every other tool name and non-strings', () => {
    assert.equal(isDestructiveIterateTool('iterate_review'), false)
    assert.equal(isDestructiveIterateTool('iterate_transcript'), false)
    assert.equal(isDestructiveIterateTool('shell'), false)
    assert.equal(isDestructiveIterateTool(42), false)
    assert.equal(isDestructiveIterateTool(null), false)
    assert.equal(isDestructiveIterateTool(undefined), false)
    assert.equal(isDestructiveIterateTool({}), false)
  })
})