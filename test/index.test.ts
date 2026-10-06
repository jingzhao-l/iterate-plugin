import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { apply, name, inject } from '../src/index.ts'
import { START_INSTRUCTIONS } from '../lib/parse.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The 17 tools `apply()` is allowed to register (source of truth below). */
const REGISTERED_TOOLS = [
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

    const expected = [...REGISTERED_TOOLS]
    assert.equal(registered.length, expected.length, `registered: ${registered.join(', ')}`)
    assert.deepEqual(registered.sort(), expected.sort())

    const section = sections[0]!
    assert.equal(sections.length, 1)
    assert.equal(section.name, 'iterate-skill')
    assert.equal(section.order, 100)
    assert.ok((section.text ?? '').includes('Iterate Workflow'))
    assert.ok((section.text ?? '').includes('iterate_review'))
  })

  it('wires the session guard and live-feed hooks', () => {
    // The approval gate (tools/pre-execute) and the observatory feed
    // (tools/result) are both registered through `ctx.on` — if either call is
    // dropped, tools run unchecked and the live feed silently goes dark while
    // every tool-count assertion below still passes.
    const events: string[] = []
    const ctxMock = {
      tools: { register: () => undefined },
      systemPrompt: { section: () => undefined },
      on: (ev: string) => {
        events.push(ev)
        return () => undefined
      },
    }

    apply(ctxMock as never)

    assert.ok(
      events.includes('tools/pre-execute'),
      `session guard hook missing; registered: ${events.join(', ') || '(none)'}`,
    )
    assert.ok(
      events.includes('tools/result'),
      `live capture hook missing; registered: ${events.join(', ') || '(none)'}`,
    )
  })

  it('wires the gate BEFORE any tool registration (partial load fails closed)', () => {
    // Regression: the hooks used to be registered AFTER the 17 tools, so a
    // failure mid-list left the already-registered tools running with NO
    // pre-execute approval gate. The gate must be first — a partial load may
    // only err toward MORE gating, never less.
    const order: string[] = []
    const ctxMock = {
      tools: {
        register: (def: { name: string }) => {
          order.push(`register:${def.name}`)
          if (def.name === 'iterate_config') throw new Error('hostile registration')
        },
      },
      systemPrompt: { section: () => { order.push('section') } },
      on: (ev: string) => {
        order.push(`on:${ev}`)
        return () => undefined
      },
    }

    withSilencedWarns(() => apply(ctxMock as never))

    assert.equal(order[0], 'on:tools/pre-execute', `order: ${order.slice(0, 3).join(', ')}`)
    assert.equal(order[1], 'on:tools/result')
    // …and the prompt is still injected after a tool failure.
    assert.equal(order[order.length - 1], 'section')
  })

  it('isolates a failing tool registration: the other 16 still load', () => {
    const registered: string[] = []
    const sections: string[] = []
    const ctxMock = {
      tools: {
        register: (def: { name: string }) => {
          if (def.name === 'iterate_review') throw new Error('boom')
          registered.push(def.name)
        },
      },
      systemPrompt: { section: (s: { name: string }) => { sections.push(s.name) } },
      on: () => () => undefined,
    }

    const warnings = withSilencedWarns(() => apply(ctxMock as never))

    assert.equal(registered.length, 16, `registered: ${registered.join(', ')}`)
    assert.ok(!registered.includes('iterate_review'))
    // The failure is logged, not swallowed silently.
    assert.ok(
      warnings.some((w) => String(w).includes('iterate_review')),
      `expected a warning naming the failing tool: ${warnings.join(' | ')}`,
    )
    // The prompt injection still happened.
    assert.deepEqual(sections, ['iterate-skill'])
  })

  it('a failing prompt injection does not undo an otherwise-loaded plugin', () => {
    const registered: string[] = []
    const events: string[] = []
    const ctxMock = {
      tools: { register: (def: { name: string }) => { registered.push(def.name) } },
      systemPrompt: {
        section: () => { throw new Error('no system prompt service') },
      },
      on: (ev: string) => {
        events.push(ev)
        return () => undefined
      },
    }

    withSilencedWarns(() => apply(ctxMock as never))

    assert.equal(registered.length, 17)
    assert.ok(events.includes('tools/pre-execute'), 'the approval gate must survive a prompt failure')
  })
})

/** Run `fn` with console.warn suppressed; returns the warnings that fired. */
function withSilencedWarns(fn: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warnings
}
// ─── Gap #1: copied text must belong to a REAL command / instruction set ────
//
// The client's whole interaction model is "copy a payload → paste it into the
// session". If the copied text references something that was never registered,
// the first step of the user journey silently fails. This suite locks that:

describe('client copy text ∈ registered command/instruction set (gap #1)', () => {
  const clientSource = readFileSync(resolve(root, 'src/client/index.ts'), 'utf8')

  it('the plugin registers NO commands — so the UI must not copy slash commands', () => {
    // `apply()` only ever registers tools + a system-prompt section; there is
    // no command / prompt-command registry anywhere in the entry point.
    const registeredCommands: string[] = []
    apply({
      tools: { register: () => undefined },
      systemPrompt: { section: () => undefined },
      on: () => () => undefined,
      command: { register: (c: { name: string }) => { registeredCommands.push(c.name) } },
      prompt: { register: (c: { name: string }) => { registeredCommands.push(c.name) } },
    } as never)
    assert.deepEqual(registeredCommands, [], 'no dsh command API is in use')

    // …and the client must not pretend otherwise: no `/…` copy payload.
    // Strip comments first — prose may legitimately mention `/iterate` when
    // explaining that it does NOT exist.
    const code = clientSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const slashLiterals = [...code.matchAll(/['"`](\/[a-z][\w -]*)['"`]/g)]
      .map((m) => m[1]!)
      .filter((s) => s !== '/' && !s.startsWith('//'))
    assert.deepEqual(
      slashLiterals.filter((s) => s.startsWith('/iterate')),
      [],
      `client must not copy slash commands (found: ${slashLiterals.join(', ')})`,
    )
  })

  it('the startup CTA copies the registered START_INSTRUCTIONS, verbatim', () => {
    // Importing the same constants the component renders guarantees the CTA
    // text cannot drift from the instruction set the tests validate.
    assert.ok(START_INSTRUCTIONS.full.length > 0)
    assert.ok(START_INSTRUCTIONS.reviewOnly.length > 0)
    assert.match(START_INSTRUCTIONS.full, /workflow/)
    assert.match(START_INSTRUCTIONS.reviewOnly, /workflow/)
    assert.ok(
      clientSource.includes('START_INSTRUCTIONS'),
      'StartIterationButton must copy from the START_INSTRUCTIONS registry',
    )
    // The built artifact the browser actually loads must carry them too.
    const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
    assert.ok(bundle.includes('START_INSTRUCTIONS'), 'bundle must expose the instruction registry')
    assert.ok(bundle.includes('iterate_triage'), 'bundle must carry the apply instruction')
  })

  it('every iterate_* tool the client names is one of the 17 registered tools', () => {
    const referenced = new Set([...clientSource.matchAll(/\biterate_[a-z_]+\b/g)].map((m) => m[0]!))
    // localStorage key fixture, not a tool.
    referenced.delete('iterate_storage_test__')
    const unknown = [...referenced].filter((t) => !REGISTERED_TOOLS.includes(t))
    assert.deepEqual(unknown, [], `client references unregistered tools: ${unknown.join(', ')}`)
    assert.ok(referenced.size >= 10, `expected the client to reach most tools, saw ${referenced.size}`)
  })
})
