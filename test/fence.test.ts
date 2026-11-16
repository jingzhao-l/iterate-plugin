/**
 * test/fence.test.ts — `iterate-report` chat fence (v3.19).
 *
 * Locks down the pure parse/summarise layer AND the rendered card:
 *   - detection: tagged run report, untagged shaped run report, quality gate,
 *     invalid JSON, unknown payload, empty/non-text code;
 *   - normalization: severity sorting, count fallback, gate/dimension
 *     coercion, defense grouping, line-number guards;
 *   - Markdown/JSON export: PR-pasteable tables, pipe escaping, truncation;
 *   - the slot layer: streaming → children untouched, invalid/unknown → the
 *     plain code block preserved (never hidden), copy-Markdown / copy-JSON /
 *     open-command-center actions, `compact` meta, language repaint, and the
 *     defensive registration (`registerReportFence` never throws).
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it, before, beforeEach, afterEach } from 'node:test'

const nodeRequire = createRequire(import.meta.url)

// Type-only: erased at runtime, so the top-level `require('react')` in fence.ts
// is never evaluated by these imports (the dynamic import in `before` runs it
// only after `globalThis.require` is installed).
import type { FenceLayerDeps, FenceLayerProps } from '../src/client/fence.ts'

// ─── Shell emulation (mirrors test/client-render.test.ts) ───────────────────

interface Rendered {
  textContent: string | null
  querySelector(selector: string): Rendered | null
  querySelectorAll(selector: string): Rendered[]
  getAttribute(name: string): string | null
  click(): void
  remove(): void
}
interface JSDOMLike {
  window: {
    document: {
      createElement(tag: string): Rendered
      body: { appendChild(child: Rendered): void }
      querySelector(selector: string): Rendered | null
    }
    navigator: { language?: string }
    localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; clear(): void }
    HTMLElement: unknown
    Element: unknown
    Node: unknown
    Blob: unknown
    URL: unknown
    getComputedStyle(el: unknown): unknown
  }
}

let React: { createElement(t: unknown, p: Record<string, unknown> | null, ...c: unknown[]): unknown; act(cb: () => void | Promise<void>): void | Promise<void>; Fragment: unknown }
let createRoot: (c: Rendered) => { render(el: unknown): void; unmount(): void }
let document: JSDOMLike['window']['document']
let fence!: typeof import('../src/client/fence.ts')
let i18n!: typeof import('../src/client/i18n.ts')

/** A representative `iterate-run-report/1` payload. */
function sampleRunReport(): Record<string, unknown> {
  return {
    $schema: 'iterate-run-report/1',
    project: 'acme/api',
    goal: 'make the suite green',
    mode: 'normal',
    taskMode: 'iterate',
    round: 3,
    maxRounds: 5,
    active: false,
    stoppedReason: 'converged',
    updatedAt: '2026-11-15T00:00:00.000Z',
    convergence: [5, 3, 0],
    severityCounts: { critical: 1, high: 1, medium: 0, low: 1 },
    findings: [
      { dimension: 'security', file: 'src/b.ts', severity: 'critical', summary: 'sql injection' },
      { dimension: 'correctness', file: 'src/a.ts', line: 12, severity: 'high', summary: 'guard the | pipe' },
      { dimension: 'style', file: 'src/c.ts', line: 4, severity: 'low', summary: 'trailing space' },
    ],
    fixes: [
      { round: 1, file: 'src/a.ts', summary: 'guard', linesAdded: 3, linesRemoved: 1, success: true },
      { round: 2, file: 'src/b.ts', summary: 'parametrize', linesAdded: 2, linesRemoved: 0, success: false },
    ],
    validations: [
      { round: 1, command: 'npm test', exitCode: 0, allowed: true },
      { round: 2, command: 'npm test', exitCode: 1, allowed: true },
    ],
    qualityGate: {
      overallStatus: 'fail',
      overallScore: 62,
      verificationPassRate: 50,
      totalChecks: 2,
      passedChecks: 1,
      failReason: '1 critical finding present',
      dimensions: [
        { dimension: 'correctness', status: 'pass', score: 100, findingsCount: 1, fixedCount: 1 },
        { dimension: 'security', status: 'fail', score: 70, findingsCount: 1, fixedCount: 0 },
      ],
    },
    experienceBank: null,
    defenseEvents: { counts: { rollback: 2, precondition_failed: 1 }, events: [] },
  }
}

