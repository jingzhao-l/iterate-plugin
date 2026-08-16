import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateRounds,
  buildReviewReport,
  buildReviewPlan,
  computeConvergence,
  dedupeFindings,
  filterKnownIntentional,
  findingKey,
  findingsSchema,
  normalizeSummary,
  reviewerTaskPrompt,
  SEVERITY_RANK,
  sortFindings,
} from '../src/review.ts'
import type { IterateConfig, ReviewFinding } from '../src/types.ts'

const f = (partial: Partial<ReviewFinding>): ReviewFinding => ({
  dimension: 'correctness',
  file: 'src/a.ts',
  severity: 'medium',
  summary: 'A problem',
  failure_scenario: 'fails when x happens',
  suggested_fix: 'do y instead',
  is_atomic: true,
  ...partial,
})

const baseConfig: IterateConfig = {
  goal: 'Improve quality',
  max_rounds: 7,
  language: 'en',
  dimensions: ['correctness', 'security'],
  review: { scope: 'full' },
  atomic: { max_lines: 20, max_adjacent_methods: 3 },
  git: {
    target_branch: 'main',
    use_worktree: false,
    push_per_round: false,
    auto_merge: false,
  },
  validation: { command_whitelist: ['pytest'], commands: { test: ['pytest tests/ -x -q'] } },
  reviewer: { output_schema_validation: true },
}

describe('severity / sorting', () => {
  it('SEVERITY_RANK orders critical < high < medium < low', () => {
    assert.ok(SEVERITY_RANK.critical < SEVERITY_RANK.high)
    assert.ok(SEVERITY_RANK.high < SEVERITY_RANK.medium)
    assert.ok(SEVERITY_RANK.medium < SEVERITY_RANK.low)
  })

  it('sortFindings sorts most severe first, then by file and line', () => {
    const input = [
      f({ file: 'z.ts', severity: 'low', summary: 'low in z' }),
      f({ file: 'a.ts', severity: 'high', summary: 'high in a' }),
      f({ file: 'a.ts', severity: 'critical', summary: 'critical in a' }),
    ]
    const sorted = sortFindings(input)
    assert.deepEqual(
      sorted.map((x) => x.severity),
      ['critical', 'high', 'low'],
    )
    // Same severity → file asc, line asc
    const tie = sortFindings([
      f({ file: 'b.ts', line: 10, severity: 'high' }),
      f({ file: 'a.ts', line: 5, severity: 'high' }),
      f({ file: 'a.ts', line: 1, severity: 'high' }),
    ])
    assert.deepEqual(
      tie.map((x) => `${x.file}:${x.line}`),
      ['a.ts:1', 'a.ts:5', 'b.ts:10'],
    )
  })

  it('sortFindings does not mutate the input array', () => {
    const input = [f({ severity: 'low' }), f({ severity: 'critical' })]
    const copy = [...input]
    sortFindings(input)
    assert.deepEqual(input, copy)
  })
})

describe('dedupe', () => {
  it('normalizeSummary trims, lowercases and collapses whitespace', () => {
    assert.equal(normalizeSummary('  Foo  Bar\tBaz  '), 'foo bar baz')
  })

  it('findingKey combines file, dimension and normalized summary', () => {
    const a = f({ file: 'a.ts', dimension: 'x', summary: '  Crash HERE ' })
    const b = f({ file: 'a.ts', dimension: 'x', summary: 'crash here' })
    assert.equal(findingKey(a), findingKey(b))
    assert.notEqual(findingKey(f({ file: 'a.ts' })), findingKey(f({ file: 'b.ts' })))
  })

  it('dedupeFindings removes exact duplicates, keeps first occurrence', () => {
    const input = [
      f({ summary: 'same issue', suggested_fix: 'first' }),
      f({ summary: '  SAME issue ', suggested_fix: 'second (duplicate)' }),
      f({ summary: 'different', suggested_fix: 'third' }),
    ]
    const out = dedupeFindings(input)
    assert.equal(out.length, 2)
    assert.equal(out[0]!.suggested_fix, 'first')
  })

  it('dedupeFindings keeps findings that differ only by dimension', () => {
    const input = [
      f({ dimension: 'correctness', summary: 'x' }),
      f({ dimension: 'security', summary: 'x' }),
    ]
    assert.equal(dedupeFindings(input).length, 2)
  })
})

