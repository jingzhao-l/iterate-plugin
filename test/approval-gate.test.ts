import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideApproval,
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