function sampleGate(): Record<string, unknown> {
  return {
    overallStatus: 'pass',
    overallScore: 91,
    verificationPassRate: 100,
    totalChecks: 3,
    passedChecks: 3,
    dimensions: [
      { dimension: 'correctness', status: 'pass', score: 100, findingsCount: 0, fixedCount: 0 },
      { dimension: 'security', status: 'pass', score: 88, findingsCount: 0, fixedCount: 0 },
    ],
  }
}

before(async () => {
  const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html: string, opts?: { url?: string }) => JSDOMLike }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.local/' })
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  define('window', dom.window)
  define('document', dom.window.document)
  define('navigator', dom.window.navigator)
  define('localStorage', dom.window.localStorage)
  define('HTMLElement', dom.window.HTMLElement)
  define('Element', dom.window.Element)
  define('Node', dom.window.Node)
  define('Blob', dom.window.Blob)
  define('URL', dom.window.URL)
  define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  define('IS_REACT_ACT_ENVIRONMENT', true)
  define('require', (id: string) => nodeRequire(id))
  document = dom.window.document
  React = nodeRequire('react') as typeof React
  createRoot = (nodeRequire('react-dom/client') as { createRoot(c: Rendered): ReturnType<typeof createRoot> }).createRoot
  fence = await import('../src/client/fence.ts')
  i18n = await import('../src/client/i18n.ts')
})

/** Mount a layer and return its rendered container. */
function mount(component: unknown, props: Record<string, unknown>): Rendered {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  React.act(() => { root.render(React.createElement(component as never, props)) })
  return container
}

describe('parseIterateFence — detection', () => {
  it('recognizes a tagged run report', () => {
    const parsed = fence.parseIterateFence(JSON.stringify(sampleRunReport()))
    assert.equal(parsed.kind, 'run-report')
    if (parsed.kind === 'run-report') {
      assert.equal(parsed.report.project, 'acme/api')
      assert.equal(parsed.report.round, 3)
      assert.equal(parsed.report.maxRounds, 5)
      assert.equal(parsed.report.totalFindings, 3)
      assert.deepEqual(parsed.report.severityCounts, { critical: 1, high: 1, medium: 0, low: 1 })
      assert.equal(parsed.report.fixesApplied, 1)
      assert.equal(parsed.report.fixesTotal, 2)
      assert.equal(parsed.report.validationsPassed, 2)
      assert.equal(parsed.report.validationsTotal, 2)
      // sorted most-severe first
      assert.equal(parsed.report.findings[0]!.severity, 'critical')
      assert.equal(parsed.report.findings[1]!.severity, 'high')
      assert.equal(parsed.report.findings[1]!.line, 12)
      assert.equal(parsed.report.findings[2]!.line, 4)
      // gate normalized
      assert.ok(parsed.report.gate)
      assert.equal(parsed.report.gate!.status, 'fail')
      assert.equal(parsed.report.gate!.score, 62)
      assert.equal(parsed.report.gate!.dimensions.length, 2)
      // defense grouped, most frequent first
      assert.deepEqual(parsed.report.defenseTypes, [{ type: 'rollback', count: 2 }, { type: 'precondition_failed', count: 1 }])
    }
  })

  it('recognizes an untagged but shaped run report', () => {
    const parsed = fence.parseIterateFence(JSON.stringify({ findings: [], convergence: [0], severityCounts: { critical: 0, high: 0, medium: 0, low: 0 } }))
    assert.equal(parsed.kind, 'run-report')
  })

  it('recognizes a standalone quality gate', () => {
    const parsed = fence.parseIterateFence(JSON.stringify(sampleGate()))
    assert.equal(parsed.kind, 'quality-gate')
    if (parsed.kind === 'quality-gate') {
      assert.equal(parsed.gate.status, 'pass')
      assert.equal(parsed.gate.score, 91)
      assert.equal(parsed.gate.dimensions.length, 2)
    }
  })

  it('rejects invalid JSON with a diagnostic', () => {
    const parsed = fence.parseIterateFence('not json {')
    assert.equal(parsed.kind, 'invalid')
    if (parsed.kind === 'invalid') assert.ok(parsed.error.length > 0)
  })

  it('rejects empty / non-text payloads', () => {
    assert.equal(fence.parseIterateFence('').kind, 'invalid')
    assert.equal(fence.parseIterateFence('   ').kind, 'invalid')
    assert.equal(fence.parseIterateFence(undefined).kind, 'invalid')
    assert.equal(fence.parseIterateFence(42).kind, 'invalid')
  })

  it('returns unknown for valid JSON without an iterate fingerprint', () => {
    assert.equal(fence.parseIterateFence('{"foo":1}').kind, 'unknown')
    assert.equal(fence.parseIterateFence('{"findings":[]}').kind, 'unknown')
    assert.equal(fence.parseIterateFence('[]').kind, 'unknown')
  })
})

