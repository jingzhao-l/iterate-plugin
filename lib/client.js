/**
 * lib/client.js — iterate-plugin client entry.
 *
 * Loaded by the dsh web front-end via `package.json.dsh.client` (the
 * `exports["./client"]` subpath). Module contract matches dsh-gui-customization:
 * the file exports an `apply(ctx)` function that is called with the client
 * Cordis context.
 *
 * Implements the §14.4 / §16 six-part UI layer:
 *   1. Convergence dashboard  -> conversation.input.dock
 *   2. Findings triage panel  -> conversation.chat.turnTail
 *   3. Iteration stats card   -> conversation.chat.turnTail (same chain, empty-findings case)
 *   4. iterate theme skin     -> theme.overrideTokens
 *   5. Progress event linkage -> ctx.on('slots/changed') + round-pulse + shell.overlay capsule
 *   6. Settings page section  -> settings.section
 *
 * Design notes:
 *   - Build-free: no bundler. All styles are injected via one <style> tag and
 *     colors use the dsh token variables (`--dsw-*`).
 *   - Defensive by design: every service lookup is optional and guarded, so a
 *     missing slot/theme/React degrades gracefully instead of crashing the UI.
 */

import {
  findReportInObject,
  scanSessionForReport,
  normalizeReport,
  computeConvergenceProgress,
  getCurrentRound,
  getTotalRounds,
  severityStats,
  groupByDimension,
  buildTriageState,
  hashReport,
  toKnownIntentionalYaml,
  buildApplyInstruction,
  collectIgnoredEntries,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
} from './parse.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const PLUGIN_TAG = 'iterate-ui'

/** localStorage key prefix for triage verdicts. */
const TRIAGE_STORAGE_PREFIX = 'iterate.triage.'

/** localStorage key for the theme skin toggle. */
const THEME_STORAGE_KEY = 'iterate.theme.enabled'

/** Theme override source name (matches the doc §16.1). */
const THEME_SOURCE = 'iterate'

/** Theme tokens: 13 dsw tokens, each with light + dark values (warm amber accent). */
const ITERATE_TOKENS = {
  '--dsw-alias-bg-base': { light: '#FAF8F5', dark: '#171412' },
  '--dsw-alias-bg-layer-1': { light: '#FFFFFF', dark: '#1F1B17' },
  '--dsw-alias-bg-layer-2': { light: '#F4F1EA', dark: '#27221C' },
  '--dsw-alias-bg-overlay': { light: 'rgba(255,255,255,0.96)', dark: 'rgba(23,20,18,0.96)' },
  '--dsw-alias-border-l1': { light: '#E8E2D8', dark: '#332C25' },
  '--dsw-alias-border-l2': { light: '#DDD5C9', dark: '#3C342B' },
  '--dsw-alias-brand-primary': { light: '#B45309', dark: '#F59E0B' },
  '--dsw-alias-label-primary': { light: '#1C1917', dark: '#F5F0EA' },
  '--dsw-alias-label-secondary': { light: '#57534E', dark: '#A9A29B' },
  '--dsw-alias-state-error-primary': { light: '#DC2626', dark: '#F87171' },
  '--dsw-alias-state-success-primary': { light: '#15803D', dark: '#4ADE80' },
  '--dsw-alias-state-warn-primary': { light: '#D97706', dark: '#FBBF24' },
  '--dsw-specific-sidebar-fill': { light: '#F5F2EC', dark: '#14110E' },
}

