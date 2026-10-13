/**
 * test/present-helpers.test.ts — direct unit tests for the pure helpers that
 * were previously only reachable through tool-level integration paths.
 *
 * `src/tools/present.ts` backs every `presentResult` card, so a regression
 * there changes what the dsh UI shows for completed calls; the review-tool
 * round-cap resolver sizes report allocations; the transcript manifest
 * normalizer is the last gate between a hand-edited `.iterate/transcript.json`
 * and the F1–F7 panels. None of them had tests that name them directly, so a
 * behavioral drift could only surface (if at all) as a confusing failure in a
 * distant tool test.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  renderedText,
  resultHeadline,
  parseRenderedJson,
  asRecord,
  asNumber,
} from '../src/tools/present.ts'
import { resolveMaxReviewRounds } from '../src/tools/review.ts'
import { MAX_REVIEW_ROUNDS_CAP } from '../src/review.ts'
import { transcriptPath, iterateDir } from '../src/paths.ts'
import { normalizeManifestBounds, MAX_ROUNDS, MAX_TIMELINE, TRANSCRIPT_VERSION } from '../src/transcript.ts'
import type { TranscriptManifest } from '../src/types.ts'

const ok = (text: string): { content: unknown; isError: unknown } => ({
  content: [{ type: 'text', text }],
  isError: false,
})

describe('renderedText', () => {
  it('joins every text block with a newline', () => {
    assert.equal(renderedText(ok('line one\nline two')), 'line one\nline two')
  })

  it('skips non-text blocks and malformed entries', () => {
    const result = {
      content: [
        { type: 'image', text: 'ignored' },
        null,
        'not-a-block',
        { type: 'text', text: 'kept' },
        { type: 'text', text: 42 },
      ],
      isError: false,
    }
    assert.equal(renderedText(result), 'kept')
  })

  it('declines failures and non-array content', () => {
    assert.equal(renderedText({ content: [{ type: 'text', text: 'x' }], isError: true }), undefined)
    assert.equal(renderedText({ content: 'text', isError: false }), undefined)
    assert.equal(renderedText({ isError: false }), undefined)
    assert.equal(renderedText(undefined as never), undefined)
  })

  it('declines when no text block carries a string', () => {
    assert.equal(renderedText({ content: [{ type: 'text' }], isError: false }), undefined)
    assert.equal(renderedText({ content: [], isError: false }), undefined)
  })
})

describe('resultHeadline', () => {
  it('takes the first non-empty trimmed line', () => {
    assert.equal(resultHeadline(ok('\n  ✓ Quality Gate: PASS (score: 92)\nrest')), '✓ Quality Gate: PASS (score: 92)')
  })

  it('clamps a long headline and appends an ellipsis', () => {
    const long = 'x'.repeat(400)
    const headline = resultHeadline(ok(long))
    assert.equal(headline!.length, 160)
    assert.ok(headline!.endsWith('…'))
  })

  it('honors a custom max length', () => {
    assert.equal(resultHeadline(ok('abcdefghij'), 5), 'abcd…')
  })

  it('declines failures and blank content', () => {
    assert.equal(resultHeadline({ content: [], isError: false }), undefined)
    assert.equal(resultHeadline({ content: [{ type: 'text', text: '   \n ' }], isError: false }), undefined)
    assert.equal(resultHeadline({ content: [{ type: 'text', text: 'x' }], isError: true }), undefined)
  })
})

describe('parseRenderedJson', () => {
  it('parses an object-shaped document', () => {
    assert.deepEqual(parseRenderedJson(ok('{"round": 2, "fixed": 5}')), { round: 2, fixed: 5 })
  })

  it('declines arrays, primitives, malformed JSON, and failures', () => {
    assert.equal(parseRenderedJson(ok('[1, 2]')), undefined)
    assert.equal(parseRenderedJson(ok('42')), undefined)
    assert.equal(parseRenderedJson(ok('{ not json')), undefined)
    assert.equal(parseRenderedJson(ok('')), undefined)
    assert.equal(parseRenderedJson({ content: [{ type: 'text', text: '{}' }], isError: true }), undefined)
  })
})

describe('asRecord / asNumber', () => {
  it('narrows plain objects and finite numbers only', () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 })
    assert.equal(asRecord([1, 2]), undefined)
    assert.equal(asRecord(null), undefined)
    assert.equal(asRecord('x'), undefined)
    assert.equal(asNumber(3), 3)
    assert.equal(asNumber(NaN), undefined)
    assert.equal(asNumber(Infinity), undefined)
    assert.equal(asNumber('3'), undefined)
  })
})

describe('resolveMaxReviewRounds', () => {
  it('prefers a finite caller value over the config value', () => {
    assert.equal(resolveMaxReviewRounds(5, 2), 5)
  })

  it('falls through to a finite config value when the caller value is junk', () => {
    assert.equal(resolveMaxReviewRounds(undefined, 4), 4)
    assert.equal(resolveMaxReviewRounds(NaN, 4), 4)
    assert.equal(resolveMaxReviewRounds(Infinity, 4), 4)
    assert.equal(resolveMaxReviewRounds('7' as unknown, 4), 4)
  })

  it('defaults to 3 when neither source is usable', () => {
    assert.equal(resolveMaxReviewRounds(undefined, undefined), 3)
    assert.equal(resolveMaxReviewRounds('x' as unknown, null), 3)
  })

  it('collapses a finite <= 0 to 1 and floors fractional caps', () => {
    assert.equal(resolveMaxReviewRounds(0, undefined), 1)
    assert.equal(resolveMaxReviewRounds(-4, undefined), 1)
    assert.equal(resolveMaxReviewRounds(2.9, undefined), 2)
  })

  it('clamps an absurd cap to MAX_REVIEW_ROUNDS_CAP', () => {
    assert.equal(resolveMaxReviewRounds(1e15, undefined), MAX_REVIEW_ROUNDS_CAP)
    assert.equal(resolveMaxReviewRounds(undefined, 1e15), MAX_REVIEW_ROUNDS_CAP)
  })
})

describe('transcriptPath', () => {
  it('points at .iterate/transcript.json under the project root', () => {
    assert.equal(transcriptPath('/srv/proj'), `${iterateDir('/srv/proj')}/transcript.json`)
  })
})

describe('normalizeManifestBounds', () => {
  const manifest = (overrides: Partial<TranscriptManifest>): TranscriptManifest =>
    ({
      version: TRANSCRIPT_VERSION,
      project: '/srv/proj',
      updatedAt: '2026-10-11T00:00:00.000Z',
      active: true,
      mode: 'normal',
      goal: 'ship it',
      phases: [],
      round: 2,
      maxRounds: 3,
      rounds: [],
      convergence: [],
      findings: [],
      fixes: [],
      checkpoint: null,
      timeline: [],
      nudge: null,
      approval: { active: true, policy: 'ask' },
      ...overrides,
    }) as TranscriptManifest

  it('passes a well-formed manifest through with its fields intact', () => {
    const out = normalizeManifestBounds(
      manifest({
        rounds: [
          {
            round: 1,
            threads: [
              {
                dimension: 'correctness',
                attempt: 1,
                messages: ['read src/a.ts'],
                readFiles: ['src/a.ts'],
                findings: [],
              },
            ],
          },
        ],
        convergence: [3, 0],
      }),
    )
    assert.equal(out.project, '/srv/proj')
    assert.equal(out.mode, 'normal')
    assert.equal(out.rounds.length, 1)
    assert.equal(out.rounds[0]!.threads[0]!.dimension, 'correctness')
    assert.deepEqual(out.convergence, [3, 0])
    assert.deepEqual(out.approval, { active: true, policy: 'ask' })
  })

  it('caps the rounds series at MAX_ROUNDS and coerces each row', () => {
    const raw = manifest({})
    ;(raw as unknown as Record<string, unknown>).rounds = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => ({
      round: i,
      threads: 'garbage',
    }))
    const out = normalizeManifestBounds(raw)
    assert.equal(out.rounds.length, MAX_ROUNDS)
    assert.deepEqual(out.rounds[0]!.threads, [], 'a non-array threads value degrades to empty')
    assert.equal(out.rounds[0]!.round, 1, 'round numbers never fall below 1')
  })

  it('caps the timeline at MAX_TIMELINE and drops non-object rows', () => {
    const raw = manifest({})
    ;(raw as unknown as Record<string, unknown>).timeline = [
      ...Array.from({ length: MAX_TIMELINE + 10 }, (_, i) => ({
        timestamp: `2026-10-01T00:00:00.000Z`,
        round: i,
        type: 'decision',
        data: { i },
      })),
      null,
      'junk',
    ]
    const out = normalizeManifestBounds(raw)
    assert.equal(out.timeline.length, MAX_TIMELINE)
  })

  it('never throws on a fully corrupt manifest', () => {
    const out = normalizeManifestBounds({ garbage: true } as unknown as TranscriptManifest)
    assert.deepEqual(out.rounds, [])
    assert.deepEqual(out.findings, [])
    assert.deepEqual(out.fixes, [])
    assert.equal(out.mode, null)
    assert.equal(out.round, 0)
    assert.deepEqual(out.approval, { active: true, policy: 'ask' })
  })

  it('sanitizes an out-of-spec approval policy instead of trusting it', () => {
    const raw = manifest({})
    ;(raw as unknown as Record<string, unknown>).approval = { active: 'yes', policy: 'root' }
    const out = normalizeManifestBounds(raw)
    assert.equal(out.approval.policy, 'ask')
    assert.equal(out.approval.active, true, 'a non-allow policy keeps approval active')
  })
})
