import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { ITERATE_SKILL_PROMPT } from '../src/skill-prompt.ts'

/**
 * Execute one extracted ```js workflow script from the skill prompt inside a
 * sandbox vm, stubbing the `agent`/`parallel`/`phase`/`log` globals the scripts
 * rely on. This is a REAL execution regression test: it would have caught the
 * `reviewersOk` ReferenceError (a block-scoped const read outside its block
 * crashed BOTH canonical workflows after the first review round) and guards the
 * resume round-accounting (`lastRound`) from regressing.
 */
async function runWorkflowScript(code: string, scenario: {
  mode: 'dry-run' | 'normal'
  maxRounds?: number
  resumeCheckpoint?: { round: number; fixedCount: number; findings: unknown[]; resumeCount: number } | null
  schemaRetry?: boolean
}): Promise<Record<string, unknown>> {
  const sb = {
    args: { mode: scenario.mode, ...(scenario.maxRounds ? { maxRounds: scenario.maxRounds } : {}) },
    agent: async (prompt: string): Promise<Record<string, unknown>> => {
      if (prompt.includes('operation:"plan"')) {
        return {
          plan: {
            goal: 'test goal',
            dimensions: [
              { id: 'quality', reviewerPrompt: 'Review dimension "quality".', findingsSchema: { type: 'object' } },
              { id: 'security', reviewerPrompt: 'Review dimension "security".', findingsSchema: { type: 'object' } },
            ],
            maxReviewRounds: scenario.maxRounds ?? 2,
            knownIntentional: [],
          },
        }
      }
      if (prompt.includes('iterate_transcript') && prompt.includes('operation:"read"')) return { nudge: null }
      if (prompt.includes('iterate_transcript') && prompt.includes('capture')) return { operation: 'ok' }
      if (prompt.includes('iterate_config')) return { config: { atomic: { max_lines: 20 } } }
      if (prompt.includes('iterate_checkpoint') && prompt.includes('load')) {
        return scenario.resumeCheckpoint ? { checkpoint: scenario.resumeCheckpoint } : { checkpoint: null }
      }
      if (prompt.includes('iterate_checkpoint') && prompt.includes('save')) return {}
      if (prompt.includes('iterate_checkpoint') && prompt.includes('clear')) return { ok: true, existed: true }
      if (prompt.includes('iterate_status')) {
        return { ok: true, currentRound: 1, totalRounds: 1, fixedCount: 0, architecturalCount: 0, findingsCount: 0, hasCheckpoint: false }
      }
      if (prompt.includes('operation:"aggregate"')) {
        // Schema-retry scenario: the FIRST aggregate reports the round's output
        // as schema-invalid so the canonical retry loop re-runs reviewers; the
        // second (and any later) aggregate is valid and converged.
        if (scenario.schemaRetry && (sb as { aggregateCalls?: number }).aggregateCalls === 0) {
          ;(sb as { aggregateCalls?: number }).aggregateCalls = 1
          return { schemaValidation: [{ round: 1, valid: false }] }
        }
        return {
          report: {
            goal: 'test goal',
            findings: [],
            summary: { totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, byDimension: {} },
            convergence: { findingsByRound: [0], totalRounds: 1, converged: true, stoppedReason: 'converged' },
          },
          schemaValidation: [],
        }
      }
      if (prompt.includes('meta-review')) {
        return { finalReport: { verdict: 'approved', metaReview: { issues: [], checksRun: 1 } } }
      }
      if (prompt.includes('iterate_decision_log') && prompt.includes('append')) return {}
      if (prompt.includes('iterate_validate')) return { results: [] }
      if (prompt.includes('Apply the fixes')) return { fixes: [] }
      if (prompt.includes('iterate_rollback')) return { results: [] }
      return { findings: [], readFiles: [] }
    },
    parallel: async (thunks: (() => Promise<unknown>)[]): Promise<unknown[]> => {
      const out: unknown[] = []
      for (const t of thunks) out.push(await t())
      return out
    },
    phase: () => {},
    log: () => {},
    console,
  }
  const context = vm.createContext(sb)
  const promise = vm.runInContext(
    `(async () => {\n${code}\n})()`,
    context,
    { filename: `${scenario.mode}-workflow.js` },
  ) as Promise<Record<string, unknown>>
  return await promise
}

const extractWorkflowScripts = (): string[] =>
  [...ITERATE_SKILL_PROMPT.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!)

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

  it('reads the config with a plain read, not validate-only (which omits the config key)', () => {
    assert.ok(ITERATE_SKILL_PROMPT.includes('Call iterate_config({}) '))
    assert.ok(!ITERATE_SKILL_PROMPT.includes('iterate_config({ validate: true })'))
  })

  it('never instructs reviewers to report a failed/invalid round as converged', () => {
    assert.ok(ITERATE_SKILL_PROMPT.includes('schema-invalid findings'))
    assert.ok(!ITERATE_SKILL_PROMPT.includes('findingsByRound[r-1] === 0'))
  })
})

describe('ITERATE_SKILL_PROMPT canonical workflow scripts (runtime)', () => {
  it('contains exactly the dry-run and normal-mode scripts', () => {
    assert.equal(extractWorkflowScripts().length, 2)
  })

  it('dry-run script executes to a converged report without throwing', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[0]!, { mode: 'dry-run' })
    assert.equal(res.mode, 'dry-run')
    assert.equal(res.converged, true)
    assert.equal(res.rounds, 1)
    assert.equal(res.status !== undefined, false)
  })

  it('normal-mode script (fresh run) executes, converges and clears the checkpoint', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[1]!, { mode: 'normal', maxRounds: 2 })
    assert.equal(res.mode, 'normal')
    assert.equal(res.converged, true)
    assert.equal(res.abortedByValidation, false)
    assert.equal(res.schemaFailed, false)
    assert.equal(res.roundsExecuted, 1)
  })

  it('normal-mode script on a RESUME reports the true last round, not the count of run rounds', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 5,
      resumeCheckpoint: { round: 3, fixedCount: 2, findings: [], resumeCount: 0 },
    })
    assert.equal(res.converged, true)
    // Resumed at round 4; with zero findings it converges immediately. The
    // returned roundsExecuted must be 4 (the round actually reached), NOT the
    // number of loop pushes (1) — a regression that broke resume accounting.
    assert.equal(res.roundsExecuted, 4)
    assert.equal(res.abortedByValidation, false)
    assert.equal(res.schemaFailed, false)
  })

  it('schema-retry path re-runs without crashing the round bookkeeping', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[0]!, { mode: 'dry-run', schemaRetry: true })
    assert.equal(res.converged, true)
  })
})