/** Injected stylesheet. Every selector is prefixed to avoid clobbering dsh. */
const ITERATE_CSS = `
[data-iterate-root] { box-sizing: border-box; font-family: var(--dsw-font-sans, system-ui, sans-serif); }
[data-iterate-root] * , [data-iterate-root] *::before, [data-iterate-root] *::after { box-sizing: border-box; }

.iterate-dashboard {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 14px; margin: 6px 0;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.iterate-round-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-brand-primary); font-weight: 600; white-space: nowrap;
}
.iterate-round-badge[data-pulse] { animation: iterate-pulse 700ms ease-out; }
@keyframes iterate-pulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, transparent); }
  50% { transform: scale(1.12); box-shadow: 0 0 0 6px color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); }
  100% { transform: scale(1); box-shadow: 0 0 0 0 transparent; }
}
.iterate-progress { flex: 1 1 120px; min-width: 120px; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.iterate-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 300ms ease; }
.iterate-metric { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.iterate-sev-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.iterate-dim-badge {
  padding: 2px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap;
}

.iterate-triage { margin: 10px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.iterate-triage-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.iterate-triage-hint { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.iterate-finding { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.iterate-finding:last-child { border-bottom: none; }
.iterate-finding-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.iterate-finding-file { font-family: var(--dsw-font-mono, ui-monospace, monospace); color: var(--dsw-alias-label-primary); }
.iterate-finding-summary { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-primary); line-height: 1.5; }
.iterate-finding-actions { display: flex; gap: 6px; margin-top: 8px; }
.iterate-vbtn {
  padding: 3px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px; cursor: pointer;
}
.iterate-vbtn[data-active="keep"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.iterate-vbtn[data-active="skip"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.iterate-vbtn[data-active="ignore"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.iterate-triage-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 14px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.iterate-btn {
  padding: 4px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 11px; cursor: pointer;
}
.iterate-btn[data-primary] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.iterate-btn[data-copied] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.iterate-payload { width: 100%; margin-top: 8px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; white-space: pre-wrap; }

.iterate-stats { margin: 10px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; }
.iterate-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-top: 8px; }
.iterate-stat { padding: 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); text-align: center; }
.iterate-stat-num { font-size: 18px; font-weight: 700; color: var(--dsw-alias-label-primary); }
.iterate-stat-label { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }

.iterate-capsule {
  position: fixed; bottom: 24px; right: 24px; z-index: 9999;
  padding: 8px 14px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  animation: iterate-fadein 200ms ease-out; pointer-events: auto;
}
@keyframes iterate-fadein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

.iterate-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 12px; }
.iterate-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.iterate-settings-row:last-child { border-bottom: none; }
.iterate-settings-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.iterate-settings-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; line-height: 1.5; }
.iterate-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
`

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Namespaced logger (kept minimal; only errors/warnings, no debug spam). */
function log(...args) {
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(`[${PLUGIN_TAG}]`, ...args)
  }
}

/** Resolve the React runtime (ctx.React first, then window.React). */
function resolveReact(ctx) {
  if (ctx && ctx.React && typeof ctx.React.createElement === 'function') return ctx.React
  const globalScope = typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null
  if (globalScope && globalScope.React && typeof globalScope.React.createElement === 'function') {
    return globalScope.React
  }
  return null
}

/** Safe localStorage wrapper (never throws in private mode / SSR). */
function createStorage() {
  try {
    const testKey = '__iterate_storage_test__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return {
      get(key) { return window.localStorage.getItem(key) },
      set(key, value) { window.localStorage.setItem(key, value) },
      remove(key) { window.localStorage.removeItem(key) },
    }
  } catch {
    const mem = new Map()
    return {
      get(key) { return mem.has(key) ? mem.get(key) : null },
      set(key, value) { mem.set(key, value) },
      remove(key) { mem.delete(key) },
    }
  }
}

/** Copy text to the clipboard, returning whether it succeeded. */
function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    )
    return true
  }
  return false
}

// ─── Module-level runtime state (shared across slots) ────────────────────────

let React = null
let slotsSvc = null
let themeSvc = null
let storage = null
let themeDisposer = null
let themeEnabled = true
const roundPulseListeners = []

/** Emit a "round changed" pulse to subscribed components. */
function emitRoundPulse(round) {
  for (const fn of roundPulseListeners.slice()) fn(round)
}

