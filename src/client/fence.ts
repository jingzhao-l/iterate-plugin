/**
 * src/client/fence.ts — `iterate-report` Markdown-fence renderer.
 *
 * dsh 0.2.2-rc.2 opened the Chat markdown fence to plugins: ChatView supplies a
 * delegate and declares the keyed hoc slot `conversation.chat.markdown.fence`,
 * dispatching every language-tagged fence to the layer registered for that
 * language (`entryKey = fence.lang`) and passing the plain code block as
 * `children`. Layers are optional: an unregistered language, a layer that
 * renders `children`, and a crashed layer all fall back to the normal code
 * block.
 *
 * This module turns that capability into a user-perceivable iterate surface:
 * an assistant reply that ends with
 *
 *   ```iterate-report
 *   { "$schema": "iterate-run-report/1", … }
 *   ```
 *
 * renders as a compact run card — verdict, rounds, severity mix, quality gate,
 * top findings, validation pass rate — with copy-Markdown / copy-JSON / open
 * the command center actions, instead of a wall of raw JSON. The observatory
 * ("copy chat card") and `iterate_report { format: "fence" }` both produce the
 * exact same fence, so the card is reachable without hand-writing JSON.
 *
 * Design constraints, mirroring the rest of the client half:
 *   - **Never throws, never hides data**: unparsable JSON and unknown payloads
 *     render the original code block (decorated with a short warning); while
 *     the message is still streaming the layer yields `children` untouched, so
 *     a half-streamed payload never flashes an error.
 *   - **Pure parsing/summarising**: `parseIterateFence` / `buildFenceMarkdown`
 *     have no React or DOM dependency and are unit-testable on their own.
 *   - **No XSS surface**: every value is rendered as React text; nothing is
 *     passed to `dangerouslySetInnerHTML`.
 *   - **Bilingual**: all chrome goes through `t()` / `tf()` and the layer
 *     subscribes to language changes (see `useLang`).
 */

// dsh's __ModuleLoader__ provides require(); see index.ts for the contract.
declare function require(name: string): unknown
const React = require('react') as typeof import('react')
import { t, tf } from './i18n.ts'
import { useLang } from './lang.ts'

/** Fence language this plugin owns. */
export const FENCE_LANG = 'iterate-report'

/** Slot ChatView declares for per-language fence layers. */
export const FENCE_SLOT = 'conversation.chat.markdown.fence'

/** Registration identity (namespaced so the client slot catalog can name it). */
export const FENCE_LAYER_ID = 'iterate-plugin/fence/iterate-report'

/** Run reports produced by `iterate_report { format: "json" }`. */
export const RUN_REPORT_SCHEMA = 'iterate-run-report/1'

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const
type SeverityKey = (typeof SEVERITY_ORDER)[number]

/** Per-severity finding counts. */
export interface FenceSeverityCounts {
  critical: number
  high: number
  medium: number
  low: number
}

/** One finding row, already coerced to renderable primitives. */
export interface FenceFindingView {
  severity: SeverityKey
  file: string
  line: number | null
  summary: string
}

/** One quality-gate dimension row. */
export interface FenceGateDimensionView {
  dimension: string
  score: number | null
  status: string
  findings: number
  fixed: number
}

/** Quality-gate summary carried by a run report or a standalone gate payload. */
export interface FenceGateView {
  status: string
  score: number | null
  verificationPassRate: number | null
  totalChecks: number | null
  passedChecks: number | null
  failReason: string | null
  dimensions: FenceGateDimensionView[]
}

/** Normalized run report the card renders. */
export interface FenceRunView {
  project: string
  goal: string
  mode: string
  taskMode: string | null
  round: number
  maxRounds: number
  active: boolean
  stoppedReason: string | null
  convergence: number[]
  severityCounts: FenceSeverityCounts
  totalFindings: number
  fixesTotal: number
  fixesApplied: number
  validationsTotal: number
  validationsPassed: number
  gate: FenceGateView | null
  /** Findings sorted most-severe first. */
  findings: FenceFindingView[]
  /** Defense events grouped by type (most frequent first). */
  defenseTypes: Array<{ type: string; count: number }>
}