describe('known_intentional filter', () => {
  it('filters exact line match with same file + dimension', () => {
    const out = filterKnownIntentional(
      [f({ file: 'a.ts', line: 42, dimension: 'security', summary: 'x' })],
      [{ file: 'a.ts', line: 42, dimension: 'security', reason: 'intentional' }],
    )
    assert.equal(out.length, 0)
  })

  it('line=0 / undefined means whole file', () => {
    const entries = [
      { file: 'a.ts', dimension: 'security', reason: 'whole file' },
      { file: 'b.ts', line: 0, dimension: 'security', reason: 'whole file b' },
    ]
    const out = filterKnownIntentional(
      [
        f({ file: 'a.ts', line: 7, dimension: 'security' }),
        f({ file: 'b.ts', line: 99, dimension: 'security' }),
      ],
      entries,
    )
    assert.equal(out.length, 0)
  })

  it('does NOT filter when file, dimension or line differ', () => {
    const out = filterKnownIntentional(
      [
        f({ file: 'a.ts', line: 43, dimension: 'security' }), // line mismatch
        f({ file: 'a.ts', line: 42, dimension: 'correctness' }), // dim mismatch
        f({ file: 'c.ts', line: 42, dimension: 'security' }), // file mismatch
      ],
      [{ file: 'a.ts', line: 42, dimension: 'security', reason: 'intentional' }],
    )
    assert.equal(out.length, 3)
  })

  it('returns findings unchanged when known list is empty/undefined', () => {
    const input = [f({}), f({})]
    assert.equal(filterKnownIntentional(input, undefined), input)
    assert.equal(filterKnownIntentional(input, []).length, 2)
  })
})

describe('multi-round convergence', () => {
  it('aggregateRounds tracks first-seen round across duplicate re-reports', () => {
    const { findings, findingsByRound } = aggregateRounds(
      [
        { round: 1, findings: [f({ summary: 'new in r1' }), f({ summary: 'dup' })] },
        { round: 2, findings: [f({ summary: 'DUP' }), f({ summary: 'new in r2' })] },
      ],
      2,
    )
    assert.equal(findings.length, 3) // dup removed globally
    assert.deepEqual(findingsByRound, [2, 1])
  })

  it('computeConvergence marks converged when the last round found 0 new', () => {
    const c = computeConvergence(
      [
        { round: 1, findings: [f({ summary: 'a' }), f({ summary: 'b' })] },
        { round: 2, findings: [f({ summary: 'A' })] }, // duplicate → 0 new
      ],
      2,
    )
    assert.equal(c.converged, true)
    assert.equal(c.stoppedReason, 'converged')
    assert.deepEqual(c.findingsByRound, [2, 0])
  })

  it('computeConvergence reports max_rounds_reached when cap hit without 0-new round', () => {
    const c = computeConvergence(
      [
        { round: 1, findings: [f({ summary: 'a' })] },
        { round: 2, findings: [f({ summary: 'b' })] },
      ],
      2,
    )
    assert.equal(c.converged, false)
    assert.equal(c.stoppedReason, 'max_rounds_reached')
  })

  it('computeConvergence handles an empty rounds list', () => {
    const c = computeConvergence([], 3)
    assert.equal(c.totalRounds, 0)
    assert.equal(c.converged, false)
    assert.equal(c.stoppedReason, 'max_rounds_reached')
  })
})

describe('buildReviewReport', () => {
  it('assembles a full report with filtering, dedupe, sort and summary', () => {
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness', 'security'],
      maxReviewRounds: 3,
      rounds: [
        {
          round: 1,
          findings: [
            f({ dimension: 'security', severity: 'critical', summary: 'sql injection', line: 10 }),
            f({ dimension: 'correctness', severity: 'low', summary: 'typo', line: 20 }),
            f({ dimension: 'security', severity: 'high', summary: 'intentional pattern', line: 30 }),
          ],
        },
        {
          round: 2,
          findings: [f({ dimension: 'security', severity: 'high', summary: 'intentional pattern', line: 30 })],
        },
      ],
      knownIntentional: [
        { file: 'src/a.ts', line: 30, dimension: 'security', reason: 'intentional' },
      ],
    })

    assert.equal(report.mode, 'dry-run')
    assert.equal(report.summary.totalFindings, 2) // 1 filtered out, 1 deduped
    assert.equal(report.summary.critical, 1)
    assert.equal(report.summary.low, 1)
    assert.equal(report.convergence.totalRounds, 2)
    assert.deepEqual(report.convergence.findingsByRound, [2, 0])
    assert.equal(report.convergence.converged, true)
    assert.equal(report.convergence.stoppedReason, 'converged')
    // severity sort: critical first
    assert.equal(report.summary.byDimension['security'], 1)
    assert.equal(report.summary.byDimension['correctness'], 1)
    // findings list is deduped, filtered, severity-sorted
    assert.equal(report.findings.length, 2)
    assert.deepEqual(
      report.findings.map((x) => x.severity),
      ['critical', 'low'],
    )
    assert.equal(report.findings[0]?.summary, 'sql injection')
  })
})