/** Apply the iterate theme skin (idempotent). */
function applyThemeSkin() {
  if (!themeSvc || typeof themeSvc.overrideTokens !== 'function') return
  // Never stack disposers: drop any previously applied override first.
  clearThemeSkin()
  themeDisposer = themeSvc.overrideTokens(THEME_SOURCE, ITERATE_TOKENS)
}

/** Remove the iterate theme skin (idempotent). */
function clearThemeSkin() {
  if (themeDisposer) {
    try { themeDisposer() } catch (err) { log('theme disposer failed', err) }
    themeDisposer = null
  }
}

/** Persist + apply the theme preference. */
function setThemeEnabled(enabled) {
  themeEnabled = enabled
  if (storage) storage.set(THEME_STORAGE_KEY, enabled ? '1' : '0')
  if (enabled) applyThemeSkin()
  else clearThemeSkin()
}

// ─── Components (React.createElement trees) ──────────────────────────────────

/** Obtain a session snapshot defensively from the slot props. */
function sessionSnapshot(props) {
  let session = null
  if (props && typeof props.useSession === 'function') {
    try { session = props.useSession() } catch (err) { log('useSession failed', err) }
  }
  if (!session && props && props.session) session = props.session
  return session
}

/** Find the latest report inside a session snapshot (normalized). */
function latestReport(session) {
  if (!session) return null
  const raw = scanSessionForReport(session) || findReportInObject(session, undefined, 24)
  return raw ? normalizeReport(raw) : null
}

/** Dashboard: live convergence strip above the composer. */
function ConvergenceDashboard(props) {
  const [pulseKey, setPulseKey] = React.useState(0)
  const report = latestReport(sessionSnapshot(props))

  React.useEffect(() => {
    if (!report) return
    const cur = getCurrentRound(report)
    emitRoundPulse(cur)
    setPulseKey((k) => k + 1)
  }, [report && hashReport(report) + ':' + getCurrentRound(report)])

  if (!report) return null

  const round = getCurrentRound(report)
  const total = getTotalRounds(report)
  const progress = computeConvergenceProgress(report)
  const stats = severityStats(report)
  const dims = groupByDimension(report)

  const dimBadges = Object.keys(dims).slice(0, 6).map((dim) =>
    React.createElement(
      'span',
      { key: dim, className: 'iterate-dim-badge' },
      `${dim} · ${dims[dim].length}`,
    ),
  )

  return React.createElement(
    'div',
    { 'data-iterate-root': '', 'data-iterate': 'dashboard', className: 'iterate-dashboard' },
    React.createElement(
      'span',
      { className: 'iterate-round-badge', 'data-pulse': pulseKey > 0 ? '' : undefined, key: `round-${round}` },
      `Round ${round} / ${total}`,
    ),
    React.createElement('div', { className: 'iterate-progress' },
      React.createElement('div', { className: 'iterate-progress-fill', style: { width: `${progress}%` } }),
    ),
    React.createElement('span', { className: 'iterate-metric' },
      React.createElement('span', { className: 'iterate-sev-dot', style: { background: SEVERITY_COLOR.critical } }),
      stats.critical,
    ),
    React.createElement('span', { className: 'iterate-metric' },
      React.createElement('span', { className: 'iterate-sev-dot', style: { background: SEVERITY_COLOR.high } }),
      stats.high,
    ),
    React.createElement('span', { className: 'iterate-metric' },
      React.createElement('span', { className: 'iterate-sev-dot', style: { background: SEVERITY_COLOR.medium } }),
      stats.medium,
    ),
    ...dimBadges,
  )
}

