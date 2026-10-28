/**
 * test/report.test.ts — portable run report (Markdown + SARIF).
 *
 * Exercises the shared renderers in `lib/parse.js` (the same code the client
 * export buttons and the `iterate_report` tool use) and the tool itself,
 * including the `write:true` persistence path and malformed-state tolerance.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunReportData,
  renderRunReportMarkdown,
  renderRunReportSarif,
  renderRunReportJson,
  renderRunReport,
  runReportFilename,
  sarifLevel,
  REPORT_FORMATS,
} from '../src/report-render.ts'
import { ReviewTranscriptBuilder } from '../src/transcript.ts'
import { registerReportTool } from '../src/tools/report.ts'

/** Capture the iterate_report tool's execute so tests can drive it. */
function captureReportTool(): (args: unknown) => Promise<unknown> {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerReportTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_report was not registered')
  const exec = { signal: new AbortController().signal }
  return (args: unknown) => def!.execute(args, exec as never) as Promise<unknown>
}

/** A representative finished manifest. */
function sampleManifest() {
  const b = new ReviewTranscriptBuilder({ project: '/proj', mode: 'normal', taskMode: 'iterate', approval: 'ask', goal: 'make it green', maxRounds: 5 })
  b.roundStart(1, 5)
  b.reviewerSnapshot('correctness', [
    { dimension: 'correctness', file: 'src/a.ts', line: 12, severity: 'high', summary: 'guard the | pipe', suggested_fix: 'add a check', is_atomic: true },
  ])
  b.reviewerSnapshot('security', [
    { dimension: 'security', file: 'src/b.ts', severity: 'critical', summary: 'sql injection' },
  ])
  b.snapshotConvergence(1, 2)
  b.snapshotConvergence(2, 0)
  b.fix({ id: 'fix-1', file: 'src/a.ts', summary: 'guard', linesAdded: 3, linesRemoved: 1, success: true, round: 1 })
  b.validation({ round: 1, command: 'npm test', exitCode: 0, allowed: true })
  b.advanceRound(2, 5)
  b.validation({ round: 2, command: 'npm test', exitCode: 1, allowed: true })
  b.finish('converged')
  return b.serialize()
}

/** The extra on-disk artifacts the report folds in. */
function sampleExtra() {
  return {
    qualityGate: {
      overallStatus: 'fail',
      overallScore: 62,
      passedChecks: 1,
      totalChecks: 2,
      verificationPassRate: 50,
      dimensions: [
        { dimension: 'correctness', status: 'pass', score: 100, findingsCount: 1, fixedCount: 1, convergenceRate: 100 },
        { dimension: 'security', status: 'fail', score: 70, findingsCount: 1, fixedCount: 0, convergenceRate: 50 },
      ],
      failReason: '1 critical finding present',
    },
    experienceBank: { entries: [{ id: 'exp-1', pattern: 'p', description: 'd', hitCount: 2, dimension: 'security' }], totalHits: 2 },
    defenseEvents: { events: [{ severity: 'medium', type: 'rollback', round: 1, description: 'rolled back', outcome: '' }], counts: { rollback: 1 } },
  }
}

describe('buildRunReportData', () => {
  it('normalizes a full manifest + extras', () => {
    const data = buildRunReportData(sampleManifest(), sampleExtra())
    assert.equal(data.project, '/proj')
    assert.equal(data.mode, 'normal')
    assert.equal(data.stoppedReason, 'converged')
    assert.equal(data.findings.length, 2)
    // sorted most-severe first
    assert.equal(data.findings[0]!.severity, 'critical')
    assert.equal(data.severityCounts.critical, 1)
    assert.equal(data.severityCounts.high, 1)
    assert.equal(data.fixes.length, 1)
    assert.deepEqual(data.convergence, [2, 0])
  })

  it('tolerates junk input without throwing', () => {
    assert.doesNotThrow(() => buildRunReportData(null, null))
    assert.doesNotThrow(() => buildRunReportData('nope', { qualityGate: 7, experienceBank: [], defenseEvents: 'x' }))
    const data = buildRunReportData({}, {})
    assert.equal(data.findings.length, 0)
    assert.equal(data.fixes.length, 0)
  })
})