/** Result of parsing a fence body. */
export type ParsedIterateFence =
  | { kind: 'run-report'; report: FenceRunView }
  | { kind: 'quality-gate'; gate: FenceGateView }
  | { kind: 'invalid'; error: string }
  | { kind: 'unknown' }

// ─── Defensive coercion helpers ─────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Finite, non-negative integer coercion (counts). */
function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** Finite number coercion, `null` when absent or unusable. */
function optionalNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** Coerce an arbitrary severity to a known key (unknown → `low`). */
export function coerceFenceSeverity(value: unknown): SeverityKey {
  const s = str(value).toLowerCase()
  return (SEVERITY_ORDER as readonly string[]).includes(s) ? (s as SeverityKey) : 'low'
}

/** Severity rank (0 = critical) for sorting. */
function severityRank(severity: SeverityKey): number {
  return SEVERITY_ORDER.indexOf(severity)
}

/** Coerce one finding object into the view model. */
function normalizeFinding(value: unknown): FenceFindingView | null {
  const f = asRecord(value)
  if (f === null) return null
  const summary = str(f.summary)
  const file = str(f.file)
  if (summary === '' && file === '') return null
  const line = optionalNumber(f.line)
  return {
    severity: coerceFenceSeverity(f.severity),
    file,
    line: line !== null && line > 0 ? Math.floor(line) : null,
    summary,
  }
}

/** Normalize the quality-gate block (shared by both payload kinds). */
export function normalizeFenceGate(value: unknown): FenceGateView | null {
  const g = asRecord(value)
  if (g === null) return null
  const status = str(g.overallStatus)
  const score = optionalNumber(g.overallScore)
  const dimensions = asList(g.dimensions)
  const totalChecks = optionalNumber(g.totalChecks)
  const passedChecks = optionalNumber(g.passedChecks)
  // A gate must carry at least one recognizable field; `{}` is not a gate.
  if (
    status === '' &&
    score === null &&
    dimensions.length === 0 &&
    totalChecks === null &&
    optionalNumber(g.verificationPassRate) === null
  ) {
    return null
  }
  return {
    status,
    score,
    verificationPassRate: optionalNumber(g.verificationPassRate),
    totalChecks: totalChecks === null ? null : Math.floor(totalChecks),
    passedChecks: passedChecks === null ? null : Math.floor(passedChecks),
    failReason: typeof g.failReason === 'string' && g.failReason !== '' ? g.failReason : null,
    dimensions: dimensions
      .map((value) => asRecord(value))
      .filter((d): d is Record<string, unknown> => d !== null)
      .map((d) => ({
        dimension: str(d.dimension),
        score: optionalNumber(d.score),
        status: str(d.status),
        findings: count(d.findingsCount),
        fixed: count(d.fixedCount),
      }))
      .filter((d) => d.dimension !== ''),
  }
}

