import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerReviewTool } from '../src/tools/review.ts'
import { buildReviewReport } from '../src/review.ts'
import type { ReviewReport } from '../src/types.ts'

/** Capture the registered iterate_review tool and drive its execute. */
function captureReviewTool(): (args: unknown) => Promise<unknown> {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerReviewTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_review was not registered')
  const exec = { signal: new AbortController().signal }
  return (args: unknown) => def!.execute(args, exec as never) as Promise<unknown>
}

/** A valid, internally consistent dry-run report with self-reported reads. */
function reportWithReads(readFiles: string[]): ReviewReport {
  return {
    ...buildReviewReport({
      mode: 'dry-run',
      goal: 'Improve quality',
      dimensions: ['correctness', 'security'],
      maxReviewRounds: 3,
      rounds: [
        {
          round: 1,
          findings: [
            {
              dimension: 'security', severity: 'high', summary: 'weak input check',
              file: 'src/a.ts', line: 1, failure_scenario: 'f', suggested_fix: 'f', is_atomic: true,
            },
          ],
        },
      ],
    }),
    readFiles,
  } as unknown as ReviewReport
}

/** Init a git repo, commit files, then return an already-changed workspace. */
function gitRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'iterate-review-meta-coverage-'))
  const env = { ...process.env, PAGER: 'cat' }
  execFileSync('git', ['init', '-q'], { cwd: root, env })
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  execFileSync('git', ['add', '-A'], { cwd: root, env })
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=iterate test', 'commit', '-q', '-m', 'init'],
    { cwd: root, env },
  )
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const CONFIG_CHANGED_ONLY = 'review:\n  scope: changed-only\ngit:\n  target_branch: HEAD\n'

describe('iterate_review meta-review changed-only coverage', () => {
  it('scores coverage against the resolved git-diff inventory, not a vacuous 1.0', async (t) => {
    const tool = captureReviewTool()
    const { root, cleanup } = gitRepo({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
    })
    try {
      writeFileSync(join(root, 'iterate.config.yaml'), CONFIG_CHANGED_ONLY, 'utf-8')
      // Working-tree change → only src/a.ts is in the diff vs HEAD.
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
      // An untracked helper must NOT leak into the changed-only inventory.
      writeFileSync(join(root, 'src/c.ts'), 'export const c = 3\n')

      const res = (await tool({
        operation: 'meta-review',
        mode: 'dry-run',
        path: root,
        report: reportWithReads(['src/b.ts']),
      })) as Record<string, unknown>
      assert.equal(res.error, undefined, JSON.stringify(res))

      const coverage = res.coverage as { assigned: string[]; ratio: number; met: boolean } | null
      assert.ok(coverage, 'coverage must be computed when readFiles are supplied')
      // The assigned inventory mirrors what `plan` told the reviewers: the
      // changed-only set — NOT the full walk (and never an empty list that
      // would trivially score ratio 1.0).
      assert.deepEqual(coverage.assigned, ['src/a.ts'])
      assert.equal(coverage.ratio, 0)
      assert.equal(coverage.met, false)
    } finally {
      cleanup()
    }
  })

  it('falls back to the FULL inventory when the diff is empty (no vacuous 1.0)', async (t) => {
    const tool = captureReviewTool()
    const { root, cleanup } = gitRepo({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
    })
    try {
      writeFileSync(join(root, 'iterate.config.yaml'), CONFIG_CHANGED_ONLY, 'utf-8')

      const res = (await tool({
        operation: 'meta-review',
        mode: 'dry-run',
        path: root,
        report: reportWithReads(['src/b.ts']),
      })) as Record<string, unknown>
      assert.equal(res.error, undefined)
      const coverage = res.coverage as { assigned: string[]; ratio: number } | null
      assert.ok(coverage)
      assert.deepEqual(coverage.assigned, ['src/a.ts', 'src/b.ts'])
      assert.ok(coverage.ratio < 1, 'reading only one of two assigned files must not score 1.0')
    } finally {
      cleanup()
    }
  })

  it('falls back to the FULL inventory when git is unavailable', async () => {
    const tool = captureReviewTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-review-meta-coverage-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(root, 'src/b.ts'), 'export const b = 2\n')
      writeFileSync(join(root, 'iterate.config.yaml'), CONFIG_CHANGED_ONLY, 'utf-8')

      const res = (await tool({
        operation: 'meta-review',
        mode: 'dry-run',
        path: root,
        report: reportWithReads(['src/a.ts', 'src/b.ts']),
      })) as Record<string, unknown>
      const coverage = res.coverage as { assigned: string[]; ratio: number; met: boolean } | null
      assert.ok(coverage)
      assert.deepEqual(coverage.assigned, ['src/a.ts', 'src/b.ts'])
      assert.equal(coverage.ratio, 1)
      assert.equal(coverage.met, true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})