describe('renderRunReportMarkdown', () => {
  it('renders header, quality gate, findings, fixes, validations and artifacts', () => {
    const md = renderRunReportMarkdown(sampleManifest(), { ...sampleExtra(), }, { lang: 'en', now: '2026-10-18T01:00:00.000Z' })
    assert.match(md, /# iterate run report/)
    assert.match(md, /Quality gate/)
    assert.match(md, /FAIL \(Score 62\)/)
    assert.match(md, /## Findings \(2\)/)
    assert.match(md, /## Fixes \(1\)/)
    assert.match(md, /Defense events \(1\)/)
    assert.match(md, /Experience bank/)
    // a `|` inside a cell must be escaped, not split the table
    assert.match(md, /guard the \\\| pipe/)
  })

  it('renders Chinese labels when lang=zh', () => {
    const md = renderRunReportMarkdown(sampleManifest(), sampleExtra(), { lang: 'zh' })
    assert.match(md, /# iterate 运行报告/)
    assert.match(md, /质量门禁/)
    assert.match(md, /## 发现 \(2\)/)
  })

  it('renders an explicit empty findings list', () => {
    const b = new ReviewTranscriptBuilder({ project: '/p', approval: 'ask' })
    const md = renderRunReportMarkdown(b.serialize(), {}, { lang: 'en' })
    assert.match(md, /## Findings \(0\)/)
    assert.match(md, /_none_/)
  })

  it('is registered in REPORT_FORMATS', () => {
    assert.deepEqual(REPORT_FORMATS, ['markdown', 'sarif', 'json'])
  })
})

describe('renderRunReportJson', () => {
  it('emits the complete normalized run model (lossless)', () => {
    const json = renderRunReportJson(sampleManifest(), sampleExtra())
    assert.equal(json.$schema, 'iterate-run-report/1')
    assert.equal(json.project, '/proj')
    assert.equal(json.mode, 'normal')
    assert.equal(json.taskMode, 'iterate')
    assert.equal(json.round, 2)
    assert.equal(json.maxRounds, 5)
    assert.equal(json.active, false)
    assert.equal(json.stoppedReason, 'converged')
    assert.equal(json.updatedAt.length > 0, true)
    // every section is present as structured data, not a human projection
    assert.equal(json.findings.length, 2)
    assert.equal(json.fixes.length, 1)
    assert.equal(json.validations.length, 2)
    assert.deepEqual(json.convergence, [2, 0])
    assert.deepEqual(json.severityCounts, { critical: 1, high: 1, medium: 0, low: 0 })
    // the quality gate / experience bank / defense events ride along in full
    assert.equal(json.qualityGate?.overallStatus, 'fail')
    assert.equal(json.experienceBank?.totalHits, 2)
    assert.equal((json.defenseEvents?.counts as { rollback?: number } | undefined)?.rollback, 1)
    // JSON round-trip: exactly the facts the human report shows
    const roundTripped = JSON.parse(JSON.stringify(json))
    assert.deepEqual(roundTripped, json)
  })

  it('carries finding evidence fields into the machine model', () => {
    const json = renderRunReportJson(sampleManifest(), sampleExtra())
    const correctness = json.findings.find((f) => f.dimension === 'correctness')!
    assert.equal(correctness.file, 'src/a.ts')
    assert.equal(correctness.line, 12)
    assert.equal(correctness.severity, 'high')
    assert.equal(correctness.suggestedFix, 'add a check')
    assert.equal(correctness.isAtomic, true)
  })

  it('always returns a valid document for junk input', () => {
    const json = renderRunReportJson(null, null)
    assert.equal(json.$schema, 'iterate-run-report/1')
    assert.deepEqual(json.findings, [])
    assert.deepEqual(json.convergence, [])
    assert.deepEqual(json.severityCounts, { critical: 0, high: 0, medium: 0, low: 0 })
    assert.equal(json.qualityGate, null)
  })
})

describe('renderRunReportSarif', () => {
  it('emits a SARIF 2.1.0 log with one rule per dimension', () => {
    const sarif = renderRunReportSarif(sampleManifest(), sampleExtra(), { toolVersion: '3.9.0' }) as never as {
      version: string
      runs: Array<{ tool: { driver: { version?: string; rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; level: string; locations?: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }> }>; invocations: Array<{ executionSuccessful: boolean }> }>
    }
    assert.equal(sarif.version, '2.1.0')
    const run = sarif.runs[0]!
    assert.equal(run.tool.driver.version, '3.9.0')
    assert.deepEqual(run.tool.driver.rules.map((r) => r.id).sort(), ['correctness', 'security'])
    assert.equal(run.results.length, 2)
    const critical = run.results.find((r) => r.ruleId === 'security')!
    assert.equal(critical.level, 'error')
    assert.equal(critical.locations?.[0]?.physicalLocation.artifactLocation.uri, 'src/b.ts')
    const high = run.results.find((r) => r.ruleId === 'correctness')!
    assert.equal(high.locations?.[0]?.physicalLocation.region?.startLine, 12)
    // one failed validation + a failing gate ⇒ not successful
    assert.equal(run.invocations[0]!.executionSuccessful, false)
  })

  it('maps severities to SARIF levels', () => {
    assert.equal(sarifLevel('critical'), 'error')
    assert.equal(sarifLevel('high'), 'error')
    assert.equal(sarifLevel('medium'), 'warning')
    assert.equal(sarifLevel('low'), 'note')
    assert.equal(sarifLevel('whatever'), 'note')
  })

  it('always returns a valid document for junk input', () => {
    const sarif = renderRunReportSarif(null, null) as never as { version: string; runs: Array<{ results: unknown[] }> }
    assert.equal(sarif.version, '2.1.0')
    assert.deepEqual(sarif.runs[0]!.results, [])
  })
})

describe('renderRunReport / runReportFilename', () => {
  it('dispatches by format and defaults to markdown', () => {
    assert.equal(typeof renderRunReport('sarif', sampleManifest(), {}), 'object')
    assert.equal(typeof renderRunReport('json', sampleManifest(), {}), 'object')
    assert.equal(typeof renderRunReport('markdown', sampleManifest(), {}), 'string')
    assert.equal(typeof renderRunReport('bogus', sampleManifest(), {}), 'string')
  })

  it('builds deterministic filenames', () => {
    assert.equal(runReportFilename('markdown', { now: '2026-10-18T01:02:03.000Z' }), 'iterate-report-2026-10-18T01-02-03-000Z.md')
    assert.equal(runReportFilename('sarif', { now: '2026-10-18T01:02:03.000Z' }), 'iterate-report-2026-10-18T01-02-03-000Z.sarif')
    assert.equal(runReportFilename('json', { now: '2026-10-18T01:02:03.000Z' }), 'iterate-report-2026-10-18T01-02-03-000Z.json')
  })
})

describe('iterate_report tool', () => {
  function seedProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'iterate-report-'))
    mkdirSync(join(root, '.iterate'), { recursive: true })
    writeFileSync(join(root, '.iterate', 'transcript.json'), JSON.stringify(sampleManifest()), 'utf-8')
    writeFileSync(join(root, '.iterate', 'quality-gate.json'), JSON.stringify(sampleExtra().qualityGate), 'utf-8')
    writeFileSync(join(root, '.iterate', 'experience.json'), JSON.stringify(sampleExtra().experienceBank), 'utf-8')
    writeFileSync(join(root, '.iterate', 'defense-events.json'), JSON.stringify(sampleExtra().defenseEvents), 'utf-8')
    return root
  }

  it('renders markdown from disk without writing', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ format: 'markdown', lang: 'en', path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.format, 'markdown')
      assert.equal(res.source, 'disk')
      assert.equal(res.written, false)
      assert.match(String(res.content), /## Findings \(2\)/)
      assert.equal(res.findings, 2)
      assert.equal(res.reportPath, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders a SARIF object', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ format: 'sarif', path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.format, 'sarif')
      const sarif = res.sarif as { version: string; runs: Array<{ results: unknown[] }> }
      assert.equal(sarif.version, '2.1.0')
      assert.equal(sarif.runs[0]!.results.length, 2)
      assert.match(String(res.content), /"version": "2.1.0"/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders the full normalized model as JSON (lossless)', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ format: 'json', path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.format, 'json')
      const json = res.json as { $schema: string; findings: unknown[]; qualityGate: { overallStatus: string } | null }
      assert.equal(json.$schema, 'iterate-run-report/1')
      assert.equal(json.findings.length, 2)
      assert.equal(json.qualityGate?.overallStatus, 'fail')
      // content is the same document, pretty-printed
      assert.match(String(res.content), /"iterate-run-report\/1"/)
      assert.match(String(res.content), /"findings": \[/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the JSON report under .iterate/report.json when write:true', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ format: 'json', write: true, path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.written, true)
      const reportPath = String(res.reportPath)
      assert.match(reportPath, /\.iterate\/report\.json$/)
      assert.equal(existsSync(reportPath), true)
      const onDisk = JSON.parse(readFileSync(reportPath, 'utf-8')) as { $schema: string; findings: unknown[] }
      assert.equal(onDisk.$schema, 'iterate-run-report/1')
      assert.equal(onDisk.findings.length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the report under .iterate/ when write:true', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ format: 'sarif', write: true, path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.written, true)
      const reportPath = String(res.reportPath)
      assert.match(reportPath, /\.iterate\/report\.sarif$/)
      assert.equal(existsSync(reportPath), true)
      const onDisk = JSON.parse(readFileSync(reportPath, 'utf-8')) as { version: string }
      assert.equal(onDisk.version, '2.1.0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades to an empty report when nothing ran', async () => {
    const tool = captureReportTool()
    const root = mkdtempSync(join(tmpdir(), 'iterate-report-empty-'))
    try {
      const res = (await tool({ format: 'markdown', lang: 'en', path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.source, 'empty')
      assert.equal(res.findings, 0)
      assert.match(String(res.content), /## Findings \(0\)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults to markdown + zh when format/lang are omitted', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      const res = (await tool({ path: root })) as Record<string, unknown>
      assert.equal(res.ok, true)
      assert.equal(res.format, 'markdown')
      assert.match(String(res.content), /iterate 运行报告/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an unknown format at the argument schema (never reaches execute)', async () => {
    const tool = captureReportTool()
    const root = seedProject()
    try {
      await assert.rejects(() => tool({ format: 'xlsx', path: root }), /format/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('run report edge normalization', () => {
  it('treats an absent `active` as NOT running (empty manifest)', () => {
    const data = buildRunReportData({}, {})
    assert.equal(data.active, false)
    const md = renderRunReportMarkdown({}, {}, { lang: 'en' })
    assert.match(md, /\*\*Status\*\*: stopped/)
    assert.doesNotMatch(md, /running/)
  })

  it('renders line 1 in both markdown and SARIF locations', () => {
    const manifest = {
      findings: [{ dimension: 'correctness', file: 'src/one.ts', line: 1, severity: 'high', summary: 'first line' }],
    }
    const md = renderRunReportMarkdown(manifest, {}, { lang: 'en' })
    assert.match(md, /src\/one\.ts:1\b/)
    const sarif = renderRunReportSarif(manifest, {}, {}) as never as {
      runs: Array<{ results: Array<{ locations?: Array<{ physicalLocation: { region?: { startLine: number } } }> }> }>
    }
    assert.equal(sarif.runs[0]!.results[0]!.locations?.[0]?.physicalLocation.region?.startLine, 1)
  })

  it('floors a fractional line so SARIF startLine stays a valid integer', () => {
    const manifest = {
      findings: [{ dimension: 'correctness', file: 'src/a.ts', line: 1.5, severity: 'low', summary: 'x' }],
    }
    const md = renderRunReportMarkdown(manifest, {}, { lang: 'en' })
    assert.match(md, /src\/a\.ts:1\b/)
    assert.doesNotMatch(md, /1\.5/)
    const sarif = renderRunReportSarif(manifest, {}, {}) as never as {
      runs: Array<{ results: Array<{ locations?: Array<{ physicalLocation: { region?: { startLine: number } } }> }> }>
    }
    const startLine = sarif.runs[0]!.results[0]!.locations?.[0]?.physicalLocation.region?.startLine
    assert.equal(Number.isInteger(startLine), true)
    assert.equal(startLine, 1)
  })

  it('does not count an unknown (null) validation exit code as a failure', () => {
    const manifest = {
      findings: [],
      validations: [{ round: 1, command: 'npm test', exitCode: null, allowed: true }],
    }
    const sarif = renderRunReportSarif(manifest, {}, {}) as never as {
      runs: Array<{ invocations: Array<{ executionSuccessful: boolean }> }>
    }
    assert.equal(sarif.runs[0]!.invocations[0]!.executionSuccessful, true)
  })

  it('still counts a concrete non-zero exit code as a failure', () => {
    const manifest = {
      findings: [],
      validations: [{ round: 1, command: 'npm test', exitCode: 1, allowed: true }],
    }
    const sarif = renderRunReportSarif(manifest, {}, {}) as never as {
      runs: Array<{ invocations: Array<{ executionSuccessful: boolean }> }>
    }
    assert.equal(sarif.runs[0]!.invocations[0]!.executionSuccessful, false)
  })
})