/** Normalize a full run report (`iterate-run-report/1`). */
export function normalizeFenceRunReport(value: unknown): FenceRunView | null {
  const o = asRecord(value)
  if (o === null) return null
  const findings = asList(o.findings)
  // Require the run-report fingerprint: the schema tag, or the combo of a
  // findings list plus convergence/severity data. A bare `{findings: []}`
  // stays unknown rather than inventing an empty run.
  const tagged = str(o.$schema) === RUN_REPORT_SCHEMA
  const shaped = Array.isArray(o.findings) && (Array.isArray(o.convergence) || asRecord(o.severityCounts) !== null)
  if (!tagged && !shaped) return null

  const normalized = findings
    .map((f) => normalizeFinding(f))
    .filter((f): f is FenceFindingView => f !== null)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  const declared = asRecord(o.severityCounts)
  const counted: FenceSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of normalized) counted[f.severity] += 1
  const severityCounts: FenceSeverityCounts = declared === null
    ? counted
    : {
        critical: count(declared.critical),
        high: count(declared.high),
        medium: count(declared.medium),
        low: count(declared.low),
      }

  const fixes = asList(o.fixes)
  const validations = asList(o.validations)
  const defense = asRecord(o.defenseEvents)
  const defenseCounts = asRecord(defense?.counts)

  return {
    project: str(o.project),
    goal: str(o.goal),
    mode: str(o.mode),
    taskMode: typeof o.taskMode === 'string' && o.taskMode !== '' ? o.taskMode : null,
    round: count(o.round),
    maxRounds: count(o.maxRounds),
    active: o.active === true,
    stoppedReason: typeof o.stoppedReason === 'string' && o.stoppedReason !== '' ? o.stoppedReason : null,
    convergence: asList(o.convergence)
      .map((n) => optionalNumber(n))
      .filter((n): n is number => n !== null),
    severityCounts,
    totalFindings: normalized.length > 0
      ? normalized.length
      : severityCounts.critical + severityCounts.high + severityCounts.medium + severityCounts.low,
    fixesTotal: fixes.length,
    fixesApplied: fixes.filter((f) => asRecord(f)?.success === true).length,
    validationsTotal: validations.length,
    validationsPassed: validations.filter((v) => asRecord(v)?.allowed === true).length,
    gate: normalizeFenceGate(o.qualityGate),
    findings: normalized,
    defenseTypes: defenseCounts === null
      ? []
      : Object.entries(defenseCounts)
          .map(([type, n]) => ({ type, count: count(n) }))
          .filter((e) => e.count > 0)
          .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  }
}

/**
 * Parse a fence body into the card model.
 *
 * @param code - the fence body (may be undefined while the message streams).
 * @returns the detected payload, `invalid` with a diagnostic, or `unknown`.
 */
export function parseIterateFence(code: unknown): ParsedIterateFence {
  if (typeof code !== 'string') return { kind: 'invalid', error: 'payload is not text' }
  const trimmed = code.trim()
  if (trimmed === '') return { kind: 'invalid', error: 'empty payload' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch (err) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) }
  }
  const report = normalizeFenceRunReport(parsed)
  if (report !== null) return { kind: 'run-report', report }
  const gate = normalizeFenceGate(parsed)
  if (gate !== null) return { kind: 'quality-gate', gate }
  return { kind: 'unknown' }
}

// ─── Verdict / labels ───────────────────────────────────────────────────────

/** Verdict tone used by the card and the Markdown export. */
export type FenceVerdict = 'converged' | 'running' | 'max-rounds' | 'validation-aborted' | 'stopped'

/** Classify how a run ended, from its persisted status fields. */
export function fenceVerdict(report: Pick<FenceRunView, 'active' | 'stoppedReason'>): FenceVerdict {
  if (report.active) return 'running'
  switch (report.stoppedReason) {
    case 'converged':
      return 'converged'
    case 'max_rounds_reached':
      return 'max-rounds'
    case 'aborted_by_validation':
      return 'validation-aborted'
    default:
      return 'stopped'
  }
}

/** Bilingual verdict label (looked up per render, never frozen). */
function verdictLabel(verdict: FenceVerdict): string {
  switch (verdict) {
    case 'converged':
      return t('已收敛')
    case 'running':
      return t('运行中')
    case 'max-rounds':
      return t('已达到轮次上限')
    case 'validation-aborted':
      return t('验证中止')
    default:
      return t('已停止')
  }
}

/** Human label for a defense event type, falling back to the raw id. */
export function defenseTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    precondition_failed: t('前置条件失败'),
    rollback: t('回滚'),
    invariant_violated: t('不变量被破坏'),
    assumption_falsified: t('假设被推翻'),
  }
  return labels[type] ?? type
}

// ─── Markdown / JSON export ─────────────────────────────────────────────────

