import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerQualityGateTool } from '../src/tools/quality-gate.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  presentResult: (args: unknown, result: { content?: unknown; isError?: boolean }) => { card?: string; title?: string } | undefined
} {
  let def: {
    execute: (a: unknown, e: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => unknown }
    presentResult?: (a: unknown, r: { content?: unknown; isError?: boolean }) => unknown
  } | null = null
  registerQualityGateTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_quality_gate was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
    presentResult: (args, result) => def!.presentResult?.(args, result) as { card?: string; title?: string } | undefined,
  }
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-quality-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('iterate_quality_gate', () => {
  it('compute persists a snapshot with a real convergence rate, and read returns it', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness', 'security'],
        findings: [
          { dimension: 'correctness', severity: 'high', file: 'a.ts' },
          { dimension: 'correctness', severity: 'medium', file: 'b.ts' },
        ],
        validationResults: [{ command: 'npm test', exitCode: 0 }],
        findingsByRound: { correctness: [6, 2] },
        fixedByDimension: { correctness: 1 },
      })) as Record<string, unknown>

      assert.equal(result.ok, true)
      assert.equal(result.operation, 'compute')
      const snapshot = result.snapshot as { overallStatus: string; dimensions: Array<{ dimension: string; convergenceRate: number; fixedCount: number }> }
      const correctness = snapshot.dimensions.find((d) => d.dimension === 'correctness')!
      assert.equal(correctness.convergenceRate, 67)
      assert.equal(correctness.fixedCount, 1)

      const gatePath = join(dir, '.iterate', 'quality-gate.json')
      assert.equal(existsSync(gatePath), true)
      const persisted = JSON.parse(readFileSync(gatePath, 'utf-8'))
      assert.equal(persisted.dimensions[0].convergenceRate, 67)

      const readBack = (await tool.execute({ operation: 'read', path: dir })) as Record<string, unknown>
      assert.equal(readBack.operation, 'read')
      // The persisted snapshot omits undefined keys, so compare the JSON forms.
      assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)), readBack.snapshot)
    } finally {
      cleanup()
    }
  })

  it('read on a fresh project returns the pending empty snapshot', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ path: dir })) as Record<string, unknown>
      assert.equal(result.ok, true)
      assert.equal(result.operation, 'read')
      const snapshot = result.snapshot as { overallStatus: string; dimensions: unknown[] }
      assert.equal(snapshot.overallStatus, 'pending')
      assert.deepEqual(snapshot.dimensions, [])
    } finally {
      cleanup()
    }
  })

  it('compute sanitizes malformed findings/series instead of crashing', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness', 'security', 'performance'],
        findings: [
          { dimension: 'correctness', severity: 'high', file: 'a.ts' },
          { dimension: 'security', severity: 'critical' }, // missing file → dropped
          'garbage',
          null,
        ],
        validationResults: [{ command: 'npm test', exitCode: 1 }, { command: 'lint', exitCode: 'no' }],
        findingsByRound: { correctness: [4, 1, 'x', null], security: [-5] },
        fixedByDimension: { correctness: 1, performance: 'nope' },
      })) as Record<string, unknown>
      assert.equal(result.ok, true)
      const snapshot = result.snapshot as { totalFindings: number; totalChecks: number; failedChecks: number }
      assert.equal(snapshot.totalFindings, 1)
      assert.equal(snapshot.totalChecks, 1)
      assert.equal(snapshot.failedChecks, 1)
    } finally {
      cleanup()
    }
  })

  it('rejects an unknown operation via the enum', async () => {
    const tool = captureTool()
    await assert.rejects(() => tool.execute({ operation: 'bogus' }), /must be one of/)
  })

  it('renders a computed snapshot with the persisted note', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'compute' }, {
      ok: true,
      kind: 'quality_gate',
      operation: 'compute',
      snapshot: {
        overallStatus: 'pass',
        overallScore: 90,
        verificationPassRate: 100,
        totalChecks: 2,
        passedChecks: 2,
        failedChecks: 0,
        totalFindings: 1,
        criticalCount: 0,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
        dimensions: [
          { dimension: 'correctness', score: 85, convergenceRate: 50, findingsCount: 1, fixedCount: 1, status: 'pass' },
        ],
      },
    })
    assert.equal(blocks.length, 1)
    assert.match(blocks[0]!.text, /Quality Gate: PASS/)
    assert.match(blocks[0]!.text, /convergence=50%/)
    assert.match(blocks[0]!.text, /computed and persisted/)
  })

  it('compute surfaces a persistence failure instead of reporting success', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // `.iterate` exists as a plain FILE — the snapshot cannot be persisted.
      writeFileSync(join(dir, '.iterate'), '', 'utf-8')
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness'],
        findings: [],
      })) as Record<string, unknown>
      assert.equal(result.ok, false)
      assert.equal(result.operation, 'compute')
      assert.equal(result.snapshot, undefined)
      assert.match(result.error as string, /quality-gate\.json/)
    } finally {
      cleanup()
    }
  })

  it('clear removes the persisted certificate; read then falls back to pending', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness'],
        findings: [{ dimension: 'correctness', severity: 'high', file: 'a.ts' }],
      })
      const gatePath = join(dir, '.iterate', 'quality-gate.json')
      assert.equal(existsSync(gatePath), true)

      const cleared = (await tool.execute({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(cleared.ok, true)
      assert.equal(cleared.operation, 'clear')
      assert.equal(existsSync(gatePath), false)
      const snapshot = cleared.snapshot as { overallStatus: string }
      assert.equal(snapshot.overallStatus, 'pending')

      const readBack = (await tool.execute({ operation: 'read', path: dir })) as Record<string, unknown>
      assert.equal((readBack.snapshot as { overallStatus: string }).overallStatus, 'pending')
    } finally {
      cleanup()
    }
  })

  it('clear renders a notice that the certificate was reset', async () => {
    const tool = captureTool()
    const blocks = tool.render({ operation: 'clear' }, {
      ok: true,
      kind: 'quality_gate',
      operation: 'clear',
      snapshot: { overallStatus: 'pending', dimensions: [], overallScore: 0 },
    })
    assert.equal(blocks.length, 1)
    assert.match(blocks[0]!.text, /cleared/)
  })

  it('clear is fail-safe when a certificate is missing', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({ operation: 'clear', path: dir })) as Record<string, unknown>
      assert.equal(result.ok, true)
      assert.equal(result.operation, 'clear')
    } finally {
      cleanup()
    }
  })

  it('compute without dimensions is refused and persists nothing', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      // Missing `dimensions`: findings cannot be gated against an empty list —
      // the old path computed overallScore 0 and PERSISTED a fabricated FAIL.
      const missing = (await tool.execute({
        operation: 'compute',
        path: dir,
        findings: [{ dimension: 'correctness', severity: 'high', file: 'a.ts' }],
      })) as Record<string, unknown>
      assert.equal(missing.ok, false)
      assert.equal(missing.operation, 'compute')
      assert.equal(missing.snapshot, undefined)
      assert.match(missing.error as string, /dimensions is required/)
      assert.equal(existsSync(join(dir, '.iterate', 'quality-gate.json')), false)
    } finally {
      cleanup()
    }
  })

  it('compute with an empty dimensions array is refused even when findings exist', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const empty = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: [],
        findings: [{ dimension: 'correctness', severity: 'critical', file: 'a.ts' }],
      })) as Record<string, unknown>
      assert.equal(empty.ok, false)
      assert.equal(empty.snapshot, undefined)
      assert.match(empty.error as string, /dimensions is required/)
      assert.equal(existsSync(join(dir, '.iterate', 'quality-gate.json')), false)
      // A later read still falls back to the untouched pending state.
      const read = (await tool.execute({ operation: 'read', path: dir })) as Record<string, unknown>
      assert.equal((read.snapshot as { overallStatus: string }).overallStatus, 'pending')
    } finally {
      cleanup()
    }
  })

  it('compute warns about findings in ungated dimensions without changing the score', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness'],
        findings: [
          { dimension: 'correctness', severity: 'high', file: 'a.ts' }, // gated: -15
          { dimension: 'docs', severity: 'medium', file: 'b.md' }, // NOT gated → warning
          { dimension: 'docs', severity: 'low', file: 'c.md' }, // NOT gated → warning
        ],
      })) as Record<string, unknown>
      assert.equal(result.ok, true)

      const warnings = result.warnings as string[]
      assert.equal(warnings.length, 1)
      assert.match(warnings[0]!, /"docs"/)
      assert.match(warnings[0]!, /2 findings/)
      assert.match(warnings[0]!, /not in the gated dimensions/)

      // Scoring is unchanged: only the gated dimension is scored (100-15=85),
      // the two docs findings contribute nothing to it.
      const snapshot = result.snapshot as {
        overallScore: number
        totalFindings: number
        dimensions: Array<{ dimension: string; score: number; findingsCount: number }>
      }
      assert.equal(snapshot.dimensions.length, 1)
      assert.equal(snapshot.dimensions[0]!.findingsCount, 1)
      assert.equal(snapshot.overallScore, 85)
      assert.equal(snapshot.totalFindings, 3)

      // The renderer surfaces the warnings alongside the certificate.
      const blocks = tool.render({ operation: 'compute' }, result)
      assert.match(blocks[0]!.text, /Warnings:/)
      assert.match(blocks[0]!.text, /"docs"/)
    } finally {
      cleanup()
    }
  })

  it('compute reports no warnings when every finding is in a gated dimension', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness', 'security'],
        findings: [{ dimension: 'security', severity: 'low', file: 'a.ts' }],
      })) as Record<string, unknown>
      assert.equal(result.ok, true)
      assert.deepEqual(result.warnings, [])
    } finally {
      cleanup()
    }
  })

  it('renders a critical-holding dimension as FAILED, agreeing with the overall gate status', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const result = (await tool.execute({
        operation: 'compute',
        path: dir,
        dimensions: ['correctness'],
        // score would be 100-30 = 70 (a 'warn' band), but the critical finding
        // fails the whole gate — the dimension row must not say WARN while the
        // header says FAIL.
        findings: [{ dimension: 'correctness', severity: 'critical', file: 'a.ts', line: 10 }],
      })) as Record<string, unknown>
      assert.equal(result.ok, true)

      const snapshot = result.snapshot as {
        overallStatus: string
        dimensions: Array<{ status: string; score: number }>
      }
      assert.equal(snapshot.overallStatus, 'fail')
      assert.equal(snapshot.dimensions[0]!.status, 'fail')
      assert.equal(snapshot.dimensions[0]!.score, 70)

      const text = tool.render({ operation: 'compute' }, result)[0]!.text
      assert.match(text, /Quality Gate: FAIL/)
      assert.match(text, /✗ correctness: score=70/)
      assert.doesNotMatch(text, /! correctness/)
    } finally {
      cleanup()
    }
  })

  it('presentResult titles a completed gate query with the rendered headline (#12)', async () => {
    const tool = captureTool()
    const { dir, cleanup } = tempProject()
    try {
      const args = {
        operation: 'compute',
        path: dir,
        dimensions: ['correctness'],
        validationResults: [{ command: 'npm test', exitCode: 0 }],
      }
      const result = await tool.execute(args)
      const content = tool.render(args, result)
      const card = tool.presentResult(args, { content, isError: false })
      assert.equal(card?.card, 'generic')
      assert.match(card!.title!, /^✓ Quality Gate: PASS/, `headline must lead the card: ${card!.title}`)
      // Failure results and content without text decline the card, so the UI
      // falls back to the default presentation instead of a wrong headline.
      assert.equal(tool.presentResult(args, { content, isError: true }), undefined)
      assert.equal(tool.presentResult(args, { content: [], isError: false }), undefined)
    } finally {
      cleanup()
    }
  })
})
