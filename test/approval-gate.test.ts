import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideApproval,
  describe as describeApprovalText,
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

  it('iterate_rollback consent text names the fix id and project path', () => {
    // Rollback's params are `id`/`path` (no `file`) — the prompt must be able
    // to name the target instead of always degrading to "the workspace".
    const d = decideApproval(
      { name: 'iterate_rollback', arguments: { id: 'fix-42', path: '/proj' } },
      'ask',
    )
    assert.equal(d.kind, 'ask')
    if (d.kind === 'ask') {
      assert.match(d.reason, /fix-42/)
      assert.match(d.reason, /\/proj/)
      assert.match(d.reason, /backup/)
      assert.doesNotMatch(d.reason, /the workspace/)
    }
  })

  it('iterate_rollback without an id falls back to the path, then a generic target', () => {
    const withPath = decideApproval({ name: 'iterate_rollback', arguments: { path: '/other' } }, 'ask')
    assert.equal(withPath.kind, 'ask')
    if (withPath.kind === 'ask') {
      assert.match(withPath.reason, /\/other/)
      assert.match(withPath.reason, /Revert fix/)
    }
    const bare = decideApproval({ name: 'iterate_rollback', arguments: {} }, 'ask')
    assert.equal(bare.kind, 'ask')
    if (bare.kind === 'ask') assert.match(bare.reason, /Revert fix a fix/)
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

  it('iterate_config reads are always allowed (only writes gate)', () => {
    // The gate must be operation-conditional: a config READ (or an
    // operation-less call, which the tool treats as a read) is the model's
    // way to learn the workflow — even under `deny` it must not be blocked.
    for (const p of POLICIES) {
      assert.deepEqual(decideApproval({ name: 'iterate_config' }, p), { kind: 'allow' })
      assert.deepEqual(decideApproval({ name: 'iterate_config', arguments: {} }, p), { kind: 'allow' })
      assert.deepEqual(
        decideApproval({ name: 'iterate_config', arguments: { operation: 'validate' } }, p),
        { kind: 'allow' },
      )
      assert.deepEqual(
        decideApproval({ name: 'iterate_config', arguments: { section: 'dimensions' } }, p),
        { kind: 'allow' },
      )
    }
  })

  it('iterate_config with operation "write" follows the policy', () => {
    const write = { name: 'iterate_config', arguments: { operation: 'write', updates: { goal: 'g' } } }
    assert.deepEqual(decideApproval(write, 'allow'), { kind: 'allow' })
    assert.equal(decideApproval(write, 'deny').kind, 'deny')
    const ask = decideApproval(write, 'ask')
    assert.equal(ask.kind, 'ask')
    if (ask.kind === 'ask') assert.match(ask.reason, /iterate\.config\.yaml/)
  })

  it('iterate_config write consent text names the keys being written', () => {
    const d = decideApproval(
      {
        name: 'iterate_config',
        arguments: { operation: 'write', updates: { max_rounds: 10, dimensions: ['correctness'] } },
      },
      'ask',
    )
    assert.equal(d.kind, 'ask')
    if (d.kind === 'ask') {
      assert.match(d.reason, /`max_rounds`/)
      assert.match(d.reason, /`dimensions`/)
      assert.doesNotMatch(d.reason, /WARNING/)
    }
  })

  it('iterate_config write that DISABLES a review gate shouts a warning', () => {
    // The consent prompt is the last human look before the model rewrites the
    // policy file — turning a reviewer gate off must not read as "update a
    // file".
    const d = decideApproval(
      {
        name: 'iterate_config',
        arguments: { operation: 'write', updates: { reviewer: { evidence_validation: false } } },
      },
      'ask',
    )
    assert.equal(d.kind, 'ask')
    if (d.kind === 'ask') {
      assert.match(d.reason, /WARNING/)
      assert.match(d.reason, /turns OFF/)
      assert.match(d.reason, /reviewer\.evidence_validation/)
    }
  })

  it('empty or undefined name (or execution) is allowed', () => {
    assert.deepEqual(decideApproval({ name: '' }, 'deny'), { kind: 'allow' })
    assert.deepEqual(decideApproval({ name: undefined as unknown as string }, 'deny'), { kind: 'allow' })
    assert.deepEqual(decideApproval(undefined as unknown as ToolExecutionLike, 'deny'), { kind: 'allow' })
  })
})