/** Escape a cell for a Markdown table (pipes + newlines). */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Severity mix as `critical 1 · high 2 · …`, omitting zero buckets. */
export function severityMix(counts: FenceSeverityCounts): string {
  const parts = SEVERITY_ORDER
    .filter((key) => counts[key] > 0)
    .map((key) => `${key} ${counts[key]}`)
  return parts.length > 0 ? parts.join(' · ') : '0'
}

/** Bilingual labels for the Markdown export (inline pairs so the i18n test
 *  treats them as translated-in-place, not as dictionary keys — they are a
 *  pure builder, not UI chrome). */
const MD_LABELS: Record<string, { zh: string; en: string }> = {
  runTitle: { zh: '迭代运行报告', en: 'Iterate run report' },
  gateTitle: { zh: '质量闸门', en: 'Quality gate' },
  status: { zh: '状态', en: 'Status' },
  rounds: { zh: '轮次', en: 'Rounds' },
  findings: { zh: '发现', en: 'Findings' },
  fixes: { zh: '修复', en: 'Fixes' },
  validations: { zh: '验证', en: 'Validations' },
  score: { zh: '总分', en: 'Score' },
  rate: { zh: '验证通过率', en: 'Verification pass rate' },
  checks: { zh: '检查项', en: 'Checks' },
  fail: { zh: '失败原因', en: 'Failure' },
  dims: { zh: '维度', en: 'Dimensions' },
  goal: { zh: '目标', en: 'Goal' },
  severity: { zh: '严重度', en: 'Severity' },
  location: { zh: '位置', en: 'Location' },
  summary: { zh: '摘要', en: 'Summary' },
  dimHeader: { zh: '| 维度 | 分数 | 状态 | 发现 | 已修复 |', en: '| Dimension | Score | Status | Findings | Fixed |' },
  findingHeader: { zh: '| 严重度 | 位置 | 摘要 |', en: '| Severity | Location | Summary |' },
  moreNote: { zh: '另有 {a0} 项未列出；完整列表见 JSON 报告。', en: '{a0} more not listed; see the JSON report for the complete list.' },
  noFindings: { zh: '本轮未发现新问题。', en: 'No findings in this run.' },
}

/** Bilingual verdict labels (pure builder path; the UI path uses `t()`). */
const VERDICT_LABELS: Record<FenceVerdict, { zh: string; en: string }> = {
  converged: { zh: '已收敛', en: 'converged' },
  running: { zh: '运行中', en: 'running' },
  'max-rounds': { zh: '已达到轮次上限', en: 'max rounds reached' },
  'validation-aborted': { zh: '验证中止', en: 'aborted by validation' },
  stopped: { zh: '已停止', en: 'stopped' },
}

/** Pick a bilingual label for the export language. */
function mdLabel(key: string, lang: 'zh' | 'en'): string {
  const pair = MD_LABELS[key]
  if (!pair) return key
  return lang === 'zh' ? pair.zh : pair.en
}

/** How many findings the Markdown export lists before truncating. */
export const FENCE_MARKDOWN_FINDING_LIMIT = 20

/**
 * Build the PR-pasteable Markdown version of a fence payload. Used by the
 * card's copy button; deliberately self-contained (no manifest needed).
 *
 * @param parsed - parsed fence payload.
 * @param lang - target report language.
 */
