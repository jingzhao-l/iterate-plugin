import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ITERATE_SKILL_PROMPT } from '../src/skill-prompt.ts'

describe('ITERATE_SKILL_PROMPT', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof ITERATE_SKILL_PROMPT, 'string')
    assert.ok(ITERATE_SKILL_PROMPT.length > 0)
  })

  it('documents every registered tool', () => {
    for (const tool of [
      'iterate_config',
      'iterate_validate',
      'iterate_decision_log',
      'iterate_context',
      'iterate_review',
      'iterate_triage',
      'iterate_fix',
      'iterate_diff',
      'iterate_rollback',
      'iterate_checkpoint',
      'iterate_status',
      'iterate_history',
      'iterate_prune',
      'iterate_transcript',
    ]) {
      assert.ok(ITERATE_SKILL_PROMPT.includes(tool), `prompt must mention ${tool}`)
    }
  })

  it('documents both dry-run and normal workflow modes', () => {
    assert.ok(ITERATE_SKILL_PROMPT.includes('Dry-run mode workflow'))
    assert.ok(ITERATE_SKILL_PROMPT.includes('Normal-mode workflow'))
  })

  it('contains the canonical workflow contract keywords', () => {
    for (const marker of ['agent(', 'parallel(', 'phase(', 'meta: { name: "iterate"', 'schema validation']) {
      assert.ok(ITERATE_SKILL_PROMPT.includes(marker), `prompt must include ${marker}`)
    }
  })

  it('explicitly forbids file writes in dry-run mode', () => {
    assert.ok(ITERATE_SKILL_PROMPT.includes('NEVER call a fixer'))
    assert.ok(ITERATE_SKILL_PROMPT.includes('Reviewers read only'))
  })

  it('keeps the fixer as the only sanctioned writer in normal mode', () => {
    assert.ok(ITERATE_SKILL_PROMPT.includes('Fixers are the ONLY agents allowed to write files'))
    assert.ok(ITERATE_SKILL_PROMPT.includes('iterate_fix'))
  })
})