/** Stats card (empty-findings case of the turn-tail chain). */
function StatsCard(props) {
  const report = props.report
  const stats = severityStats(report)
  const total = stats.critical + stats.high + stats.medium + stats.low
  const rows = [
    { label: 'Critical', value: stats.critical, color: SEVERITY_COLOR.critical },
    { label: 'High', value: stats.high, color: SEVERITY_COLOR.high },
    { label: 'Medium', value: stats.medium, color: SEVERITY_COLOR.medium },
    { label: 'Low', value: stats.low, color: SEVERITY_COLOR.low },
  ].map((r) =>
    React.createElement('div', { key: r.label, className: 'iterate-stat' },
      React.createElement('div', { className: 'iterate-stat-num', style: { color: r.color } }, String(r.value)),
      React.createElement('div', { className: 'iterate-stat-label' }, r.label),
    ),
  )

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'stats', className: 'iterate-stats' },
    React.createElement('div', { className: 'iterate-triage-head' },
      React.createElement('span', {}, 'Iterate · 收敛统计'),
      React.createElement('span', { className: 'iterate-triage-hint' },
        `Round ${getCurrentRound(report)}/${getTotalRounds(report)} · ${total} findings · ${report.convergence && report.convergence.converged ? '已收敛' : '未收敛'}`,
      ),
    ),
    React.createElement('div', { className: 'iterate-stats-grid' }, ...rows),
  )
}

/** Triage panel: per-finding y / n / a with localStorage persistence. */
function TriagePanel(props) {
  const report = props.report
  const findings = report.findings
  const storageKey = TRIAGE_STORAGE_PREFIX + hashReport(report)
  const [verdicts, setVerdicts] = React.useState(() => {
    const initial = buildTriageState(report)
    const saved = storage ? storage.get(storageKey) : null
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(initial)) {
            if (parsed[key] === 'keep' || parsed[key] === 'skip' || parsed[key] === 'ignore') {
              initial[key] = parsed[key]
            }
          }
        }
      } catch { /* corrupt storage, fall back to defaults */ }
    }
    return initial
  })
  const [payload, setPayload] = React.useState(null)
  const [copied, setCopied] = React.useState(false)

  const setVerdict = (index, verdict) => {
    setVerdicts((prev) => {
      const next = { ...prev, [String(index)]: verdict }
      if (storage) storage.set(storageKey, JSON.stringify(next))
      return next
    })
  }

  const ignored = collectIgnoredEntries(verdicts, findings)
  const ignoredCount = ignored.length

  const doCopyYaml = () => {
    const yaml = toKnownIntentionalYaml(ignored)
    if (!yaml) return
    const ok = copyText(yaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
    if (!ok) setPayload(yaml)
  }

  const doBuildInstruction = () => {
    const text = buildApplyInstruction(ignored)
    setPayload(text)
    if (text) copyText(text)
  }

  const rows = findings.map((finding, index) => {
    const severity = finding.severity || 'low'
    const verdict = verdicts[String(index)] || 'keep'
    const btn = (label, value, title) =>
      React.createElement(
        'button',
        {
          key: value,
          className: 'iterate-vbtn',
          'data-active': verdict === value ? value : undefined,
          title,
          onClick: () => setVerdict(index, value),
        },
        label,
      )

    return React.createElement('div', { key: String(index), className: 'iterate-finding' },
      React.createElement('div', { className: 'iterate-finding-meta' },
        React.createElement('span', { className: 'iterate-sev-dot', style: { background: SEVERITY_COLOR[severity] || SEVERITY_COLOR.low } }),
        React.createElement('span', {}, String(SEVERITY_LABEL[severity] || 'LOW')),
        React.createElement('span', { className: 'iterate-finding-file' }, String(finding.file || '?')),
        finding.line ? React.createElement('span', {}, `:${finding.line}`) : null,
        React.createElement('span', {}, String(finding.dimension || '')),
      ),
      React.createElement('div', { className: 'iterate-finding-summary' }, String(finding.summary || '')),
      React.createElement('div', { className: 'iterate-finding-actions' },
        btn('y 修复', 'keep', '保留该 finding，进入修复'),
        btn('n 跳过', 'skip', '跳过该 finding'),
        btn('a 已知有意', 'ignore', '标记为已知有意并写入 known_intentional'),
      ),
    )
  })

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'triage', className: 'iterate-triage' },
    React.createElement('div', { className: 'iterate-triage-head' },
      React.createElement('span', {}, `Iterate · Findings 分诊 (${findings.length})`),
      React.createElement('span', { className: 'iterate-triage-hint' }, 'y=修复 · n=跳过 · a=已知有意'),
    ),
    ...rows,
    React.createElement('div', { className: 'iterate-triage-foot' },
      React.createElement('span', {}, `待写回 known_intentional：${ignoredCount} 条`),
      React.createElement('span', { style: { display: 'flex', gap: 6 } },
        React.createElement('button', { className: 'iterate-btn', 'data-primary': '', 'data-copied': copied ? '' : undefined, onClick: doCopyYaml }, copied ? '已复制' : '复制 known_intentional'),
        React.createElement('button', { className: 'iterate-btn', onClick: doBuildInstruction }, '生成应用指令'),
      ),
    ),
    payload
      ? React.createElement('div', { className: 'iterate-payload' }, payload)
      : null,
  )
}

