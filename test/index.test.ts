import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, name, inject } from '../src/index.ts'

describe('apply() bootstrap', () => {
  it('exposes plugin metadata', () => {
    assert.equal(name, 'iterate-plugin')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
  })

  it('registers all 17 tools and injects the skill prompt section', () => {
    const registered: string[] = []
    const sections: Array<{ name: string; order: number; text?: string }> = []
    const ctxMock = {
      tools: { register: (def: { name: string }) => { registered.push(def.name) } },
      systemPrompt: {
        section: (s: { name: string; order: number; text: string }) => { sections.push(s) },
      },
      on: () => () => undefined,
    }

    apply(ctxMock as never)

    const expected = [
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
      'iterate_experience',
      'iterate_quality_gate',
      'iterate_defense_events',
    ]
    assert.equal(registered.length, expected.length, `registered: ${registered.join(', ')}`)
    assert.deepEqual(registered.sort(), expected.sort())

    const section = sections[0]!
    assert.equal(sections.length, 1)
    assert.equal(section.name, 'iterate-skill')
    assert.equal(section.order, 100)
    assert.ok((section.text ?? '').includes('Iterate Workflow'))
    assert.ok((section.text ?? '').includes('iterate_review'))
  })
})