export function buildFenceMarkdown(parsed: ParsedIterateFence, lang: 'zh' | 'en'): string {
  if (parsed.kind === 'invalid') return ''
  if (parsed.kind === 'unknown') return ''

  if (parsed.kind === 'quality-gate') {
    const gate = parsed.gate
    const lines: string[] = [
      `## ${mdLabel('gateTitle', lang)}`,
      '',
      `- ${mdLabel('status', lang)}: ${gate.status || '—'}`,
      `- ${mdLabel('score', lang)}: ${gate.score === null ? '—' : String(gate.score)}`,
      `- ${mdLabel('rate', lang)}: ${gate.verificationPassRate === null ? '—' : `${gate.verificationPassRate}%`}`,
      `- ${mdLabel('checks', lang)}: ${gate.passedChecks ?? 0}/${gate.totalChecks ?? 0}`,
    ]
    if (gate.failReason !== null) lines.push(`- ${mdLabel('fail', lang)}: ${gate.failReason}`)
    if (gate.dimensions.length > 0) {
      lines.push('', `### ${mdLabel('dims', lang)}`, '', mdLabel('dimHeader', lang), '| --- | --- | --- | --- | --- |')
      for (const d of gate.dimensions) {
        lines.push(`| ${mdCell(d.dimension)} | ${d.score === null ? '—' : d.score} | ${d.status || '—'} | ${d.findings} | ${d.fixed} |`)
      }
    }
    return `${lines.join('\n')}\n`
  }

  const r = parsed.report
  const verdict = lang === 'zh' ? VERDICT_LABELS[fenceVerdict(r)].zh : VERDICT_LABELS[fenceVerdict(r)].en
  const lines: string[] = [
    `## ${mdLabel('runTitle', lang)}${r.project ? ` — ${r.project}` : ''}`,
    '',
    `- ${mdLabel('status', lang)}: ${verdict}`,
    `- ${mdLabel('rounds', lang)}: ${r.round}/${r.maxRounds || '—'}`,
    `- ${mdLabel('findings', lang)}: ${r.totalFindings}${r.totalFindings > 0 ? ` (${severityMix(r.severityCounts)})` : ''}`,
    `- ${mdLabel('fixes', lang)}: ${r.fixesApplied}/${r.fixesTotal}`,
    `- ${mdLabel('validations', lang)}: ${r.validationsPassed}/${r.validationsTotal}`,
  ]
  if (r.gate !== null) {
    lines.push(`- ${mdLabel('gateTitle', lang)}: ${r.gate.status || '—'}${r.gate.score === null ? '' : ` (${r.gate.score})`}`)
  }
  if (r.goal !== '') lines.push(`- ${mdLabel('goal', lang)}: ${r.goal}`)
  if (r.findings.length > 0) {
    lines.push('', `### ${mdLabel('findings', lang)}`, '', mdLabel('findingHeader', lang), '| --- | --- | --- |')
    for (const f of r.findings.slice(0, FENCE_MARKDOWN_FINDING_LIMIT)) {
      const location = f.file === '' ? '—' : f.line === null ? f.file : `${f.file}:${f.line}`
      lines.push(`| ${f.severity} | ${mdCell(location)} | ${mdCell(f.summary || '—')} |`)
    }
    if (r.findings.length > FENCE_MARKDOWN_FINDING_LIMIT) {
      lines.push('', `> ${mdLabel('moreNote', lang).replace('{a0}', String(r.findings.length - FENCE_MARKDOWN_FINDING_LIMIT))}`)
    }
  } else {
    lines.push('', mdLabel('noFindings', lang))
  }
  return `${lines.join('\n')}\n`
}

/** Wrap a JSON payload into the exact fenced block the card renders. */
export function toIterateFence(payload: unknown): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return `\`\`\`${FENCE_LANG}\n${String(body).trimEnd()}\n\`\`\`\n`
}

// ─── React layer ────────────────────────────────────────────────────────────

/** Props ChatView passes to a fence layer. */
export interface FenceLayerProps {
  lang?: unknown
  meta?: unknown
  code?: unknown
  streaming?: unknown
  children?: unknown
}

/** Imperative ports the card needs (injected so the layer stays testable). */
export interface FenceLayerDeps {
  /** Clipboard write; resolves whether it succeeded. */
  copyText(text: string): Promise<boolean>
  /** Open the observatory on a tab. */
  openObservatory(tab?: string): void
}

const FINDINGS_PREVIEW_LIMIT = 3

/** Tone for a verdict badge. */
function verdictTone(verdict: FenceVerdict): 'ok' | 'warn' | 'muted' {
  if (verdict === 'converged') return 'ok'
  if (verdict === 'running' || verdict === 'stopped') return 'muted'
  return 'warn'
}