/** Turn-tail chain entry: triage when findings exist, stats card otherwise. */
function TurnTailEntry(props) {
  const candidates = []
  if (props && props.turn) candidates.push(props.turn)
  if (props && props.matched) candidates.push(props.matched)
  if (props && props.data) candidates.push(props.data)
  candidates.push(props)

  let report = null
  for (const c of candidates) {
    const raw = findReportInObject(c, undefined, 24) || scanSessionForReport(c)
    if (raw) { report = normalizeReport(raw); break }
  }
  if (!report) return null
  // Render through React.createElement so each panel is a real component with
  // its own hook identity (calling them as functions would violate the Rules
  // of Hooks and crash when the findings/empty branch flips between renders).
  if (!report.findings || report.findings.length === 0) {
    return React.createElement(StatsCard, { report })
  }
  return React.createElement(TriagePanel, { report })
}

/** Progress capsule: briefly surfaces round-completion in a frame overlay. */
function ProgressCapsule() {
  const [info, setInfo] = React.useState(null)
  React.useEffect(() => {
    let timer = null
    const listener = (round) => {
      setInfo(`Round ${round} 完成`)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setInfo(null), 2400)
    }
    roundPulseListeners.push(listener)
    return () => {
      const i = roundPulseListeners.indexOf(listener)
      if (i >= 0) roundPulseListeners.splice(i, 1)
      if (timer) clearTimeout(timer)
    }
  }, [])
  if (!info) return null
  return React.createElement('div', { 'data-iterate-root': '', className: 'iterate-capsule' }, info)
}

/** Settings page section (root scope; reads localStorage + latest known data). */
function SettingsPanel() {
  const [enabled, setEnabled] = React.useState(themeEnabled)
  const [copied, setCopied] = React.useState(false)

  const toggleTheme = () => {
    const next = !enabled
    setEnabled(next)
    setThemeEnabled(next)
  }

  const doCopyGuide = () => {
    const guide =
      'iterate 配置指引\n' +
      '----------------\n' +
      '目标 / 维度 / 最大轮数在项目的 iterate.config.yaml 中配置。\n' +
      '让模型修改配置：请调用 iterate_config（读）与 iterate_triage（写 known_intentional），\n' +
      '并说明你希望调整的字段（goal、dimensions、max_rounds 等）。\n'
    copyText(guide)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'settings', className: 'iterate-settings' },
    React.createElement('div', { className: 'iterate-settings-title' }, 'iterate 设置'),
    React.createElement('div', { className: 'iterate-settings-row' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, 'iterate 主题'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '启用暖琥珀配色的 iterate 专属皮肤（覆盖 dsh 默认主题令牌）。'),
      ),
      React.createElement('button', {
        className: 'iterate-btn',
        'data-primary': enabled ? '' : undefined,
        onClick: toggleTheme,
      }, enabled ? '已启用' : '已关闭'),
    ),
    React.createElement('div', { className: 'iterate-settings-row' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '分诊持久化'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '分诊面板的 y/n/a 判定保存在本地浏览器（localStorage），刷新会话后仍保留。'),
      ),
      React.createElement('span', { className: 'iterate-chip' }, '本地保存'),
    ),
    React.createElement('div', { className: 'iterate-settings-row' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '配置管理'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '目标 / 维度 / 最大轮数写在项目的 iterate.config.yaml。复制下方指引，让模型为你调整。'),
      ),
      React.createElement('button', { className: 'iterate-btn', 'data-primary': '', 'data-copied': copied ? '' : undefined, onClick: doCopyGuide }, copied ? '已复制' : '复制指引'),
    ),
  )
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Chain selector for conversation.chat.turnTail.
 * Returns a marker when the turn contains an iterate review report, null otherwise.
 */
