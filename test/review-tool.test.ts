/**
 * Execute-level tests for the `iterate_review` TOOL (src/tools/review.ts):
 * argument-boundary guarding, round-cap clamping, schema gate wiring, and the
 * meta-review evidence read set. The deterministic core (src/review.ts,
 * src/meta-review.ts) has its own test files — this file pins the boundary
 * between model-authored arguments and that core.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerReviewTool } from '../src/tools/review.ts'

/** Capture the iterate_review definition (execute + presenter) for tests. */
function captureReviewDef(): {
  execute: (a: unknown, e: unknown) => Promise<unknown>
  presentResult?: (a: unknown, r: { content?: unknown; isError?: unknown }) => unknown
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    presentResult?: (a: unknown, r: { content?: unknown; isError?: unknown }) => unknown
  } | null = null
  registerReviewTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_review was not registered')
  return def
}

/** Capture the iterate_review tool's execute so tests can drive it. */
function captureReviewTool(): (args: unknown) => Promise<Record<string, unknown>> {
  const def = captureReviewDef()
  const exec = { signal: new AbortController().signal }
  return async (args: unknown) => (await def.execute(args, exec as never)) as Record<string, unknown>
}

/** Mirror the tool's JSON render as the durable content projection presenters receive. */
const asContent = (value: unknown): Array<{ type: string; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/** A temp project root + cleanup. */
function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-review-tool-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A schema-complete finding (every REQUIRED_FINDING_FIELD present). */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: 'correctness',
    file: 'src/a.ts',
    line: 3,
    severity: 'high',
    summary: 'Guard the input',
    failure_scenario: 'A null input crashes the parser.',
    suggested_fix: 'Reject null.',
    is_atomic: true,
    ...over,
  }
}

describe('iterate_review plan', () => {
  it('returns a well-formed plan with a sane round cap', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      const res = await run({ operation: 'plan', path: dir })
      assert.equal(res.operation, 'plan')
      assert.equal(res.mode, 'dry-run')
      assert.equal(res.found, true)
      assert.equal(res.error, undefined)
      const plan = res.plan as {
        goal: string
        scope: string
        dimensions: Array<{ id: string; reviewerPrompt: string; findingsSchema: Record<string, unknown> }>
        maxReviewRounds: number
        knownIntentional: unknown[]
        changedFiles: unknown[]
        fallbackToFull: boolean
        reasoningEffort: string | null
      }
      assert.equal(typeof plan.goal, 'string')
      assert.equal(plan.scope, 'full')
      assert.ok(plan.dimensions.length > 0, 'at least one dimension reviewer task')
      for (const d of plan.dimensions) {
        assert.ok(d.id, 'each dimension task has an id')
        assert.ok(d.reviewerPrompt.includes('EVIDENCE RULE'), 'reviewer prompts carry the evidence rule')
        assert.ok(d.findingsSchema && typeof d.findingsSchema === 'object')
      }
      assert.ok(
        Number.isInteger(plan.maxReviewRounds) && plan.maxReviewRounds >= 1,
        `expected a positive integer cap, got ${String(plan.maxReviewRounds)}`,
      )
      assert.deepEqual(plan.knownIntentional, [])
      assert.deepEqual(plan.changedFiles, [])
      assert.equal(plan.fallbackToFull, false)
      assert.equal(plan.reasoningEffort, null)
    } finally {
      cleanup()
    }
  })

  it('clamps a non-positive maxReviewRounds to 1', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      for (const value of [0, -5]) {
        const res = await run({ operation: 'plan', path: dir, maxReviewRounds: value })
        assert.equal(res.error, undefined)
        assert.equal((res.plan as { maxReviewRounds: number }).maxReviewRounds, 1)
      }
    } finally {
      cleanup()
    }
  })
})