/** Gate status → tone (`pass`/`warn`/`fail`/`pending`). */
function gateTone(status: string): 'pass' | 'warn' | 'fail' | 'pending' {
  const s = status.toLowerCase()
  if (s === 'pass' || s === 'passed' || s === 'ok') return 'pass'
  if (s === 'warn' || s === 'warning') return 'warn'
  if (s === 'fail' || s === 'failed' || s === 'error') return 'fail'
  return 'pending'
}

/** A small labeled metric cell. */
function metric(label: string, value: string, key: string): React.ReactElement {
  return React.createElement('span', { className: 'iterate-fence-metric', key },
    React.createElement('span', { className: 'iterate-fence-metric-label' }, label),
    React.createElement('b', { className: 'iterate-fence-metric-value' }, value),
  )
}

/** Findings preview rows (most severe first). */
function findingsBlock(findings: FenceFindingView[]): React.ReactElement | null {
  if (findings.length === 0) return null
  const rows = findings.slice(0, FINDINGS_PREVIEW_LIMIT)
  return React.createElement('div', { className: 'iterate-fence-findings' },
    ...rows.map((f, i) => React.createElement('div', { className: 'iterate-fence-finding', key: `f-${i}` },
      React.createElement('span', { className: 'iterate-fence-sev', 'data-sev': f.severity }, f.severity),
      React.createElement('span', { className: 'iterate-fence-loc' },
        f.file === '' ? '—' : f.line === null ? f.file : `${f.file}:${f.line}`,
      ),
      React.createElement('span', { className: 'iterate-fence-summary' }, f.summary),
    )),
    findings.length > rows.length
      ? React.createElement('div', { className: 'iterate-fence-more' },
          tf('另有 {a0} 项发现', { a0: findings.length - rows.length }),
        )
      : null,
  )
}

/** Quality-gate block (status, score, verification, dimension bars). */
function gateBlock(gate: FenceGateView): React.ReactElement {
  const tone = gateTone(gate.status)
  const dims = gate.dimensions.slice(0, 4)
  return React.createElement('div', { className: 'iterate-fence-gate' },
    React.createElement('div', { className: 'iterate-fence-gate-head' },
      React.createElement('span', { className: 'iterate-fence-gate-label' }, t('质量闸门')),
      React.createElement('span', { className: 'iterate-fence-gate-status', 'data-status': tone }, gate.status || t('未计算')),
      gate.score === null ? null : React.createElement('span', { className: 'iterate-fence-metric-value' }, String(gate.score)),
      gate.verificationPassRate === null
        ? null
        : React.createElement('span', { className: 'iterate-fence-gate-meta' }, tf('验证 {a0}%', { a0: gate.verificationPassRate })),
    ),
    gate.failReason === null
      ? null
      : React.createElement('div', { className: 'iterate-fence-gate-fail' }, gate.failReason),
    dims.length === 0
      ? null
      : React.createElement('div', { className: 'iterate-fence-dims' },
          ...dims.map((d, i) => React.createElement('span', { className: 'iterate-fence-dim', key: `d-${i}` },
            React.createElement('span', { className: 'iterate-fence-dim-name' }, d.dimension),
            React.createElement('span', { className: 'iterate-fence-dim-score', 'data-status': gateTone(d.status) },
              d.score === null ? d.status || '—' : String(Math.round(d.score)),
            ),
          )),
        ),
  )
}