describe('reviewer tasks & schema', () => {
  it('findingsSchema is an object-rooted JSON Schema with required fields', () => {
    const schema = findingsSchema() as {
      type: string
      required: string[]
      properties: { findings: { type: string; items: { required: string[] } } }
    }
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['findings'])
    const item = schema.properties.findings.items
    for (const k of ['dimension', 'file', 'severity', 'summary', 'failure_scenario', 'suggested_fix', 'is_atomic']) {
      assert.ok(item.required.includes(k), `missing required ${k}`)
    }
  })

  it('reviewerTaskPrompt in dry-run forbids file changes and mentions round 1', () => {
    const prompt = reviewerTaskPrompt({
      dimension: 'security',
      goal: 'g',
      scope: 'full',
      mode: 'dry-run',
      outputLanguage: 'English',
      maxLines: 20,
    })
    assert.match(prompt, /MUST NOT modify/)
    assert.match(prompt, /round 1/)
    assert.match(prompt, /"security"/)
  })

  it('reviewerTaskPrompt in later rounds lists already-known findings', () => {
    const known = [f({ summary: 'known issue' })]
    const prompt = reviewerTaskPrompt({
      dimension: 'security',
      goal: 'g',
      scope: 'changed-only',
      mode: 'dry-run',
      alreadyKnown: known,
      outputLanguage: 'Chinese (中文)',
      maxLines: 20,
    })
    assert.match(prompt, /Already-known findings/)
    assert.match(prompt, /known issue/)
    assert.match(prompt, /NEW issues only/)
  })

  it('reviewerTaskPrompt interpolates the atomic max_lines threshold', () => {
    const prompt = reviewerTaskPrompt({
      dimension: 'security',
      goal: 'g',
      scope: 'full',
      mode: 'dry-run',
      outputLanguage: 'English',
      maxLines: 42,
    })
    assert.match(prompt, /<= 42 lines/)
    assert.doesNotMatch(prompt, /\{atomic\.max_lines\}/)
  })

  it('sortFindings guards against an out-of-spec severity without NaN ordering', () => {
    // 'bogus' is not a valid severity; it must be ranked as low (not NaN), so
    // ordering stays deterministic and the sort never crashes.
    const bad = f({ severity: 'bogus' as ReviewFinding['severity'], file: 'zzz.ts', summary: 'zzz' })
    const low = f({ severity: 'low', file: 'aaa.ts', summary: 'aaa' })
    const sorted = sortFindings([bad, low])
    assert.ok(sorted.every((x) => typeof x === 'object'))
    assert.deepEqual(
      sorted.map((x) => x.summary),
      ['aaa', 'zzz'],
    )
  })
})

describe('buildReviewPlan', () => {
  it('maps every config dimension to a reviewer prompt + schema', () => {
    const plan = buildReviewPlan({ config: baseConfig, mode: 'dry-run', maxReviewRounds: 4 })
    assert.equal(plan.mode, 'dry-run')
    assert.equal(plan.goal, 'Improve quality')
    assert.deepEqual(
      plan.dimensions.map((d) => d.id),
      ['correctness', 'security'],
    )
    assert.equal(plan.maxReviewRounds, 4)
    for (const d of plan.dimensions) {
      assert.ok(d.reviewerPrompt.includes(`"${d.id}"`))
      assert.ok(d.findingsSchema)
    }
  })

  it('degrades gracefully when config.dimensions is not an array', () => {
    const bad = { ...baseConfig, dimensions: 'not-an-array' as unknown as string[] }
    const plan = buildReviewPlan({ config: bad, mode: 'dry-run', maxReviewRounds: 3 })
    assert.deepEqual(plan.dimensions, [])
    assert.equal(plan.scope, 'full')
  })

  it('degrades gracefully when config.review / config.atomic are missing', () => {
    const bad = { ...baseConfig, review: undefined as unknown as IterateConfig['review'] }
    const plan = buildReviewPlan({ config: bad, mode: 'dry-run', maxReviewRounds: 3 })
    assert.equal(plan.scope, 'full')
    assert.ok(Array.isArray(plan.dimensions))
  })
})
