import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerQualityGateTool } from '../src/tools/quality-gate.ts'

function captureTool(): {
  execute: (args: unknown) => Promise<unknown>
  render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
} {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown>; output: { render: (a: unknown, v: unknown) => unknown } } | null = null
  registerQualityGateTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_quality_gate was not registered')
  const exec = { signal: new AbortController().signal }
  return {
    execute: (args) => def!.execute(args, exec as never) as Promise<unknown>,
    render: (args, value) => def!.output.render(args, value) as Array<{ type: string; text: string }>,
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
})