describe('normalization edge cases', () => {
  it('filters findings without a summary or file', () => {
    const parsed = fence.parseIterateFence(JSON.stringify({
      $schema: 'iterate-run-report/1',
      findings: [
        { dimension: 'a', severity: 'high', summary: 'x' },
        { dimension: 'b', severity: 'low' }, // nothing renderable
      ],
      convergence: [1],
    }))
    assert.equal(parsed.kind, 'run-report')
    if (parsed.kind === 'run-report') assert.equal(parsed.report.totalFindings, 1)
  })

  it('coerces unknown severity to low and guards line numbers', () => {
    const parsed = fence.parseIterateFence(JSON.stringify({
      $schema: 'iterate-run-report/1',
      findings: [{ dimension: 'a', file: 'f.ts', line: -3, severity: 'BANANA', summary: 's' }],
      convergence: [1],
    }))
    if (parsed.kind === 'run-report') {
      assert.equal(parsed.report.findings[0]!.severity, 'low')
      assert.equal(parsed.report.findings[0]!.line, null)
    }
  })

  it('does not invent a gate from an empty object', () => {
    assert.equal(fence.normalizeFenceGate({}), null)
  })

  it('tolerates a malformed gate block inside a run report', () => {
    const parsed = fence.parseIterateFence(JSON.stringify({
      $schema: 'iterate-run-report/1',
      findings: [],
      convergence: [],
      qualityGate: { overallStatus: 'fail', dimensions: [{ dimension: 7 }] },
    }))
    if (parsed.kind === 'run-report') {
      assert.ok(parsed.report.gate)
      assert.deepEqual(parsed.report.gate!.dimensions, [])
    }
  })
})

describe('severity / verdict helpers', () => {
  it('coerces severity keys', () => {
    assert.equal(fence.coerceFenceSeverity('critical'), 'critical')
    assert.equal(fence.coerceFenceSeverity('HIGH'), 'high')
    assert.equal(fence.coerceFenceSeverity('whatever'), 'low')
  })

  it('classifies run verdicts', () => {
    assert.equal(fence.fenceVerdict({ active: true, stoppedReason: null }), 'running')
    assert.equal(fence.fenceVerdict({ active: false, stoppedReason: 'converged' }), 'converged')
    assert.equal(fence.fenceVerdict({ active: false, stoppedReason: 'max_rounds_reached' }), 'max-rounds')
    assert.equal(fence.fenceVerdict({ active: false, stoppedReason: 'aborted_by_validation' }), 'validation-aborted')
    assert.equal(fence.fenceVerdict({ active: false, stoppedReason: null }), 'stopped')
  })

  it('renders the severity mix, omitting zero buckets', () => {
    assert.equal(fence.severityMix({ critical: 1, high: 2, medium: 0, low: 0 }), 'critical 1 · high 2')
    assert.equal(fence.severityMix({ critical: 0, high: 0, medium: 0, low: 0 }), '0')
  })
})