function selectTurnTail(owner) {
  if (!owner) return null
  const raw = findReportInObject(owner.turn, undefined, 24) || scanSessionForReport(owner.turn)
  return raw ? { matched: true } : null
}

/**
 * Plugin client entry. Called by dsh web with the client Cordis context.
 */
export function apply(ctx) {
  // 1. Resolve optional services (degrade, never throw).
  const get = ctx && typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
  slotsSvc = get ? get('slots') : undefined
  themeSvc = get ? get('theme') : undefined
  React = resolveReact(ctx)
  storage = createStorage()

  // 2. Theme preference bootstrap.
  const savedTheme = storage.get(THEME_STORAGE_KEY)
  themeEnabled = savedTheme === null ? true : savedTheme === '1'
  if (themeEnabled) applyThemeSkin()

  // 3. Inject styles (independent of slots / React availability).
  if (typeof document !== 'undefined' && document.createElement && document.head) {
    const style = document.createElement('style')
    style.dataset.plugin = PLUGIN_TAG
    style.dataset.pluginCss = 'iterate-main'
    style.textContent = ITERATE_CSS
    document.head.appendChild(style)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => { try { style.remove() } catch { /* noop */ } })
    }
  }

  // 4. Slot UI requires React + slots service.
  if (React === null || slotsSvc === undefined) {
    log('React or slots service unavailable — slot UI disabled')
    return
  }

  // 5. Register the six-part UI.
  if (typeof slotsSvc.inject === 'function') {
    // 1 + 5: convergence dashboard + round pulse (session scope).
    slotsSvc.inject('conversation.input.dock', () =>
      slotsSvc.register(
        { name: 'conversation.input.dock', id: 'iterate-dashboard', order: 90 },
        (props) => React.createElement(ConvergenceDashboard, props),
      ),
    )

    // 2 + 3: triage panel / stats card (turn-tail chain, session scope).
    slotsSvc.inject('conversation.chat.turnTail', () =>
      slotsSvc.register(
        { name: 'conversation.chat.turnTail', id: 'iterate-turn-tail', select: selectTurnTail },
        (props) => React.createElement(TurnTailEntry, props),
      ),
    )

    // 5: progress capsule (frame overlay, root scope).
    slotsSvc.inject('shell.overlay', () =>
      slotsSvc.register(
        { name: 'shell.overlay', id: 'iterate-progress', order: 0 },
        (props) => React.createElement(ProgressCapsule, props),
      ),
    )

    // 6: settings page section (root scope).
    slotsSvc.inject('settings.section', () =>
      slotsSvc.register(
        { name: 'settings.section', id: 'iterate-settings', order: 30, label: () => 'iterate' },
        (props) => React.createElement(SettingsPanel, props),
      ),
    )
  }

  // 6: keep theme toggle state consistent across theme/change events.
  if (typeof ctx.on === 'function') {
    ctx.on('theme/change', () => {
      if (themeEnabled) applyThemeSkin()
    })
  }
}