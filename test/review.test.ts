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
  REQUIRED_FINDING_FIELDS,
  reviewerTaskPrompt,
  sanitizeRounds,
  SEVERITY_RANK,
  SEVERITY_VALUES,
  sortFindings,
  validateFindingsSchema,
  validateRoundsSchema,
} from '../src/review.ts'
import type { IterateConfig, ReviewFinding, ReviewRound } from '../src/types.ts'

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
  reviewer: { output_schema_validation: true, evidence_validation: true },
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

  it('computes convergence from the LAST RECORDED round number, not the array index', () => {
    // Non-contiguous round numbers (e.g. a resumed iteration that skips earlier
    // round numbers): findingsByRound is sized to the HIGHEST round, so the
    // last round's count must be read by its reported number, not by
    // `length - 1`. Round 3 found a new finding, so it must NOT converge.
    const report = buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness'],
      maxReviewRounds: 5,
      rounds: [
        { round: 1, findings: [f({ summary: 'first issue' })] },
        { round: 3, findings: [f({ summary: 'new issue in resumed round 3' })] },
      ],
    })
    assert.deepEqual(report.convergence.findingsByRound, [1, 0, 1])
    assert.equal(report.convergence.totalRounds, 2)
    assert.equal(report.convergence.converged, false)
    assert.equal(report.convergence.stoppedReason, 'max_rounds_reached')
    // And the mirror: when the last recorded round finds nothing new, converge.
    const converged = buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness'],
      maxReviewRounds: 5,
      rounds: [
        { round: 3, findings: [f({ summary: 'found in round 3' })] },
        { round: 5, findings: [f({ summary: 'FOUND IN ROUND 3' })] }, // dup → 0 new
      ],
    })
    assert.deepEqual(converged.convergence.findingsByRound, [0, 0, 1, 0, 0])
    assert.equal(converged.convergence.converged, true)
    assert.equal(converged.convergence.stoppedReason, 'converged')
  })

  it('threads fixedCount into the summary for normal mode only', () => {
    const rounds = [{ round: 1, findings: [f({ summary: 'issue' })] }]
    const dryRun = buildReviewReport({
      mode: 'dry-run',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds,
      fixedCount: 5,
    })
    assert.equal(dryRun.summary.fixedCount, undefined)

    const normal = buildReviewReport({
      mode: 'normal',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds,
      fixedCount: 5,
    })
    assert.equal(normal.summary.fixedCount, 5)

    const noCount = buildReviewReport({
      mode: 'normal',
      goal: 'g',
      dimensions: ['correctness'],
      maxReviewRounds: 3,
      rounds,
    })
    assert.equal(noCount.summary.fixedCount, undefined)
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

  it('reviewerTaskPrompt mandates reading files before judging (EVIDENCE RULE)', () => {
    const prompt = reviewerTaskPrompt({
      dimension: 'security',
      goal: 'g',
      scope: 'full',
      mode: 'dry-run',
      outputLanguage: 'English',
      maxLines: 20,
    })
    assert.match(prompt, /EVIDENCE RULE \(mandatory\)/)
    assert.match(prompt, /read_file tool BEFORE judging/)
    assert.match(prompt, /NEVER report a location you did not actually read/)
    assert.match(prompt, /fabricated line numbers are treated as poisoned evidence/)
    // line is REQUIRED for anchored, line-targeted issues.
    assert.match(prompt, /line \(REQUIRED positive integer/)
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

  it('builds a changed-only plan listing the changed files and falls back to full when none exist', () => {
    const changed = { ...baseConfig, review: { scope: 'changed-only' as const } }
    const withFiles = buildReviewPlan({
      config: changed,
      mode: 'dry-run',
      maxReviewRounds: 3,
      changedFiles: ['src/a.ts', 'src/b.ts'],
    })
    assert.equal(withFiles.scope, 'changed-only')
    assert.deepEqual(withFiles.changedFiles, ['src/a.ts', 'src/b.ts'])
    assert.equal(withFiles.fallbackToFull, false)
    for (const d of withFiles.dimensions) {
      assert.match(d.reviewerPrompt, /Changed files to review/)
      assert.match(d.reviewerPrompt, /src\/a\.ts/)
      assert.match(d.reviewerPrompt, /src\/b\.ts/)
    }

    // No changes → auto-fallback to full scope, no file list in prompts.
    const noFiles = buildReviewPlan({
      config: changed,
      mode: 'dry-run',
      maxReviewRounds: 3,
      changedFiles: [],
    })
    assert.equal(noFiles.scope, 'full')
    assert.equal(noFiles.fallbackToFull, true)
    assert.deepEqual(noFiles.changedFiles, [])
    for (const d of noFiles.dimensions) {
      assert.doesNotMatch(d.reviewerPrompt, /Changed files to review/)
    }
  })

  it('keeps full scope unchanged when changedFiles are supplied for a full-scope config', () => {
    const plan = buildReviewPlan({
      config: baseConfig, // scope: full
      mode: 'dry-run',
      maxReviewRounds: 3,
      changedFiles: ['src/a.ts'],
    })
    assert.equal(plan.scope, 'full')
    assert.deepEqual(plan.changedFiles, [])
    assert.equal(plan.fallbackToFull, false)
    assert.doesNotMatch(plan.dimensions[0]!.reviewerPrompt, /Changed files to review/)
  })
})

// ─── Output schema validation ──────────────────────────────────────────────

describe('validateFindingsSchema', () => {
  it('accepts a valid findings list (and its {findings:[...]} wrapper)', () => {
    const valid = [f({}), f({ line: 0, severity: 'critical' })]
    assert.deepEqual(validateFindingsSchema(valid), [])
    assert.deepEqual(validateFindingsSchema({ findings: valid }), [])
  })

  it('rejects a non-array input with a round-level issue', () => {
    const issues = validateFindingsSchema({ not: 'findings' })
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.index, -1)
    assert.equal(issues[0]!.field, 'findings')
  })

  it('flags every required field that is missing', () => {
    const issues = validateFindingsSchema([{ dimension: 'correctness' }])
    const missing = issues.filter((i) => i.message.includes('required field'))
    assert.deepEqual(
      missing.map((i) => i.field),
      [
        'findings[0].file',
        'findings[0].severity',
        'findings[0].summary',
        'findings[0].failure_scenario',
        'findings[0].suggested_fix',
        'findings[0].is_atomic',
      ],
    )
    assert.equal(REQUIRED_FINDING_FIELDS.length, 7)
  })

  it('flags wrong types: severity enum, is_atomic boolean, line integer, string fields', () => {
    const issues = validateFindingsSchema([
      f({ severity: 'bogus' as ReviewFinding['severity'] }),
      f({ is_atomic: 'yes' as unknown as boolean }),
      f({ line: -3 }),
      f({ line: 1.5 }),
      f({ summary: 42 as unknown as string }),
    ])
    const fields = issues.map((i) => i.field)
    assert.ok(fields.includes('findings[0].severity'), 'severity enum violation')
    assert.ok(fields.includes('findings[1].is_atomic'), 'is_atomic type violation')
    assert.ok(fields.includes('findings[2].line'), 'negative line violation')
    assert.ok(fields.includes('findings[3].line'), 'non-integer line violation')
    assert.ok(fields.includes('findings[4].summary'), 'string field type violation')
  })

  it('accepts line 0 and absent line (whole-file findings)', () => {
    assert.deepEqual(validateFindingsSchema([f({ line: 0 })]), [])
    const withoutLine = { ...f({}), line: undefined }
    delete (withoutLine as Record<string, unknown>).line
    assert.deepEqual(validateFindingsSchema([withoutLine]), [])
  })

  it('flags a non-object entry in the findings array', () => {
    const issues = validateFindingsSchema([f({}), 'not-an-object', null])
    assert.ok(issues.some((i) => i.message.includes('expected a finding object')))
  })
})

describe('validateRoundsSchema / sanitizeRounds', () => {
  it('reports per-round validity and drops schema-invalid findings when enabled', () => {
    const rounds: ReviewRound[] = [
      { round: 1, findings: [f({ summary: 'ok' }), f({ summary: 42 as unknown as string }) as ReviewFinding] },
    ]
    const validation = validateRoundsSchema(rounds)
    assert.equal(validation.length, 1)
    assert.equal(validation[0]!.valid, false)
    assert.equal(validation[0]!.issues.length, 1)

    const clean = sanitizeRounds(rounds, validation)
    assert.equal(clean[0]!.findings.length, 1)
    assert.equal(clean[0]!.findings[0]!.summary, 'ok')
  })

  it('keeps a fully valid round untouched', () => {
    const rounds: ReviewRound[] = [{ round: 1, findings: [f({})] }]
    const validation = validateRoundsSchema(rounds)
    assert.equal(validation[0]!.valid, true)
    assert.equal(sanitizeRounds(rounds, validation)[0]!.findings.length, 1)
  })

  it('empties a round whose whole findings value is malformed', () => {
    const rounds: ReviewRound[] = [{ round: 1, findings: [{ nope: true } as unknown as ReviewFinding] }]
    const validation = validateRoundsSchema(rounds)
    assert.equal(validation[0]!.valid, false)
    assert.deepEqual(sanitizeRounds(rounds, validation)[0]!.findings, [])
  })

  it('still drops non-object entries when validation is disabled (crash-safety)', () => {
    const rounds: ReviewRound[] = [
      { round: 1, findings: [f({}), 'junk' as unknown as ReviewFinding, null as unknown as ReviewFinding] },
    ]
    const clean = sanitizeRounds(rounds, null)
    assert.equal(clean[0]!.findings.length, 1)
  })

  it('preserves round numbers and order through sanitization', () => {
    const rounds: ReviewRound[] = [
      { round: 1, findings: [f({ summary: 'a' })] },
      { round: 3, findings: [f({ summary: 1 as unknown as string }) as ReviewFinding] },
    ]
    const validation = validateRoundsSchema(rounds)
    const clean = sanitizeRounds(rounds, validation)
    assert.deepEqual(clean.map((r) => r.round), [1, 3])
    assert.equal(clean[1]!.findings.length, 0)
  })
})

describe('schema constants mirror findingsSchema', () => {
  it('REQUIRED_FINDING_FIELDS and SEVERITY_VALUES align with the JSON schema', () => {
    const schema = findingsSchema() as {
      properties: {
        findings: { items: { required: string[]; properties: Record<string, { enum?: string[] }> } }
      }
    }
    const item = schema.properties.findings.items
    for (const key of REQUIRED_FINDING_FIELDS) {
      assert.ok(item.required.includes(key), `schema requires ${key}`)
    }
    assert.deepEqual(SEVERITY_VALUES, ['critical', 'high', 'medium', 'low'])
    assert.deepEqual(item.properties.severity?.enum, [...SEVERITY_VALUES])
  })
})
