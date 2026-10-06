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
/** One dispatched `agent()` call (prompt + its opts), for call-shape assertions. */
interface AgentCall {
  prompt: string
  opts: Record<string, unknown>
}

async function runWorkflowScript(code: string, scenario: {
  mode: 'dry-run' | 'normal'
  maxRounds?: number
  resumeCheckpoint?: { round: number; fixedCount: number; findings: unknown[]; resumeCount: number } | null
  schemaRetry?: boolean
  /** Per-run sub-agent backend override forwarded through args (provider/model hints). */
  subagentProvider?: string
  subagentModel?: string
  /** Every reviewer subagent resolves null (documented child-failure behavior). */
  reviewersFail?: boolean
  /** Findings the aggregate stub puts on report.findings (normal-mode scenarios). */
  reportFindings?: unknown[]
  /** Override the aggregate result by call index; return undefined for the default. */
  aggregate?: (callIndex: number) => Record<string, unknown> | null | undefined
  /** What the validate subagent returns (null = child failure). */
  validateResult?: Record<string, unknown> | null
  /** What the fixer subagent returns. */
  fixResult?: Record<string, unknown>
  /** `validation.commands` shape the iterate_config stub returns (default: one passing command). `null` = a config with NO validation.commands. */
  validationCommands?: Record<string, string[]> | null
  /** Explicit caller opt-in that skips validation entirely (args.unverified). */
  unverified?: boolean
  /** Nudge text returned by the Nth transcript read (round 1, round 2, …). */
  nudge?: (readIndex: number) => string | null
  /** Observer invoked for every agent() call (prompt + dispatched opts). */
  onCall?: (prompt: string, opts: Record<string, unknown>) => void
}): Promise<Record<string, unknown>> {
  let aggregateCalls = 0
  let transcriptReads = 0
  const sb = {
    args: {
      mode: scenario.mode,
      ...(scenario.maxRounds ? { maxRounds: scenario.maxRounds } : {}),
      ...(scenario.subagentProvider ? { subagentProvider: scenario.subagentProvider } : {}),
      ...(scenario.subagentModel ? { subagentModel: scenario.subagentModel } : {}),
      ...(scenario.unverified ? { unverified: true } : {}),
    },
    agent: async (prompt: string, opts: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
      scenario.onCall?.(prompt, opts)
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
      if (prompt.includes('iterate_transcript') && prompt.includes('operation:"read"')) {
        const readIndex = transcriptReads++
        return { nudge: scenario.nudge ? scenario.nudge(readIndex) : null }
      }
      if (prompt.includes('iterate_transcript') && prompt.includes('capture')) return { operation: 'ok' }
      if (prompt.includes('iterate_config')) {
        // Default: a project WITH a trusted validation command. Scenario knob
        // `validationCommands: null` models a config that never defined any
        // (the #2 preflight case).
        const commands = scenario.validationCommands === undefined ? { test: ['npm test'] } : scenario.validationCommands
        return {
          config: {
            atomic: { max_lines: 20 },
            ...(commands ? { validation: { commands } } : {}),
          },
        }
      }
      if (prompt.includes('iterate_checkpoint') && prompt.includes('operation: "resume"')) {
        // Mirrors the tool's resume contract: it loads AND bumps resumeCount
        // (and persists that bump), so a later interrupted run still counts it.
        return scenario.resumeCheckpoint
          ? { ok: true, checkpoint: { ...scenario.resumeCheckpoint, resumeCount: scenario.resumeCheckpoint.resumeCount + 1 } }
          : { ok: false, error: 'no checkpoint to resume — run `save` first' }
      }
      if (prompt.includes('iterate_checkpoint') && prompt.includes('load')) {
        return scenario.resumeCheckpoint ? { checkpoint: scenario.resumeCheckpoint } : { checkpoint: null }
      }
      if (prompt.includes('iterate_checkpoint') && prompt.includes('save')) return {}
      if (prompt.includes('iterate_checkpoint') && prompt.includes('clear')) return { ok: true, existed: true }
      if (prompt.includes('iterate_status')) {
        return { ok: true, currentRound: 1, totalRounds: 1, fixedCount: 0, architecturalCount: 0, findingsCount: 0, hasCheckpoint: false }
      }
      if (prompt.includes('operation:"aggregate"')) {
        const index = aggregateCalls++
        // Scenario hook: first N aggregate calls can fail (null / object
        // without a report) to model a child failure.
        if (scenario.aggregate) {
          const override = scenario.aggregate(index)
          if (override !== undefined) return override
        }
        // Schema-retry scenario: the FIRST aggregate reports the round's output
        // as schema-invalid so the canonical retry loop re-runs reviewers; the
        // second (and any later) aggregate is valid and converged.
        if (scenario.schemaRetry && index === 0) {
          return { schemaValidation: [{ round: 1, valid: false }] }
        }
        const findings = scenario.reportFindings ?? []
        return {
          report: {
            goal: 'test goal',
            findings,
            summary: { totalFindings: findings.length, critical: 0, high: 0, medium: 0, low: 0, byDimension: {} },
            convergence: { findingsByRound: [0], totalRounds: 1, converged: true, stoppedReason: 'converged' },
          },
          schemaValidation: [],
        }
      }
      if (prompt.includes('meta-review')) {
        return { finalReport: { verdict: 'approved', metaReview: { issues: [], checksRun: 1 } } }
      }
      if (prompt.includes('iterate_decision_log') && prompt.includes('append')) return {}
      if (prompt.includes('iterate_validate')) {
        // Default: the configured command ran and PASSED. An empty result set
        // is now the fail-closed case (#2), so it is only produced when a test
        // asks for it explicitly via `validateResult: { results: [] }`.
        return scenario.validateResult !== undefined
          ? scenario.validateResult
          : { results: [{ command: 'npm test', exitCode: 0, allowed: true }] }
      }
      if (prompt.includes('Apply the fixes')) return scenario.fixResult ?? { fixes: [] }
      if (prompt.includes('iterate_rollback')) return { results: [] }
      // Reviewer subagents are the only calls that reach this fallthrough.
      if (scenario.reviewersFail) return null
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

  // ── finding 1: dry-run thisRound hoist (aggregate child failure) ──────────

  it('dry-run: an aggregate child failure (null) surfaces a structured failure, not a ReferenceError', async () => {
    const scripts = extractWorkflowScripts()
    // With the old block-scoped `const thisRound` the round-convergence
    // fallback threw `ReferenceError: thisRound is not defined` BEFORE the
    // script could reach its designed aggregate-failure guard.
    await assert.rejects(
      runWorkflowScript(scripts[0]!, { mode: 'dry-run', aggregate: () => null }),
      /aggregate failed: no valid report was produced/,
    )
  })

  it('dry-run: an aggregate result without a report ({}) completes without a ReferenceError', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[0]!, {
      mode: 'dry-run',
      aggregate: (index) => (index === 0 ? {} : undefined),
    })
    assert.equal(res.converged, true)
    assert.equal(res.rounds, 1)
  })

  // ── finding 2: normal-mode thisRound hoist ────────────────────────────────

  it('normal: an aggregate child failure (null) falls back to the round findings without a ReferenceError', async () => {
    const scripts = extractWorkflowScripts()
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      aggregate: () => null,
    })
    assert.equal(res.mode, 'normal')
    assert.equal(res.converged, true)
    assert.equal(res.roundsExecuted, 1)
  })

  // ── finding 3: prototype-polluting file names in fix grouping ─────────────

  it('normal: model-controlled file names (__proto__/constructor) do not crash fix grouping', async () => {
    const scripts = extractWorkflowScripts()
    const mkFinding = (file: string) => ({
      dimension: 'quality', file, line: 1, severity: 'high',
      summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
    })
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      reportFindings: [mkFinding('__proto__'), mkFinding('constructor')],
    })
    // Both rounds ran (and grouped fixes per file) without a TypeError from
    // `byFile[file].push(...)` resolving an inherited Object.prototype/Object.
    assert.equal(res.mode, 'normal')
    assert.equal(res.roundsExecuted, 2)
    assert.equal(res.converged, false)
  })

  // ── finding 4: failed validate subagent must fail CLOSED ──────────────────

  it('normal: a failed validate subagent aborts before the checkpoint (fails closed)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 3,
      validateResult: null,
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.validationUnavailable, true)
    assert.equal(res.abortedByValidation, true)
    assert.equal(res.schemaFailed, false)
    assert.equal(res.stoppedReason, 'aborted_by_validation')
    assert.equal(res.converged, false)
    assert.equal(res.roundsExecuted, 1)
    // Structured failure recorded in the audit trail.
    assert.ok(calls.some(c => c.prompt.includes('type:"round_failed"') && c.prompt.includes('validation_unavailable')))
    // No checkpoint save / clear (the checkpoint must survive for a resume),
    // and no further round.
    assert.ok(!calls.some(c => c.prompt.includes('operation: "save"')), 'must not checkpoint after an unavailable validator')
    assert.ok(!calls.some(c => c.prompt.includes('operation: "clear"')), 'must not clear the checkpoint')
    assert.ok(!calls.some(c => c.prompt.includes('type:"round_start", round:2')), 'must not start round 2')
  })

  // ── finding 6: nudge re-read every round ──────────────────────────────────

  it('dry-run: a nudge written mid-run reaches round 2 reviewers (re-read each round)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    let nudgeReads = 0
    const res = await runWorkflowScript(scripts[0]!, {
      mode: 'dry-run',
      maxRounds: 2,
      // Round 1's transcript read sees no nudge yet; round 2's read picks up
      // steering written while round 1 was running.
      nudge: () => (nudgeReads++ === 0 ? null : 'STEER ROUND 2'),
      // Round 1 reports one finding (so the run cannot converge immediately);
      // round 2 uses the default converged aggregate.
      aggregate: (index) => (index === 0
        ? {
            report: {
              goal: 'test goal',
              findings: [],
              summary: { totalFindings: 1, critical: 0, high: 0, medium: 0, low: 0, byDimension: {} },
              convergence: { findingsByRound: [1], totalRounds: 1, converged: false, stoppedReason: 'max_rounds_reached' },
            },
            schemaValidation: [],
          }
        : undefined),
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.converged, true)
    const r1 = calls.find(c => c.opts.label === 'review:quality:r1')
    const r2 = calls.find(c => c.opts.label === 'review:quality:r2')
    assert.ok(r1 && r2, 'both rounds must dispatch reviewers')
    assert.ok(!r1.prompt.includes('STEER ROUND 2'), 'round 1 must not see a nudge written for round 2')
    assert.ok(r2.prompt.includes('STEER ROUND 2'), `round 2 reviewers must read the mid-run nudge: ${r2.prompt}`)
  })

  // ── finding 7: dry-run capture carries the computed stoppedReason ─────────

  it('dry-run: capture receives the computed stoppedReason (inconclusive when the last round was unusable)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[0]!, {
      mode: 'dry-run',
      reviewersFail: true,
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.converged, false)
    assert.equal(res.stoppedReason, 'inconclusive')
    const capture = calls.find(c => c.opts.label === 'transcript:capture')
    assert.ok(capture, 'capture must run')
    assert.ok(
      capture.prompt.includes('stoppedReason:"inconclusive"'),
      `capture must persist the computed reason: ${capture.prompt}`,
    )
  })

  // ── finding 8: post-loop calls carry the backend hint ─────────────────────

  it('normal: post-loop tool calls carry the sub-agent backend hint', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      subagentProvider: 'codex',
      subagentModel: 'm-test',
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    for (const label of ['report:log', 'status:final', 'checkpoint:clear', 'transcript:capture']) {
      const call = calls.find(c => c.opts.label === label)
      assert.ok(call, `call ${label} must be dispatched`)
      assert.equal(call.opts.provider, 'codex', `${label} must carry the provider hint`)
      assert.equal(call.opts.model, 'm-test', `${label} must carry the model hint`)
    }
  })

  // ── finding 9: checkpoint resume contract ─────────────────────────────────

  it('normal: resumes via operation:"resume" and trusts the tool-bumped resumeCount (no double add)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 5,
      resumeCheckpoint: { round: 3, fixedCount: 2, findings: [], resumeCount: 4 },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.roundsExecuted, 4)
    const resumeCalls = calls.filter(c => c.prompt.includes('operation: "resume"'))
    assert.equal(resumeCalls.length, 1, 'the load path must go through operation:"resume"')
    const save = calls.find(c => c.prompt.includes('operation: "save"'))
    assert.ok(save, 'round 4 must checkpoint')
    // The stub's resume already bumped 4 → 5 (as the real tool persists);
    // the script must save 5 — neither 6 (manual +1 double count) nor 4
    // (missed bump).
    assert.ok(save.prompt.includes('resumeCount:5'), `save must carry resumeCount:5: ${save.prompt}`)
    assert.ok(!save.prompt.includes('resumeCount:6'), 'resumeCount must not be double-bumped')
    assert.ok(!save.prompt.includes('resumeCount:4'), 'resumeCount must reflect the tool bump')
  })

  // ── finding 10: rollback bookkeeping ──────────────────────────────────────

  it('normal: validation failure rolls back and excludes the fixes from findingsFixed / capture', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      reportFindings: [{
        dimension: 'quality', file: 'src/a.ts', line: 10, severity: 'high',
        summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
      }],
      fixResult: { fixes: [{ id: 'fx-1', ok: true, file: 'src/a.ts', linesAdded: 1, linesRemoved: 1 }] },
      validateResult: { results: [{ command: 'npm test', exitCode: 1 }] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.abortedByValidation, true)
    assert.equal(res.validationUnavailable, false)
    assert.equal(res.stoppedReason, 'aborted_by_validation')
    assert.equal(res.converged, false)
    assert.deepEqual(res.failedCommands, ['npm test'])
    // The fix was applied then rolled back — it must NOT be reported as fixed.
    assert.equal(res.findingsFixed, 0)
    assert.ok(calls.some(c => c.prompt.includes('iterate_rollback') && c.prompt.includes('fx-1')), 'rollback must target fx-1')
    const capture = calls.find(c => c.opts.label === 'transcript:capture')
    assert.ok(capture, 'capture must run')
    const fixPayload = /fixes:(\[.*?\]), checkpoint:/.exec(capture.prompt)
    assert.ok(fixPayload, `capture must carry the fix records: ${capture.prompt}`)
    const fixes = JSON.parse(fixPayload[1]!) as { id: string; success: boolean }[]
    assert.equal(fixes.find(f => f.id === 'fx-1')?.success, false, 'capture must mark the rolled-back fix unsuccessful')
  })

  // ── finding 11: dry-run plan forwards maxRounds ───────────────────────────

  it('dry-run: forwards args.maxRounds into the plan call (like normal mode)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[0]!, {
      mode: 'dry-run',
      maxRounds: 3,
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    const plan = calls.find(c => c.opts.label === 'review:plan')
    assert.ok(plan, 'plan call must be dispatched')
    assert.ok(plan.prompt.includes('maxReviewRounds:3'), `plan prompt must forward args.maxRounds: ${plan.prompt}`)
  })

  // ── #2: zero-validation preflight ────────────────────────────────────────

  it('#2 preflight: a config WITHOUT validation.commands aborts before any work with an actionable message', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await assert.rejects(
      runWorkflowScript(scripts[1]!, {
        mode: 'normal',
        validationCommands: null,
        onCall: (prompt, opts) => calls.push({ prompt, opts }),
      }),
      /preflight failed: iterate\.config\.yaml has NO validation\.commands/,
    )
    // Stopped at preflight: no plan, no review, no capture.
    assert.ok(!calls.some(c => c.prompt.includes('operation:"plan"')), 'must abort before the plan')
    assert.ok(!calls.some(c => c.opts.label === 'transcript:capture'), 'must abort before any capture')
  })

  it('#2 preflight: args.unverified opts in explicitly — the run completes as UNVERIFIED, never as a verified pass', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      validationCommands: null,
      unverified: true,
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.unverified, true)
    assert.equal(res.zeroValidation, true)
    // NB: arrays that came back from the vm realm are foreign-realm objects —
    // compare structurally instead of with deepStrictEqual.
    assert.equal(Array.from(res.validations as unknown[]).length, 0)
    assert.equal(res.converged, true)
    assert.equal(res.stoppedReason, 'converged_unverified')
    // An unverified run must bank NOTHING as a verified experience (F9).
    assert.ok(!calls.some(c => String(c.opts.label).startsWith('experience:')), 'F9 must be skipped without validation')
  })

  it('#2: an EMPTY validation result set fails CLOSED (validationUnavailable + defense event, no checkpoint)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 3,
      validateResult: { results: [] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.validationUnavailable, true)
    assert.equal(res.abortedByValidation, true)
    assert.equal(res.converged, false)
    assert.equal(res.stoppedReason, 'aborted_by_validation')
    // Fail-closed audit trail: decision log + F10 defense event.
    assert.ok(calls.some(c => c.prompt.includes('type:"round_failed"') && c.prompt.includes('zero_validation_results')))
    const defense = calls.find(c => c.opts.label === 'defense:precondition_failed:r1')
    assert.ok(defense, 'the zero-result gate must record a defense event')
    assert.ok(defense.prompt.includes('validation produced zero results'))
    // The checkpoint must survive for a resume (same rule as a failed validator).
    assert.ok(!calls.some(c => c.prompt.includes('operation: "save"')), 'must not checkpoint after a zero-result round')
  })

  it('#2/#6: capture persists every validation outcome of a passing run', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[1]!, { mode: 'normal', onCall: (prompt, opts) => calls.push({ prompt, opts }) })
    const capture = calls.find(c => c.opts.label === 'transcript:capture')
    assert.ok(capture, 'capture must run')
    const payload = /validations:(\[.*?\]), rounds:/.exec(capture.prompt)
    assert.ok(payload, `capture must carry validations: ${capture.prompt}`)
    const validations = JSON.parse(payload[1]!) as Array<Record<string, unknown>>
    assert.deepEqual(validations, [{ round: 1, command: 'npm test', exitCode: 0, allowed: true }])
  })

  // ── #3: F8 / F9 / F10 command-center close-out ───────────────────────────

  it('#3 dry-run: computes the F8 quality gate and captures validations:[] (no F9/F10 in a read-only run)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[0]!, { mode: 'dry-run', onCall: (prompt, opts) => calls.push({ prompt, opts }) })
    const gate = calls.find(c => c.opts.label === 'quality-gate:compute')
    assert.ok(gate, 'dry-run must persist a quality certificate')
    assert.ok(gate.prompt.includes('operation:"compute"'), `F8 must be a compute call: ${gate.prompt}`)
    assert.ok(gate.prompt.includes('dimensions:["quality","security"]'), 'the gate must receive the planned dimensions')
    const capture = calls.find(c => c.opts.label === 'transcript:capture')
    assert.ok(capture, 'capture must run')
    assert.ok(capture.prompt.includes('validations:[]'), `a dry-run executes no validations: ${capture.prompt}`)
    assert.ok(!calls.some(c => String(c.opts.label).startsWith('experience:')), 'dry-run applies no fixes → no F9')
    assert.ok(!calls.some(c => String(c.opts.label).startsWith('defense:')), 'dry-run triggers no defenses → no F10')
  })

  it('#3 normal: computes the F8 gate from OPEN findings + validations, and banks verified fixes (F9)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      reportFindings: [{
        dimension: 'quality', file: 'src/a.ts', line: 10, severity: 'high',
        summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
      }],
      fixResult: { fixes: [{ id: 'fx-1', ok: true, file: 'src/a.ts', linesAdded: 1, linesRemoved: 1 }] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    const gate = calls.find(c => c.opts.label === 'quality-gate:compute')
    assert.ok(gate, 'normal run must persist a quality certificate')
    // BOTH executed rounds contribute their validation outcome (round 1 and
    // round 2 each ran the configured command).
    assert.ok(
      gate.prompt.includes('validationResults:[{"command":"npm test","exitCode":0},{"command":"npm test","exitCode":0}]'),
      `gate must carry every round's validations: ${gate.prompt}`,
    )
    // Both rounds fixed the finding → NOTHING is open, so it must not be
    // scored against the final gate…
    assert.ok(!gate.prompt.includes('"broken guard"'), 'a fixed finding must not count as open')
    // …the same finding re-fixed in round 2 still counts once (open/fixed
    // findings are deduped by file|dimension|summary, like the aggregate).
    assert.ok(gate.prompt.includes('fixedByDimension:{"quality":1}'), `closed findings must be reported as fixed: ${gate.prompt}`)
    // …but the convergence series still records what each round produced,
    // pre-zeroed for the dimension that found nothing.
    assert.ok(gate.prompt.includes('findingsByRound:{"quality":[1,1],"security":[0,0]}'), `per-dimension series required: ${gate.prompt}`)
    // F9: the validation-passed fix batch is banked as an experience entry.
    const exp = calls.find(c => c.opts.label === 'experience:add:r1')
    assert.ok(exp, 'verified fixes must be banked for the next round/session')
    assert.ok(exp.prompt.includes('operation:"add"'), `F9 must be an experience add: ${exp.prompt}`)
    assert.ok(exp.prompt.includes('"dimension":"quality"'), 'the entry must carry the finding dimension')
    assert.ok(exp.prompt.includes('"files":["src/a.ts"]'), 'the entry must carry the fixed file')
  })

  it('#3 normal: a rollback fires an F10 defense event and banks nothing (F9 skipped)', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      reportFindings: [{
        dimension: 'quality', file: 'src/a.ts', line: 10, severity: 'high',
        summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
      }],
      fixResult: { fixes: [{ id: 'fx-1', ok: true, file: 'src/a.ts', linesAdded: 1, linesRemoved: 1 }] },
      validateResult: { results: [{ command: 'npm test', exitCode: 1 }] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    const defense = calls.find(c => c.opts.label === 'defense:rollback:r1')
    assert.ok(defense, 'a rollback must be recorded as a defense event')
    assert.ok(defense.prompt.includes('type:"rollback"'), `defense event type must be rollback: ${defense.prompt}`)
    assert.ok(defense.prompt.includes('severity:"high"'), 'rollbacks are high severity')
    assert.ok(defense.prompt.includes('npm test'), 'the failing command must be part of the description')
    assert.ok(!calls.some(c => String(c.opts.label).startsWith('experience:')), 'a rolled-back fix is not a verified experience')
  })

  it('#3 normal: a schema-invalid round stops as schema_invalid and records a precondition defense event', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 3,
      aggregate: () => ({ schemaValidation: [{ round: 1, valid: false }] }),
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.schemaFailed, true)
    assert.equal(res.converged, false)
    assert.equal(res.stoppedReason, 'schema_invalid')
    const defense = calls.find(c => c.opts.label === 'defense:precondition_failed:r1')
    assert.ok(defense, 'an unusable round must be recorded as a precondition defense')
    assert.ok(defense.prompt.includes('reviewer output unusable'))
  })

  it('#3 normal: a fix iterate_fix refuses records an assumption_falsified defense event', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    const res = await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      reportFindings: [{
        dimension: 'quality', file: 'src/a.ts', line: 10, severity: 'high',
        summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
      }],
      fixResult: { fixes: [{ id: 'fx-1', ok: false, error: 'change exceeds atomic.max_lines' }] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    assert.equal(res.findingsFixed, 0)
    const defense = calls.find(c => c.opts.label === 'defense:assumption_falsified:r1')
    assert.ok(defense, 'a refused atomic fix falsifies the is_atomic assumption')
    assert.ok(defense.prompt.includes('type:"assumption_falsified"'), `defense event type must be assumption_falsified: ${defense.prompt}`)
  })

  it('#3 normal: the F8 compute and F9/F10 calls carry the sub-agent backend hint', async () => {
    const scripts = extractWorkflowScripts()
    const calls: AgentCall[] = []
    await runWorkflowScript(scripts[1]!, {
      mode: 'normal',
      maxRounds: 2,
      subagentProvider: 'codex',
      subagentModel: 'm-test',
      reportFindings: [{
        dimension: 'quality', file: 'src/a.ts', line: 10, severity: 'high',
        summary: 'broken guard', failure_scenario: 'crash', suggested_fix: 'guard', is_atomic: true,
      }],
      fixResult: { fixes: [{ id: 'fx-1', ok: true, file: 'src/a.ts', linesAdded: 1, linesRemoved: 1 }] },
      validateResult: { results: [{ command: 'npm test', exitCode: 1 }] },
      onCall: (prompt, opts) => calls.push({ prompt, opts }),
    })
    for (const label of ['quality-gate:compute', 'defense:rollback:r1']) {
      const call = calls.find(c => c.opts.label === label)
      assert.ok(call, `call ${label} must be dispatched`)
      assert.equal(call.opts.provider, 'codex', `${label} must carry the provider hint`)
      assert.equal(call.opts.model, 'm-test', `${label} must carry the model hint`)
    }
  })

  // ── #2/#3/#6: the prompt TEXT must teach the rules too ────────────────────

  it('teaches the preflight, fail-closed, unverified and F8/F9/F10 close-out rules', () => {
    for (const marker of [
      'Preflight before ANY work',
      'zero_validation_results',
      'converged_unverified',
      'max_rounds_unverified',
      'quality-gate:compute',
      'recordDefense',
      'Close-out for the command-center tabs',
      'per-round validation results',
    ]) {
      assert.ok(ITERATE_SKILL_PROMPT.includes(marker), `prompt must include ${marker}`)
    }
  })
})