describe('buildFenceMarkdown', () => {
  it('renders a run report as a PR-pasteable table', () => {
    const parsed = fence.parseIterateFence(JSON.stringify(sampleRunReport()))
    const md = fence.buildFenceMarkdown(parsed, 'en')
    assert.match(md, /^## Iterate run report — acme\/api/)
    assert.match(md, /- Status: converged/)
    assert.match(md, /- Rounds: 3\/5/)
    assert.match(md, /- Findings: 3 \(critical 1 · high 1 · low 1\)/)
    assert.match(md, /- Fixes: 1\/2/)
    assert.match(md, /- Validations: 2\/2/)
    assert.match(md, /\| severity \| location \| summary \|/i)
    // pipe escaped so the table survives
    assert.match(md, /guard the \\\| pipe/)
  })

  it('renders a quality gate with a dimension table', () => {
    const parsed = fence.parseIterateFence(JSON.stringify(sampleGate()))
    const md = fence.buildFenceMarkdown(parsed, 'zh')
    assert.match(md, /## 质量闸门/)
    assert.match(md, /- 状态: pass/)
    assert.match(md, /- 总分: 91/)
    assert.match(md, /\| 维度 \| 分数 \| 状态 \| 发现 \| 已修复 \|/)
  })

  it('returns empty for invalid / unknown payloads', () => {
    assert.equal(fence.buildFenceMarkdown(fence.parseIterateFence('nope'), 'zh'), '')
    assert.equal(fence.buildFenceMarkdown(fence.parseIterateFence('{"x":1}'), 'zh'), '')
  })

  it('truncates long finding lists with a note', () => {
    const findings = Array.from({ length: fence.FENCE_MARKDOWN_FINDING_LIMIT + 3 }, (_, i) => ({
      dimension: 'a', file: `f${i}.ts`, line: i + 1, severity: 'low', summary: `s${i}`,
    }))
    const parsed = fence.parseIterateFence(JSON.stringify({ $schema: 'iterate-run-report/1', findings, convergence: [] }))
    const md = fence.buildFenceMarkdown(parsed, 'en')
    assert.match(md, /3 more not listed/)
  })

  it('wraps a payload into the fence via toIterateFence', () => {
    const f = fence.toIterateFence({ a: 1 })
    assert.match(f, /^```iterate-report\n/)
    assert.match(f, /"a": 1/)
    assert.match(f, /\n```\n$/)
  })
})

describe('report fence layer — rendering', () => {
  let copied: string[] = []
  let opened: string[] = []
  let deps: FenceLayerDeps

  beforeEach(() => {
    copied = []
    opened = []
    deps = {
      copyText: async (text: string) => { copied.push(text); return true },
      openObservatory: (tab?: string) => { opened.push(tab ?? '') },
    }
    i18n.setLang('zh', false)
  })

  afterEach(() => {
    ;(document.body as unknown as { innerHTML: string }).innerHTML = ''
    i18n.setLang('zh', false)
  })

  function layer(): (props: FenceLayerProps) => unknown {
    return fence.createReportFenceLayer(deps)
  }

  it('yields the plain code block while streaming', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: '{', streaming: true, children: 'CHILD' })
    assert.equal(el.textContent, 'CHILD')
  })

  it('keeps the code block (decorated) for invalid JSON', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: 'nope {', children: 'RAW' })
    assert.match(el.textContent ?? '', /无法解析 iterate-report 负载/)
    assert.match(el.textContent ?? '', /RAW/)
  })

  it('keeps the code block (decorated) for unknown payloads', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: '{"foo":1}', children: 'RAW' })
    assert.match(el.textContent ?? '', /未识别的 iterate 负载/)
    assert.match(el.textContent ?? '', /RAW/)
  })

  it('renders a run report card with metrics, findings and actions', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: 'RAW' })
    const text = el.textContent ?? ''
    assert.match(text, /迭代运行报告/)
    assert.match(text, /已收敛/)
    assert.match(text, /3\/5/)
    assert.match(text, /sql injection/)
    assert.match(text, /质量闸门/)
    assert.doesNotMatch(text, /RAW/) // replaced, not fallback
    // actions present
    const buttons = el.querySelectorAll('button')
    assert.ok(buttons.length >= 3)
  })

  it('hides the findings list under a compact meta', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), meta: 'compact', children: null })
    assert.doesNotMatch(el.textContent ?? '', /sql injection/)
  })

  it('copies PR-ready Markdown on the copy-Markdown action', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: null })
    const buttons = el.querySelectorAll('button')
    // first action button = copy Markdown
    const copyBtn = buttons[0]!
    React.act(() => { copyBtn.click() })
    assert.equal(copied.length, 1)
    assert.match(copied[0]!, /^## 迭代运行报告/)
  })

  it('copies the raw JSON on the copy-JSON action', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: null })
    const buttons = el.querySelectorAll('button')
    React.act(() => { buttons[1]!.click() })
    assert.equal(copied.length, 1)
    assert.match(copied[0]!, /iterate-run-report\/1/)
  })

  it('opens the command center', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: null })
    const buttons = el.querySelectorAll('button')
    React.act(() => { buttons[buttons.length - 1]!.click() })
    assert.deepEqual(opened, ['live'])
  })

  it('surfaces a failed clipboard write', async () => {
    deps.copyText = async () => false
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: null })
    const buttons = el.querySelectorAll('button')
    React.act(() => { buttons[0]!.click() })
    // flush the promise microtask so the failure state can paint
    await new Promise((r) => setImmediate(r))
    React.act(() => {})
    assert.match(el.textContent ?? '', /复制失败/)
  })

  it('renders a quality-gate payload as the gate card', () => {
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleGate()), children: null })
    const text = el.textContent ?? ''
    assert.match(text, /质量闸门报告/)
    assert.match(text, /91/)
    assert.match(text, /验证通过率/)
  })

  it('repaints in English after a language switch', () => {
    i18n.setLang('en', false)
    const el = mount(layer(), { lang: 'iterate-report', code: JSON.stringify(sampleRunReport()), children: null })
    assert.match(el.textContent ?? '', /Iterate run report/)
    assert.match(el.textContent ?? '', /Copy Markdown/)
  })
})

describe('registerReportFence — defensive registration', () => {
  it('registers the layer for the iterate-report key', () => {
    const seen: Array<{ meta: Record<string, unknown>; render: (p: FenceLayerProps) => unknown }> = []
    const ok = fence.registerReportFence({
      inject(_slot: string, cb: () => void) { cb() },
      register(meta, render) { seen.push({ meta, render }); return () => {} },
    }, { copyText: async () => true, openObservatory: () => {} })
    assert.equal(ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.meta.name, 'conversation.chat.markdown.fence')
    assert.equal(seen[0]!.meta.key, 'iterate-report')
    assert.equal(seen[0]!.meta.id, 'iterate-plugin/fence/iterate-report')
    // the registered render is a component
    assert.equal(typeof seen[0]!.render, 'function')
  })

  it('does not throw when the host has no such slot', () => {
    const ok = fence.registerReportFence({
      inject() { throw new Error('unknown slot') },
      register() { return () => {} },
    }, { copyText: async () => true, openObservatory: () => {} })
    assert.equal(ok, false)
  })
})