describe('iterate_review aggregate', () => {
  it('merges valid rounds into a deduped, converged report', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      const res = await run({
        operation: 'aggregate',
        path: dir,
        mode: 'dry-run',
        rounds: [
          // Same finding twice in round 1 → cross-round/within-round dedupe.
          { round: 1, findings: [finding(), finding()], readFiles: ['src/a.ts'] },
          { round: 2, findings: [] },
        ],
      })
      assert.equal(res.error, undefined)
      assert.equal(res.operation, 'aggregate')
      const report = res.report as {
        mode: string
        findings: unknown[]
        rounds: Array<{ round: number; findings: unknown[]; readFiles: string[] }>
        readFiles: string[]
        convergence: { totalRounds: number; findingsByRound: number[]; converged: boolean; stoppedReason: string }
        summary: { totalFindings: number; byDimension: Record<string, number> }
        maxReviewRounds: number
      }
      assert.equal(report.mode, 'dry-run')
      assert.equal(report.findings.length, 1)
      assert.equal(report.rounds.length, 2)
      assert.deepEqual(report.readFiles, ['src/a.ts'])
      assert.equal(report.convergence.totalRounds, 2)
      assert.deepEqual(report.convergence.findingsByRound, [1, 0])
      assert.equal(report.convergence.converged, true)
      assert.equal(report.convergence.stoppedReason, 'converged')
      assert.equal(report.summary.totalFindings, 1)
      assert.equal(report.summary.byDimension.correctness, 1)
      assert.ok(report.maxReviewRounds >= 1)
      // The schema gate reports per-round results when it is enabled (default).
      const schemaValidation = res.schemaValidation as Array<{ round: number; valid: boolean; issues: unknown[] }>
      assert.ok(Array.isArray(schemaValidation))
      assert.equal(schemaValidation.length, 2)
      assert.equal(schemaValidation[0]!.round, 1)
      assert.equal(schemaValidation[0]!.valid, true)
      assert.deepEqual(schemaValidation[0]!.issues, [])
    } finally {
      cleanup()
    }
  })

  it('clamps a non-positive maxReviewRounds to 1 (same floor the plan uses)', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      for (const value of [0, -5]) {
        const res = await run({
          operation: 'aggregate',
          path: dir,
          maxReviewRounds: value,
          rounds: [{ round: 1, findings: [finding()] }],
        })
        assert.equal(res.error, undefined)
        assert.equal((res.report as { maxReviewRounds: number }).maxReviewRounds, 1)
      }
    } finally {
      cleanup()
    }
  })

  it('treats a non-array knownIntentional as "no known entries" instead of crashing', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      // `type:'json'` passes schema validation for ANY JSON value; a bare
      // string/object used to reach filterKnownIntentional → `.some` TypeError
      // escaping execute. Non-arrays mean "no known-intentional" (sibling
      // semantics), so the finding survives unfiltered.
      for (const junk of ['oops', { file: 'src/a.ts' }, 42, null]) {
        const res = await run({
          operation: 'aggregate',
          path: dir,
          rounds: [{ round: 1, findings: [finding()] }],
          knownIntentional: junk,
        })
        assert.equal(res.error, undefined, `junk ${JSON.stringify(junk)} must not error`)
        assert.equal((res.report as { findings: unknown[] }).findings.length, 1)
      }
      // Junk ELEMENTS inside an array are filtered element-wise, not crashing.
      const inArray = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [{ round: 1, findings: [finding()] }],
        knownIntentional: [42, null, 'x'],
      })
      assert.equal(inArray.error, undefined)
      assert.equal((inArray.report as { findings: unknown[] }).findings.length, 1)
      // A well-formed entry still filters (the guard must not over-filter).
      const filtered = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [{ round: 1, findings: [finding()] }],
        knownIntentional: [{ file: 'src/a.ts', line: 3, dimension: 'correctness', reason: 'by design' }],
      })
      assert.equal(filtered.error, undefined)
      assert.equal((filtered.report as { findings: unknown[] }).findings.length, 0)
    } finally {
      cleanup()
    }
  })

  it('drops fractional rounds at the tool boundary', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      const res = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [
          { round: 1, findings: [finding({ summary: 'integer round' })] },
          { round: 1.5, findings: [finding({ summary: 'fractional round', file: 'src/b.ts' })] },
        ],
      })
      assert.equal(res.error, undefined)
      const report = res.report as {
        rounds: Array<{ round: number }>
        findings: Array<{ summary: string }>
        convergence: { findingsByRound: number[] }
      }
      // The 1.5 round never reaches the core: one round, one finding, and the
      // convergence series has a single slot (round 1).
      assert.equal(report.rounds.length, 1)
      assert.equal(report.rounds[0]!.round, 1)
      assert.equal(report.findings.length, 1)
      assert.equal(report.findings[0]!.summary, 'integer round')
      assert.equal(report.convergence.findingsByRound.length, 1)

      // A rounds array whose only round is fractional is "no usable rounds".
      const allFractional = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [{ round: 2.5, findings: [finding()] }],
      })
      assert.match(String(allFractional.error), /non-empty array/)
    } finally {
      cleanup()
    }
  })

  it('reports the schema gate verdict and drops schema-invalid findings', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      const res = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [
          {
            round: 1,
            findings: [
              // Missing required fields (summary/severity/…) → flagged + dropped.
              { dimension: 'correctness', file: 'src/a.ts' },
              finding({ summary: 'valid finding' }),
            ],
          },
        ],
      })
      assert.equal(res.error, undefined)
      const schemaValidation = res.schemaValidation as Array<{ valid: boolean; issues: unknown[] }>
      assert.ok(Array.isArray(schemaValidation))
      assert.equal(schemaValidation[0]!.valid, false)
      assert.ok(schemaValidation[0]!.issues.length > 0)
      const report = res.report as { findings: Array<{ summary: string }> }
      assert.equal(report.findings.length, 1)
      assert.equal(report.findings[0]!.summary, 'valid finding')

      // Disabled → the gate reports nothing (null) but the call still succeeds.
      writeFileSync(join(dir, 'iterate.config.yaml'), 'reviewer:\n  output_schema_validation: false\n', 'utf-8')
      const off = await run({
        operation: 'aggregate',
        path: dir,
        rounds: [{ round: 1, findings: [finding()] }],
      })
      assert.equal(off.error, undefined)
      assert.equal(off.schemaValidation, null)
    } finally {
      cleanup()
    }
  })

  it('rejects an unknown operation (and a missing one) at the schema boundary', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const run = captureReviewTool()
      await assert.rejects(run({ operation: 'nope', path: dir }), /invalid arguments/)
      await assert.rejects(run({ path: dir }), /invalid arguments/)
      // Nothing else ran: no error-shaped result leaked through.
    } finally {
      cleanup()
    }
  })
})