/** Copy/open action footer with transient feedback. */
function ActionBar(props: {
  parsed: ParsedIterateFence
  raw: string
  deps: FenceLayerDeps
}): React.ReactElement {
  const { parsed, raw, deps } = props
  // Copy in the language currently on screen, not the language at mount.
  const lang = useLang()
  const dispatchOpen = () => { deps.openObservatory('live') }
  return React.createElement('div', { className: 'iterate-fence-actions' },
    React.createElement(FenceCopyButton, {
      label: t('复制 Markdown'),
      className: 'iterate-fence-btn',
      text: () => buildFenceMarkdown(parsed, lang) || '',
      copyText: deps.copyText,
      key: 'md',
    }),
    React.createElement(FenceCopyButton, {
      label: t('复制 JSON'),
      className: 'iterate-fence-btn',
      text: () => raw,
      copyText: deps.copyText,
      key: 'json',
    }),
    React.createElement('button', {
      type: 'button',
      className: 'iterate-fence-btn',
      onClick: dispatchOpen,
      title: t('打开实时质量指挥中心'),
      key: 'open',
    }, t('打开指挥中心')),
  )
}

/** Copy button with per-instance feedback and a failure state. */
function FenceCopyButton(props: {
  label: string
  className: string
  text: () => string
  copyText: (text: string) => Promise<boolean>
}): React.ReactElement {
  const [state, setState] = React.useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const onClick = () => {
    props.copyText(props.text()).then((ok) => {
      setState(ok ? 'ok' : 'fail')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 1600)
    }).catch(() => { setState('fail') })
  }
  const label = state === 'ok' ? t('已复制') : state === 'fail' ? t('复制失败') : props.label
  return React.createElement('button', {
    type: 'button',
    className: props.className,
    'data-copied': state === 'ok' ? '' : undefined,
    'data-failed': state === 'fail' ? '' : undefined,
    onClick,
    title: props.label,
  }, label)
}

/** Render a parsed run report as the card. */
function RunCard(props: { report: FenceRunView; parsed: ParsedIterateFence; raw: string; compact: boolean; deps: FenceLayerDeps }): React.ReactElement {
  const { report, parsed, raw, compact, deps } = props
  const verdict = fenceVerdict(report)
  const defense = report.defenseTypes.length === 0
    ? null
    : React.createElement('div', { className: 'iterate-fence-defense' },
        ...report.defenseTypes.slice(0, 3).map((d, i) => React.createElement('span', {
          className: 'iterate-defense-badge', 'data-type': d.type, key: `def-${i}`,
        }, `${defenseTypeLabel(d.type)} ${d.count}`)),
      )
  return React.createElement('div', { className: 'iterate-fence', 'data-kind': 'run-report', 'data-verdict': verdict },
    React.createElement('div', { className: 'iterate-fence-head' },
      React.createElement('span', { className: 'iterate-fence-title' }, t('迭代运行报告')),
      React.createElement('span', { className: 'iterate-fence-verdict', 'data-tone': verdictTone(verdict) }, verdictLabel(verdict)),
      report.project === ''
        ? null
        : React.createElement('span', { className: 'iterate-fence-project', title: report.project }, report.project),
      report.mode === ''
        ? null
        : React.createElement('span', { className: 'iterate-fence-mode' }, report.mode),
    ),
    React.createElement('div', { className: 'iterate-fence-metrics' },
      metric(t('轮次'), `${report.round}/${report.maxRounds || '—'}`, 'rounds'),
      metric(t('发现'), String(report.totalFindings), 'findings'),
      metric(t('已修复'), `${report.fixesApplied}/${report.fixesTotal}`, 'fixes'),
      metric(t('验证'), `${report.validationsPassed}/${report.validationsTotal}`, 'validations'),
    ),
    report.totalFindings > 0
      ? React.createElement('div', { className: 'iterate-fence-mix' }, severityMix(report.severityCounts))
      : React.createElement('div', { className: 'iterate-fence-empty' }, t('本次运行未发现新问题')),
    report.gate === null ? null : gateBlock(report.gate),
    compact ? null : findingsBlock(report.findings),
    defense,
    React.createElement(ActionBar, { parsed, raw, deps }),
  )
}