describe('language handling (#9)', () => {
  it('describe renders human-facing text in the requested language', () => {
    const args = { file: 'src/a.ts' }
    assert.equal(describeApprovalText('iterate_fix', args, 'en'), 'Apply an atomic fix to `src/a.ts`')
    assert.equal(describeApprovalText('iterate_fix', args, 'zh'), '对 `src/a.ts` 应用一次原子修复')
    // Rollback names its real target in both languages.
    assert.match(describeApprovalText('iterate_rollback', { id: 'fix-42' }, 'zh'), /回滚修复 `fix-42`/)
    assert.match(describeApprovalText('iterate_rollback', { id: 'fix-42' }, 'en'), /Revert fix `fix-42`/)
    // Prune/prune-like generic arms localize too.
    assert.match(describeApprovalText('iterate_prune', {}, 'zh'), /删除/)
    assert.match(describeApprovalText('iterate_prune', {}, 'en'), /Delete/)
  })

  it('the WARNING marker stays literal in both languages', () => {
    // The UI highlight rule matches on the literal `WARNING` — it must not be
    // translated away, even when the surrounding sentence is Chinese.
    const updates = { reviewer: { evidence_validation: false } }
    const zh = describeApprovalText('iterate_config', { operation: 'write', updates }, 'zh')
    const en = describeApprovalText('iterate_config', { operation: 'write', updates }, 'en')
    assert.match(zh, /WARNING/)
    assert.match(zh, /reviewer\.evidence_validation/)
    assert.match(en, /WARNING/)
    assert.match(en, /reviewer\.evidence_validation/)
  })

  it('deny reason stays English under the zh language', () => {
    // Structured/durable text never localizes: deny reasons feed logs, audits,
    // and machine matchers, which must not depend on a locale.
    const d = decideApproval({ name: 'iterate_fix', arguments: { file: 'src/a.ts' } }, 'deny', 'zh')
    assert.equal(d.kind, 'deny')
    if (d.kind === 'deny') {
      assert.equal(d.reason, 'Apply an atomic fix to `src/a.ts`')
      assert.doesNotMatch(d.reason, /[一-鿿]/)
    }
  })

  it('ask carries an English audited reason plus a localized displayReason', () => {
    const ask = decideApproval(
      { name: 'iterate_config', arguments: { operation: 'write', updates: { reviewer: { evidence_validation: false } } } },
      'ask',
      'zh',
    )
    assert.equal(ask.kind, 'ask')
    if (ask.kind === 'ask') {
      // `reason` — machine-readable, English, regardless of config.language.
      assert.match(ask.reason, /^Update `iterate\.config\.yaml`/)
      assert.match(ask.reason, /WARNING/)
      assert.doesNotMatch(ask.reason, /[一-鿿]/)
      // `displayReason` — human-facing: en required, zh added when configured.
      assert.equal(typeof ask.displayReason.en, 'string')
      assert.match(ask.displayReason.zh ?? '', /将关闭/)
      assert.match(ask.displayReason.zh ?? '', /WARNING/)
      // en mirrors the audited reason so a non-zh UI still shows the prompt.
      assert.equal(ask.displayReason.en, ask.reason)
    }
  })

  it('ask under the en language carries displayReason.en only', () => {
    const ask = decideApproval({ name: 'iterate_fix', arguments: { file: 'src/a.ts' } }, 'ask', 'en')
    assert.equal(ask.kind, 'ask')
    if (ask.kind === 'ask') {
      assert.equal(ask.displayReason.en, ask.reason)
      assert.equal(ask.displayReason.zh, undefined)
      assert.match(ask.displayReason.en, /Apply an atomic fix/)
    }
  })
})

describe('isDestructiveIterateTool', () => {
  it('flags every gated iterate tool (fix / rollback / prune / config)', () => {
    assert.equal(isDestructiveIterateTool('iterate_fix'), true)
    assert.equal(isDestructiveIterateTool('iterate_rollback'), true)
    assert.equal(isDestructiveIterateTool('iterate_prune'), true)
    // Config writes carry the approval policy, the reviewer gates, and the
    // command allow-list — the name is routed through the gate for its whole
    // name and `decideApproval` narrows reads to `allow` per call.
    assert.equal(isDestructiveIterateTool('iterate_config'), true)
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