describe('iterate_review meta-review evidence read set', () => {
  /** Seed a real file so evidence verification has something to anchor to. */
  function seedProject(dir: string): void {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      'export const a = 1\nexport const b = 2\nexport const c = 3\n',
      'utf-8',
    )
  }

  async function aggregateReport(
    run: (args: unknown) => Promise<Record<string, unknown>>,
    dir: string,
    readFiles: string[] | undefined,
  ): Promise<unknown> {
    const round: Record<string, unknown> = { round: 1, findings: [finding({ line: 2 })] }
    if (readFiles) round.readFiles = readFiles
    const res = await run({ operation: 'aggregate', path: dir, rounds: [round] })
    assert.equal(res.error, undefined)
    return res.report
  }

  it('anchors a finding to a reported READ file (readVerifiedRatio 1)', async () => {
    const { dir, cleanup } = tempProject()
    try {
      seedProject(dir)
      const run = captureReviewTool()
      const report = await aggregateReport(run, dir, ['src/a.ts'])
      const res = await run({ operation: 'meta-review', path: dir, report })
      assert.equal(res.error, undefined)
      const evidence = res.evidence as {
        checked: number
        passed: boolean
        readVerifiedRatio: number | null
      }
      assert.equal(evidence.checked, 1)
      assert.equal(evidence.passed, true)
      assert.equal(evidence.readVerifiedRatio, 1)
      assert.ok(res.finalReport, 'final report still produced')
    } finally {
      cleanup()
    }
  })

  it('stays "not checkable" (null) when the report carries no readFiles', async () => {
    const { dir, cleanup } = tempProject()
    try {
      seedProject(dir)
      const run = captureReviewTool()
      const report = await aggregateReport(run, dir, undefined)
      const res = await run({ operation: 'meta-review', path: dir, report })
      assert.equal(res.error, undefined)
      const evidence = res.evidence as { checked: number; passed: boolean; readVerifiedRatio: number | null }
      assert.equal(evidence.checked, 1)
      assert.equal(evidence.passed, true)
      // No read information → unknown, NOT a misleading 0.0.
      assert.equal(evidence.readVerifiedRatio, null)
    } finally {
      cleanup()
    }
  })

  it('reports 0 when the finding lives in a file the reviewer never read', async () => {
    const { dir, cleanup } = tempProject()
    try {
      seedProject(dir)
      const run = captureReviewTool()
      const report = await aggregateReport(run, dir, ['src/other.ts'])
      const res = await run({ operation: 'meta-review', path: dir, report })
      assert.equal(res.error, undefined)
      const evidence = res.evidence as { readVerifiedRatio: number | null }
      assert.equal(evidence.readVerifiedRatio, 0)
    } finally {
      cleanup()
    }
  })
})