/** Render a parsed quality-gate payload as the card. */
function GateCard(props: { gate: FenceGateView; parsed: ParsedIterateFence; raw: string; deps: FenceLayerDeps }): React.ReactElement {
  const { gate, parsed, raw, deps } = props
  return React.createElement('div', { className: 'iterate-fence', 'data-kind': 'quality-gate', 'data-verdict': gateTone(gate.status) },
    React.createElement('div', { className: 'iterate-fence-head' },
      React.createElement('span', { className: 'iterate-fence-title' }, t('质量闸门报告')),
      React.createElement('span', { className: 'iterate-fence-verdict', 'data-tone': gateTone(gate.status) === 'pass' ? 'ok' : gateTone(gate.status) === 'pending' ? 'muted' : 'warn' },
        gate.status || t('未计算'),
      ),
    ),
    React.createElement('div', { className: 'iterate-fence-metrics' },
      metric(t('总分'), gate.score === null ? '—' : String(gate.score), 'score'),
      metric(t('验证通过率'), gate.verificationPassRate === null ? '—' : `${gate.verificationPassRate}%`, 'rate'),
      metric(t('检查项'), `${gate.passedChecks ?? 0}/${gate.totalChecks ?? 0}`, 'checks'),
    ),
    gateBlock(gate),
    React.createElement(ActionBar, { parsed, raw, deps }),
  )
}

/** Fallback: keep the original code block, decorated with a short warning. */
function FallbackCard(props: { message: string; children?: unknown }): React.ReactElement {
  return React.createElement('div', { className: 'iterate-fence', 'data-kind': 'fallback' },
    React.createElement('div', { className: 'iterate-fence-warn', role: 'status' }, props.message),
    props.children === undefined || props.children === null ? null : (props.children as React.ReactNode),
  )
}

/**
 * Create the fence layer component. It reads `lang` / `code` / `streaming` /
 * `meta` / `children` from ChatView, so a card re-renders as chunks arrive.
 *
 * @param deps - clipboard + command-center ports.
 * @returns the slot layer component.
 */
export function createReportFenceLayer(deps: FenceLayerDeps): (props: FenceLayerProps) => unknown {
  return function ReportFenceLayer(props: FenceLayerProps): unknown {
    // Subscribe even on fallback paths so a language switch repaints the card.
    useLang()
    const children = props.children
    // While streaming, the payload is incomplete: show the plain code block.
    if (props.streaming === true) return children
    const parsed = parseIterateFence(props.code)
    if (parsed.kind === 'invalid') {
      return React.createElement(FallbackCard, {
        message: tf('无法解析 iterate-report 负载：{a0}', { a0: parsed.error }),
        children,
      })
    }
    if (parsed.kind === 'unknown') {
      return React.createElement(FallbackCard, {
        message: t('未识别的 iterate 负载（已回退为普通代码块）'),
        children,
      })
    }
    const raw = typeof props.code === 'string' ? props.code.trim() : ''
    const compact = typeof props.meta === 'string' && /\bcompact\b/i.test(props.meta)
    return parsed.kind === 'run-report'
      ? React.createElement(RunCard, { report: parsed.report, parsed, raw, compact, deps })
      : React.createElement(GateCard, { gate: parsed.gate, parsed, raw, deps })
  }
}

/**
 * Register the layer with the slots service, tolerating a host that predates
 * the keyed-fence capability (unknown slot → no-op, panel stays the entry).
 *
 * @param slots - client slots service.
 * @param deps - clipboard + command-center ports.
 * @returns whether an injection was installed.
 */
export function registerReportFence(
  slots: {
    inject(slot: string, getLayer: () => void): void
    register(
      meta: { name: string; id: string; key?: string; order?: number },
      render: (props: FenceLayerProps) => unknown,
    ): () => void
  },
  deps: FenceLayerDeps,
): boolean {
  const layer = createReportFenceLayer(deps)
  try {
    slots.inject(FENCE_SLOT, () => {
      try {
        slots.register(
          { name: FENCE_SLOT, key: FENCE_LANG, id: FENCE_LAYER_ID, order: 0 },
          layer,
        )
      } catch {
        /* a host without the keyed-fence slot keeps the plain code block */
      }
    })
    return true
  } catch {
    return false
  }
}