describe('iterate_review presentResult (#12)', () => {
  it('headlines aggregate + meta-review results and declines every other shape', async () => {
    const { dir, cleanup } = tempProject()
    try {
      const def = captureReviewDef()
      const exec = { signal: new AbortController().signal }
      const res = (await def.execute(
        {
          operation: 'aggregate',
          path: dir,
          mode: 'dry-run',
          rounds: [{
            round: 1,
            findings: [finding(), finding({ severity: 'critical', summary: 'Worse bug', failure_scenario: 'x', suggested_fix: 'y' })],
            readFiles: ['src/a.ts'],
          }],
        },
        exec as never,
      )) as Record<string, unknown>
      const card = def.presentResult!(
        { operation: 'aggregate' },
        { content: asContent(res), isError: false },
      ) as { card: string; title: string }
      assert.equal(card.card, 'generic')
      assert.match(card.title, /^Review report: 2 findings \(1 critical, 1 high\)/, `headline: ${card.title}`)
      assert.match(card.title, /converged/, `headline: ${card.title}`)

      const metaRes = (await def.execute(
        { operation: 'meta-review', path: dir, report: res.report },
        exec as never,
      )) as Record<string, unknown>
      const metaCard = def.presentResult!(
        { operation: 'meta-review' },
        { content: asContent(metaRes), isError: false },
      ) as { card: string; title: string }
      assert.equal(metaCard.card, 'generic')
      assert.match(metaCard.title, /^Meta-review: (approved|needs_revision)/, `headline: ${metaCard.title}`)

      // `plan` is not carded; failure results and content the presenter cannot
      // parse decline so the UI falls back to the raw result.
      assert.equal(def.presentResult!({ operation: 'plan' }, { content: asContent(res), isError: false }), undefined)
      assert.equal(def.presentResult!({ operation: 'aggregate' }, { content: asContent(res), isError: true }), undefined)
      assert.equal(
        def.presentResult!({ operation: 'aggregate' }, { content: [{ type: 'text', text: 'not json' }], isError: false }),
        undefined,
      )
      // A payload without the report summary → decline instead of a wrong count.
      assert.equal(
        def.presentResult!({ operation: 'aggregate' }, { content: asContent({ operation: 'aggregate' }), isError: false }),
        undefined,
      )
    } finally {
      cleanup()
    }
  })
})
