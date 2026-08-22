/**
 * src/client/index.ts — iterate-plugin browser half.
 *
 * Built by `scripts/build-client.mjs` (esbuild) into `lib/client.js`, a
 * single-file artifact for the dsh web shell's GUI loader:
 *
 *   window.__ModuleLoader__.load({ id: "iterate-plugin", factory: (require) => {...} })
 *
 * The factory's injected `require` resolves externals (react and co) from the
 * shell's frozen platform module table. All local code — this module plus the
 * pure parse helpers imported from `lib/parse.js` — is bundled inline, so the
 * artifact has no relative imports at runtime. This mirrors the dsh-hooks
 * client contract exactly (see tsdown.config.ts in PeterBon/dsh-hooks).
 *
 * Module contract (same as dsh-hooks / task-board plugins):
 *   - `name`: loader id this module registers under.
 *   - `inject`: services the shell must have up before `apply` runs.
 *   - `apply(ctx)`: called by the client runtime with the ClientContext.
 *
 * Implements the §14.4 / §16 UI layer:
 *   1. Convergence dashboard  -> conversation.input.dock
 *   2. Findings triage panel   -> conversation.chat.turnTail
 *   3. Iteration stats card    -> conversation.chat.turnTail (same chain, empty-findings case)
 *   4. iterate theme skin      -> theme.overrideTokens
 *   5. Progress event linkage  -> ctx.on('slots/changed') + round-pulse + shell.overlay capsule
 *   6. Settings page section   -> settings.section
 *   7. Runtime observatory     -> conversation.input.dock (order 91, F1–F7 board)
 *
 * Design notes:
 *   - All styles are injected via one <style> tag; colors use dsh token
 *     variables (`--dsw-*`).
 *   - Defensive by design: every service lookup is optional and guarded, so a
 *     missing slot/theme degrades gracefully instead of crashing the UI.
 */

// dsh's __ModuleLoader__ provides require() to access platform modules.
// Using require() directly (not import) avoids esbuild's __toESM wrapper,
// which copies React's properties into a new object and can break internal
// bindings. Official dsh plugins (e.g. dsh-client-ui-goal) use the same pattern.
declare function require(name: string): unknown
const React = require('react') as typeof import('react')
import {
  findReportInObject,
  scanSessionForReport,
  scanSessionForRunSummary,
  extractVerdict,
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
  filterFindingsWithIndices,
  buildFilterOptions,
  countVerdicts,
  batchSetVerdict,
  setAllVerdicts,
  buildRoundHistory,
  buildFindingTrend,
  computeTrendMetrics,
  trendMax,
  buildCompletionSummary,
  buildConfigEditGuide,
  keyToVerdict,
  allVerdictKeys,
  buildRuntimeStatusGuide,
  scanSessionForResume,
  countSessionImages,
  scanSessionForTranscript,
  normalizeTranscript,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
} from '../../lib/parse.js'

// ─── Module contract ─────────────────────────────────────────────────────────

/** Loader id this client module registers under. */
export const name = 'iterate-plugin'

/** Required services: slots + theme must be up before this plugin applies. */
export const inject = ['slots', 'theme'] as const

// ─── Client context / service types ─────────────────────────────────────────

/** A single finding produced by the harness review. */
interface IterateFinding {
  [key: string]: unknown
  dimension?: string
  file?: string
  line?: number
  severity?: string
  summary?: string
  failure_scenario?: string
  suggested_fix?: string
}

/** Normalized review report consumed by the triage / dashboard components. */
interface ReviewReport {
  [key: string]: unknown
  mode?: string
  findings?: IterateFindings
  rounds?: unknown[]
  convergence?: {
    converged?: boolean
    totalRounds?: number
    findingsByRound?: number[]
    stoppedReason?: string
  }
  summary?: {
    totalFindings?: number
    critical?: number
    high?: number
    medium?: number
    low?: number
    fixedCount?: number
    byDimension?: Record<string, number>
  }
}

/** Non-null findings list (index-signature compatible). */
type IterateFindings = IterateFinding[]

/** Registration metadata handed to the slots `register` call. */
interface SlotsRegistrationMeta {
  name: string
  id: string
  order?: number
  label?: () => string
  select?: (owner: SlotProps) => { matched: boolean } | null
}

/** Client slots service (same surface dsh-hooks relies on). */
interface SlotsService {
  inject(slot: string, getLayer?: () => void): void
  register(meta: SlotsRegistrationMeta, render: (props: SlotProps) => unknown): () => void
}

/** Client theme service exposing token overrides. */
interface ThemeService {
  overrideTokens(source: string, tokens: IterateTokenMap): () => void
}

// ─── Runtime observatory (transcript) types ─────────────────────────────────
// Mirrors src/types.ts Transcript* series, but every field is defensive/optional
// so the panel never crashes on a malformed or partial manifest.

interface ObsCheckpoint {
  mode?: string
  round?: number
  maxRounds?: number
  fixedCount?: number
  resumeCount?: number
  updatedAt?: string
}

interface ObsNudge {
  timestamp?: string
  text?: string
}

interface ObsApproval {
  active?: boolean
  policy?: string
}

interface ObsThread {
  dimension?: string
  attempt?: number
  messages?: string[]
  readFiles?: string[]
  findings?: ObsFinding[]
}

interface ObsRound {
  round?: number
  threads?: ObsThread[]
}

interface ObsFinding {
  dimension?: string
  file?: string
  line?: number
  severity?: string
  summary?: string
  failure_scenario?: string
  suggested_fix?: string
  is_atomic?: boolean
  acknowledged?: boolean
}

interface ObsFix {
  id?: string
  timestamp?: string
  round?: number
  file?: string
  summary?: string
  linesAdded?: number
  linesRemoved?: number
  success?: boolean
}

interface ObsEntry {
  timestamp?: string
  round?: number
  type?: string
  data?: Record<string, unknown>
}

interface ObsManifest {
  version?: number
  project?: string
  updatedAt?: string
  active?: boolean
  mode?: string
  goal?: string
  phases?: string[]
  round?: number
  maxRounds?: number
  rounds?: ObsRound[]
  convergence?: number[]
  findings?: ObsFinding[]
  fixes?: ObsFix[]
  checkpoint?: ObsCheckpoint | null
  timeline?: ObsEntry[]
  nudge?: ObsNudge | null
  approval?: ObsApproval
}

/** Opaque slot props: heterogeneous per-slot payloads. */
type SlotProps = Record<string, unknown>

/** Token map passed to theme.overrideTokens (light + dark per dsw token). */
type IterateTokenMap = Record<string, { light: string; dark: string }>

/** Subset of the dsh client runtime context used by this plugin. */
interface ClientContext {
  slots?: SlotsService
  theme?: ThemeService
  get?(service: string, optional?: boolean): unknown
  on?(event: string, listener: (...args: unknown[]) => void): void | (() => void)
  effect?(task: () => void | (() => void), label?: string): () => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PLUGIN_TAG = 'iterate-ui'

/** localStorage key prefix for triage verdicts. */
const TRIAGE_STORAGE_PREFIX = 'iterate.triage.'

/** localStorage key for the theme skin toggle. */
const THEME_STORAGE_KEY = 'iterate.theme.enabled'

/** Theme override source name (matches the doc §16.1). */
const THEME_SOURCE = 'iterate'

/** Theme tokens: 13 dsw tokens, each with light + dark values (warm amber accent). */
const ITERATE_TOKENS: IterateTokenMap = {
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
.iterate-settings-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.iterate-settings-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; line-height: 1.5; }
.iterate-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }

/* Filter bar + batch toolbar (triage) */
.iterate-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.iterate-filter-select { padding: 4px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; }
.iterate-filter-search { padding: 4px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; min-width: 140px; }
.iterate-filter-search::placeholder { color: var(--dsw-alias-label-secondary); }
.iterate-filter-count { margin-left: auto; white-space: nowrap; }
.iterate-batch { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.iterate-batch-label { margin-right: 2px; }
.iterate-batch-btn { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.iterate-batch-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.iterate-finding[data-selected] { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: -1px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent); }

/* Trend chart (inline SVG) */
.iterate-trend { display: flex; align-items: flex-end; gap: 3px; height: 26px; padding: 2px 0; }
.iterate-trend-bar { width: 6px; border-radius: 2px 2px 0 0; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, var(--dsw-alias-bg-layer-2)); }
.iterate-trend-bar[data-hot] { background: var(--dsw-alias-brand-primary); }

/* History panel */
.iterate-history { margin: 10px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.iterate-history-body { padding: 10px 14px; }
.iterate-history-table { width: 100%; border-collapse: collapse; font-size: 11px; color: var(--dsw-alias-label-primary); }
.iterate-history-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.iterate-history-table td { padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.iterate-history-table tr:last-child td { border-bottom: none; }
.iterate-history-num { font-weight: 600; }
.iterate-history-trendline { margin-top: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.iterate-completion { margin-top: 8px; padding: 6px 10px; border-radius: 8px; font-size: 11px; }
.iterate-completion[data-ok] { border: 1px solid var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.iterate-completion[data-warn] { border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.iterate-capsule[data-ok] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.iterate-chip[data-ok] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.iterate-batch-check { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.iterate-batch-check input { margin: 0; cursor: pointer; }

/* Meta-review verdict banner (dry-run closing result) */
.iterate-verdict { margin: 10px 0; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-primary); }
.iterate-verdict-tag { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.iterate-verdict-tag[data-ok] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.iterate-verdict-tag[data-warn] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.iterate-verdict-detail { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); }
.iterate-verdict-item { white-space: nowrap; }
.iterate-verdict-item b { color: var(--dsw-alias-label-primary); font-weight: 600; }

/* Settings page redesign: grouped cards + switch + code blocks. */
.iterate-settings { display: flex; flex-direction: column; gap: 14px; padding: 6px 2px 16px; }
.iterate-scard { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
.iterate-scard-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.iterate-scard-title { font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary); letter-spacing: -0.01em; }
.iterate-scard-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.iterate-scard-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Status pill */
.iterate-pill { display: inline-flex; align-items: center; gap: 7px; padding: 3px 11px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
.iterate-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* Interruption / resume + attachment chips (dashboard) */
.iterate-chip-resume { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent); }
.iterate-chip-images { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); }

/* Accessibility-switch toggle */
.iterate-switch { position: relative; width: 42px; height: 24px; border-radius: 999px; padding: 0; cursor: pointer; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); transition: background-color 160ms ease, border-color 160ms ease; }
.iterate-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.iterate-switch-knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform 160ms ease, background-color 160ms ease; }
.iterate-switch[data-on] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.iterate-switch[data-on] .iterate-switch-knob { transform: translateX(18px); background: #FFFFFF; }

/* Shared keyboard focus ring for every iterate interactive control */
.iterate-btn:focus-visible, .iterate-vbtn:focus-visible, .iterate-batch-btn:focus-visible,
.iterate-filter-select:focus-visible, .iterate-filter-search:focus-visible,
.iterate-finding:focus-visible, .iterate-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}

/* Dashboard empty/onboarding state */
.iterate-dashboard-empty { opacity: 0.75; }
.iterate-empty-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* Convergence-completed progress fill */
.iterate-progress-fill-done { background: var(--dsw-alias-state-success-primary); }

/* Batch scope segmented control */
.iterate-batch-scope { opacity: 0.6; }
.iterate-batch-scope-on { opacity: 1; border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }

/* Overflow dimension chip */
.iterate-dim-more { opacity: 0.7; font-style: italic; }

/* Button variants */
.iterate-btn[data-ghost] { background: transparent; }
.iterate-btn[data-danger] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); background: transparent; }
.iterate-btn[data-danger]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.iterate-btn[data-confirm] { border-color: var(--dsw-alias-state-error-primary); color: #FFFFFF; background: var(--dsw-alias-state-error-primary); }

/* Collapsible guide / status code blocks */
.iterate-guide { margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
.iterate-guide-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.iterate-guide-body { padding: 12px 14px; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11.5px; line-height: 1.75; white-space: pre-wrap; color: var(--dsw-alias-label-primary); max-height: 260px; overflow: auto; }

/* ── Runtime observatory panel ──────────────────────────────────────────── */
.iterate-obs { margin: 6px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; font-size: 12px; color: var(--dsw-alias-label-primary); }
.iterate-obs-head { display: flex; align-items: center; gap: 10px; padding: 8px 14px; cursor: pointer; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.iterate-obs-head[data-closed] { border-bottom: none; }
.iterate-obs-title { font-weight: 650; }
.iterate-obs-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); font-size: 11px; font-weight: 600; white-space: nowrap; }
.iterate-obs-badge[data-live] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.iterate-obs-head-meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.iterate-obs-tabs { display: flex; gap: 4px; padding: 8px 14px 0; flex-wrap: wrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.iterate-obs-tab { padding: 4px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.iterate-obs-tab[data-active] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.iterate-obs-body { padding: 12px 14px; max-height: 460px; overflow: auto; }
.iterate-obs-block { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
.iterate-obs-block:last-child { margin-bottom: 0; }
.iterate-obs-block-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-primary); flex-wrap: wrap; }
.iterate-obs-block-head[data-click] { cursor: pointer; }
.iterate-obs-block-body { padding: 8px 10px; }
.iterate-obs-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.iterate-obs-msg { padding: 2px 0; color: var(--dsw-alias-label-secondary); line-height: 1.5; font-size: 11px; word-break: break-word; }
.iterate-obs-file { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.iterate-obs-bar { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }
.iterate-obs-bar b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.iterate-obs-mono { font-family: var(--dsw-font-mono, ui-monospace, monospace); }
.iterate-obs-code { padding: 6px 8px; margin-top: 4px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; }
.iterate-obs-input { width: 100%; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; resize: vertical; }
.iterate-obs-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.iterate-obs-input::placeholder { color: var(--dsw-alias-label-secondary); }
.iterate-obs-empty { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }
.iterate-obs-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }
.iterate-obs-row:last-child { border-bottom: none; }
`

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Namespaced logger (kept minimal; only errors/warnings, no debug spam). */
function log(...args: unknown[]): void {
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(`[${PLUGIN_TAG}]`, ...args)
  }
}

/** Safe localStorage wrapper (never throws in private mode / SSR). */
function createStorage(): {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  keys(): string[]
} {
  try {
    const testKey = '__iterate_storage_test__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return {
      get(key) { return window.localStorage.getItem(key) },
      set(key, value) { window.localStorage.setItem(key, value) },
      remove(key) { window.localStorage.removeItem(key) },
      keys() { return Object.keys(window.localStorage) },
    }
  } catch {
    const mem = new Map<string, string>()
    return {
      get(key) { return mem.has(key) ? mem.get(key) as string : null },
      set(key, value) { mem.set(key, value) },
      remove(key) { mem.delete(key) },
      keys() { return [...mem.keys()] },
    }
  }
}

/**
 * Remove every stored key with the given prefix (e.g. all triage verdicts).
 * Returns how many keys were removed.
 */
function removeStorageByPrefix(prefix: string): number {
  if (!storage) return 0
  let removed = 0
  try {
    for (const key of storage.keys()) {
      if (key.startsWith(prefix)) {
        storage.remove(key)
        removed++
      }
    }
  } catch (err) {
    log('failed to clear storage prefix', prefix, err)
  }
  return removed
}

/** Copy text to the clipboard, resolving to whether it actually succeeded. */
function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    )
  }
  return Promise.resolve(false)
}

/** Literal severity keys recognized by SEVERITY_LABEL / SEVERITY_COLOR. */
const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const

/** Coerce an arbitrary severity string to a known key, defaulting to `low`. */
function coerceSeverity(severity: string | undefined): (typeof SEVERITY_KEYS)[number] {
  return (SEVERITY_KEYS as readonly string[]).includes(severity ?? '')
    ? (severity as (typeof SEVERITY_KEYS)[number])
    : 'low'
}

/** Severity accent color with safe fallback. */
function severityColor(severity: string | undefined): string {
  return SEVERITY_COLOR[coerceSeverity(severity)]
}

/** Severity short label with safe fallback. */
function severityLabel(severity: string | undefined): string {
  return SEVERITY_LABEL[coerceSeverity(severity)]
}

/** Resolve the slots service: prefer the typed `ctx.slots`, fall back to `ctx.get`. */
function readSlots(ctx: ClientContext): SlotsService | undefined {
  if (ctx && ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
    return ctx.slots
  }
  const raw = ctx && typeof ctx.get === 'function' ? ctx.get('slots', false) : undefined
  if (raw && typeof (raw as SlotsService).inject === 'function' && typeof (raw as SlotsService).register === 'function') {
    return raw as SlotsService
  }
  return undefined
}

/** Resolve the theme service: prefer the typed `ctx.theme`, fall back to `ctx.get`. */
function readTheme(ctx: ClientContext): ThemeService | undefined {
  if (ctx && ctx.theme && typeof ctx.theme.overrideTokens === 'function') {
    return ctx.theme
  }
  const raw = ctx && typeof ctx.get === 'function' ? ctx.get('theme', false) : undefined
  if (raw && typeof (raw as ThemeService).overrideTokens === 'function') {
    return raw as ThemeService
  }
  return undefined
}

// ─── Module-level runtime state (shared across slots) ────────────────────────

let slotsSvc: SlotsService | undefined = undefined
let themeSvc: ThemeService | undefined = undefined
let storage: ReturnType<typeof createStorage> | null = null
let themeDisposer: (() => void) | null = null
let themeEnabled = true
const roundPulseListeners: Array<(payload: { round: number; converged: boolean }) => void> = []

/**
 * Emit a "round changed" pulse to subscribed components.
 * The payload is `{ round, converged }` so the overlay capsule can surface
 * completion AND convergence in one notification.
 */
function emitRoundPulse(round: number, converged: boolean): void {
  const payload = { round, converged: converged === true }
  for (const fn of roundPulseListeners.slice()) fn(payload)
}

/** Apply the iterate theme skin (idempotent). */
function applyThemeSkin(): void {
  if (!themeSvc || typeof themeSvc.overrideTokens !== 'function') return
  // Never stack disposers: drop any previously applied override first.
  clearThemeSkin()
  themeDisposer = themeSvc.overrideTokens(THEME_SOURCE, ITERATE_TOKENS)
}

/** Remove the iterate theme skin (idempotent). */
function clearThemeSkin(): void {
  if (themeDisposer) {
    try { themeDisposer() } catch (err) { log('theme disposer failed', err) }
    themeDisposer = null
  }
}

/** Persist + apply the theme preference. */
function setThemeEnabled(enabled: boolean): void {
  themeEnabled = enabled
  if (storage) storage.set(THEME_STORAGE_KEY, enabled ? '1' : '0')
  if (enabled) applyThemeSkin()
  else clearThemeSkin()
}

// ─── Components (React.createElement trees) ──────────────────────────────────

/** Find the latest report inside a session snapshot (normalized). */
function latestReport(session: unknown): ReviewReport | null {
  if (!session) return null
  const raw = scanSessionForReport(session) || findReportInObject(session, undefined, 24)
  return raw ? normalizeReport(raw) as ReviewReport : null
}

/** Inline bar chart of findings-by-round (pure divs, no SVG needed). */
function TrendChart({ points }: { points: Array<{ round: number; count: number }> }) {
  if (!points || points.length === 0) return null
  const max = trendMax(points)
  const bars = points.map((p) =>
    React.createElement('div', {
      key: p.round,
      className: 'iterate-trend-bar',
      'data-hot': p.count > 0 ? '' : undefined,
      title: `Round ${p.round}：${p.count} 项`,
      style: { height: `${Math.max(4, Math.round((p.count / max) * 24))}px` },
    }),
  )
  // Accessible summary: the per-round counts are otherwise invisible to
  // assistive tech (mouse-only title divs).
  const summary = points.map((p) => `Round ${p.round}: ${p.count}`).join(', ')
  return React.createElement('div', {
    className: 'iterate-trend',
    role: 'img',
    'aria-label': `各轮发现数量趋势：${summary}`,
  }, ...bars)
}

/** Dashboard: live convergence strip above the composer.
 *
 * The `conversation.input.dock` slot's owner share is `InputZone`, which
 * provides `session` as a point-in-time ConversationSnapshot directly — no
 * subscription needed. Per the slot contract: "Read only `session`/`input`
 * off the owner share — both are point-in-time snapshots re-rendered for
 * you, never subscribe."
 */
function ConvergenceDashboard(props: SlotProps) {
  const [pulseKey, setPulseKey] = React.useState(0)
  // The `conversation.input.dock` slot owner share (InputZone) provides
  // `session` as a point-in-time snapshot — read it directly, never subscribe.
  const session = props && props.session ? props.session : null
  const report = latestReport(session)

  React.useEffect(() => {
    if (!report) return
    const cur = getCurrentRound(report)
    const conv = report.convergence
    emitRoundPulse(cur, conv?.converged === true)
    setPulseKey((k) => k + 1)
  }, [report && hashReport(report) + ':' + getCurrentRound(report)])

  if (!report) {
    // Empty/onboarding state: first-time users otherwise see nothing and have
    // no idea the plugin exists or how to start.
    return React.createElement(
      'div',
      { 'data-iterate-root': '', 'data-iterate': 'dashboard', className: 'iterate-dashboard iterate-dashboard-empty' },
      React.createElement('span', { className: 'iterate-round-badge' }, 'iterate'),
      React.createElement('span', { className: 'iterate-empty-hint' }, '运行一次评审后，这里会显示收敛进度与发现统计。试试「review this project」或「/iterate review-only」'),
    )
  }

  const round = getCurrentRound(report)
  const total = getTotalRounds(report)
  const progress = computeConvergenceProgress(report)
  const stats = severityStats(report)
  const dims = groupByDimension(report)
  const trend = computeTrendMetrics(report)

  // Interruption / resume awareness: a decision-log `resume` entry in the
  // session means this run continued from an interrupted checkpoint.
  const resumeCount = scanSessionForResume(session)
  const imageCount = countSessionImages(session)
  const resumeChip = resumeCount > 0
    ? React.createElement('span', {
        className: 'iterate-chip-resume',
        key: 'resume',
        title: '本次迭代从上一次中断的断点继续执行',
      }, `已中断恢复 ×${String(resumeCount)}`)
    : null
  const imageChip = imageCount > 0
    ? React.createElement('span', {
        className: 'iterate-chip-images',
        key: 'images',
        title: '会话中检测到用户附带的图片，评审将作为视觉证据参考',
      }, `附件图片 ${String(imageCount)}`)
    : null

  const dimNames = Object.keys(dims)
  const dimBadges = dimNames.slice(0, 6).map((dim) =>
    React.createElement(
      'span',
      { key: dim, className: 'iterate-dim-badge' },
      `${dim} · ${(dims[dim]?.length ?? 0)}`,
    ),
  )
  // Don't silently drop dimensions: surface the overflow as a +N chip.
  const overflow = dimNames.length - 6
  if (overflow > 0) {
    dimBadges.push(
      React.createElement(
        'span',
        { key: '+more', className: 'iterate-dim-badge iterate-dim-more', title: dimNames.slice(6).join(', ') },
        `+${overflow} 更多`,
      ),
    )
  }

  // Fix-count badge: show a running "fixes applied" metric when the report
  // carries a number (normal mode only — threaded through `fixedCount`).
  const mode = report.mode
  const summary = report.summary
  const isNormal = mode === 'normal'
  const fixCount = isNormal && summary && typeof summary.fixedCount === 'number' ? summary.fixedCount : null
  const fixBadge = fixCount !== null
    ? React.createElement('span', {
        className: 'iterate-metric',
        key: 'fixes',
        title: '本轮已应用的原子修复数（正常模式）',
      }, `${String(fixCount)} fixes`)
    : null

  // Convergence is the payoff of the review — make it visible on the
  // persistent dashboard, not only in the transient 3.6s capsule.
  const converged = report.convergence && report.convergence.converged === true
  const convChip = converged
    ? React.createElement('span', {
        className: 'iterate-chip-resume',
        key: 'converged',
        title: '审查已收敛：最后一轮未发现新问题',
      }, '✓ 已收敛')
    : null

  const sevMetric = (key: 'critical' | 'high' | 'medium' | 'low', label: string) =>
    React.createElement('span', { className: 'iterate-metric', key, title: label },
      React.createElement('span', { className: 'iterate-sev-dot', style: { background: SEVERITY_COLOR[key] } }),
      `${label} ${String(stats[key])}`,
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
      React.createElement('div', {
        className: converged ? 'iterate-progress-fill iterate-progress-fill-done' : 'iterate-progress-fill',
        style: { width: `${progress}%` },
      }),
    ),
    convChip,
    sevMetric('critical', 'CRIT'),
    sevMetric('high', 'HIGH'),
    sevMetric('medium', 'MED'),
    sevMetric('low', 'LOW'),
    fixBadge,
    resumeChip,
    imageChip,
    React.createElement(TrendChart, { points: trend.points }),
    ...dimBadges,
  )
}

/** Stats card (empty-findings case of the turn-tail chain). */
function StatsCard(props: SlotProps) {
  const report = props.report as ReviewReport
  const [showHistory, setShowHistory] = React.useState(false)
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

  const history = buildRoundHistory(report)
  const trend = computeTrendMetrics(report)
  const historyRows = history.map((h) =>
    React.createElement('tr', { key: h.round },
      React.createElement('td', { className: 'iterate-history-num' }, `Round ${h.round}`),
      React.createElement('td', {}, String(h.count)),
      React.createElement('td', { style: { color: SEVERITY_COLOR.critical } }, String(h.critical)),
      React.createElement('td', { style: { color: SEVERITY_COLOR.high } }, String(h.high)),
      React.createElement('td', { style: { color: SEVERITY_COLOR.medium } }, String(h.medium)),
      React.createElement('td', { style: { color: SEVERITY_COLOR.low } }, String(h.low)),
    ),
  )
  const trendLine = `首轮 ${trend.firstRound} → 末轮 ${trend.lastRound} 项，降幅 ${trend.reductionPercent}%${trend.converged ? '，已收敛' : ''}`
  const completion = buildCompletionSummary(report)

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'stats', className: 'iterate-stats' },
    React.createElement('div', { className: 'iterate-triage-head' },
      React.createElement('span', {}, 'Iterate · 收敛统计'),
      React.createElement('span', { className: 'iterate-triage-hint' },
        `Round ${getCurrentRound(report)}/${getTotalRounds(report)} · ${total} findings · ${report.convergence && report.convergence.converged ? '已收敛' : '未收敛'}`,
      ),
    ),
    React.createElement('div', { className: 'iterate-stats-grid' }, ...rows),
    React.createElement('div', { className: 'iterate-completion', 'data-ok': trend.converged ? '' : undefined, 'data-warn': trend.converged ? undefined : '' }, completion),
    React.createElement('div', { className: 'iterate-triage-foot', style: { marginTop: 8, borderRadius: 8 } },
      React.createElement('span', {}, trendLine),
      React.createElement('button', {
        className: 'iterate-btn',
        'data-primary': showHistory ? '' : undefined,
        onClick: () => setShowHistory((v) => !v),
      }, showHistory ? '收起历史' : '历史 / 趋势'),
    ),
    showHistory
      ? React.createElement('div', { className: 'iterate-history-body' },
          React.createElement('table', { className: 'iterate-history-table' },
            React.createElement('thead', {},
              React.createElement('tr', {},
                React.createElement('th', {}, '轮次'),
                React.createElement('th', {}, '发现'),
                React.createElement('th', { style: { color: SEVERITY_COLOR.critical } }, 'CRIT'),
                React.createElement('th', { style: { color: SEVERITY_COLOR.high } }, 'HIGH'),
                React.createElement('th', { style: { color: SEVERITY_COLOR.medium } }, 'MED'),
                React.createElement('th', { style: { color: SEVERITY_COLOR.low } }, 'LOW'),
              ),
            ),
            React.createElement('tbody', {}, ...historyRows),
          ),
          React.createElement('div', { className: 'iterate-history-trendline' },
            React.createElement(TrendChart, { points: trend.points }),
          ),
        )
      : null,
  )
}

/** Triage panel: per-finding y / n / a with filters, batch ops, keyboard shortcuts. */
function TriagePanel(props: SlotProps) {
  const report = props.report as ReviewReport
  const findings = report.findings || []
  const storageKey = TRIAGE_STORAGE_PREFIX + hashReport(report)
  const [verdicts, setVerdicts] = React.useState<Record<string, 'keep' | 'skip' | 'ignore'>>(() => {
    const initial = buildTriageState(report)
    const saved = storage ? storage.get(storageKey) : null
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, string>
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(initial)) {
            if (parsed[key] === 'keep' || parsed[key] === 'skip' || parsed[key] === 'ignore') {
              initial[key] = parsed[key] as 'keep' | 'skip' | 'ignore'
            }
          }
        }
      } catch { /* corrupt storage, fall back to defaults */ }
    }
    return initial
  })
  const [payload, setPayload] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [filter, setFilter] = React.useState<{ severities: string[]; dimensions: string[]; search: string }>({ severities: [], dimensions: [], search: '' })
  const [selected, setSelected] = React.useState<number | null>(null)
  const [selectAll, setSelectAll] = React.useState(false)

  /** Persist the verdicts to localStorage whenever they change. Kept OUT of
   *  the state updater (updaters must stay pure — React may double-invoke them
   *  under StrictMode, and a storage throw must not surface during render). */
  React.useEffect(() => {
    if (storage) storage.set(storageKey, JSON.stringify(verdicts))
  }, [storageKey, verdicts])

  const setVerdict = (index: number, verdict: 'keep' | 'skip' | 'ignore') => {
    setVerdicts((prev) => ({ ...prev, [String(index)]: verdict }))
  }

  // ── Filtering (visible findings + their original indices) ───────────────
  const { filtered, indices } = filterFindingsWithIndices(findings, filter)
  const indicesKey = indices.join(',')
  const options = buildFilterOptions(findings)
  const isFilterActive = filter.severities.length > 0 || filter.dimensions.length > 0 || filter.search !== ''

  const setSeverityFilter = (value: string) => setFilter((f) => ({ ...f, severities: value ? [value] : [] }))
  const setDimensionFilter = (value: string) => setFilter((f) => ({ ...f, dimensions: value ? [value] : [] }))
  const setSearchFilter = (value: string) => setFilter((f) => ({ ...f, search: value }))
  const clearFilter = () => setFilter({ severities: [], dimensions: [], search: '' })

  // ── Batch operations (apply to the currently VISIBLE findings, or to ALL
  //    findings when the select-all toggle is on) ──────────────────────────
  const allIndices = allVerdictKeys(verdicts)
  const batchTarget = selectAll ? allIndices : indices
  const applyBatch = (verdict: 'keep' | 'skip' | 'ignore') => {
    setVerdicts((prev) => batchSetVerdict(prev, batchTarget, verdict))
  }
  const doResetVerdicts = () => {
    setVerdicts((prev) => setAllVerdicts(prev, 'keep'))
    setSelectAll(false)
  }

  // ── Keyboard shortcuts (y / n / a on the selected finding, ↑/↓ to move) ──
  React.useEffect(() => {
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return
    const onKeyDown = (ev: KeyboardEvent) => {
      // Never hijack modified shortcuts (Cmd/Ctrl/Alt combos like Cmd+A
      // select-all) or keystrokes typed into an editable surface (the composer
      // may be a contenteditable div, not a textarea).
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const t = ev.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (t && typeof t.isContentEditable === 'boolean' && t.isContentEditable) return
      const verdict = keyToVerdict(ev.key)
      if (verdict && selected !== null && indices.includes(selected)) {
        ev.preventDefault()
        setVerdict(selected, verdict)
        const pos = indices.indexOf(selected)
        const nextIdx = indices[pos + 1]
        if (nextIdx !== undefined) setSelected(nextIdx)
        return
      }
      if (ev.key === 'ArrowDown' && indices.length > 0) {
        ev.preventDefault()
        const pos = selected === null ? -1 : indices.indexOf(selected)
        setSelected(indices[Math.min(pos + 1, indices.length - 1)] ?? null)
        return
      }
      if (ev.key === 'ArrowUp' && indices.length > 0) {
        ev.preventDefault()
        const pos = selected === null ? 0 : indices.indexOf(selected)
        setSelected(indices[Math.max(pos - 1, 0)] ?? null)
      }
    }
    doc.addEventListener('keydown', onKeyDown)
    return () => doc.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, indicesKey])

  const ignored = collectIgnoredEntries(verdicts, findings)
  const ignoredCount = ignored.length
  const counts = countVerdicts(verdicts)

  const doCopyYaml = () => {
    const yaml = toKnownIntentionalYaml(ignored)
    if (!yaml) return
    copyText(yaml).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      } else {
        // Copy failed (permissions/unsupported) — reveal the payload as a
        // manual-copy fallback instead of claiming success.
        setPayload(yaml)
      }
    })
  }

  const doBuildInstruction = () => {
    const text = buildApplyInstruction(ignored)
    setPayload(text)
    if (text) copyText(text)
  }

  const rows = (filtered as IterateFinding[]).map((finding, i) => {
    const index = indices[i] as number
    const severity = finding.severity || 'low'
    const verdict = verdicts[String(index)] || 'keep'
    const isSelected = selected === index
    const btn = (label: string, value: 'keep' | 'skip' | 'ignore', title: string) =>
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

    return React.createElement('div', {
      key: String(index),
      className: 'iterate-finding',
      'data-selected': isSelected ? '' : undefined,
      role: 'option',
      'aria-selected': isSelected,
      tabIndex: 0,
      onClick: () => setSelected(index),
      onFocus: () => setSelected(index),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(index) }
      },
    },
      React.createElement('div', { className: 'iterate-finding-meta' },
        React.createElement('span', { className: 'iterate-sev-dot', style: { background: severityColor(severity) } }),
        React.createElement('span', {}, severityLabel(severity)),
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
      React.createElement('span', { role: 'heading', 'aria-level': 3 }, `Iterate · Findings 分诊 (${filtered.length}/${findings.length})`),
      React.createElement('span', { className: 'iterate-triage-hint' }, 'y=修复 · n=跳过 · a=已知有意 · ↑/↓ 选择'),
    ),
    React.createElement('div', { className: 'iterate-filter' },
      React.createElement('select', { className: 'iterate-filter-select', value: filter.severities[0] || '', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setSeverityFilter(e.target.value), 'aria-label': '按严重度筛选' },
        React.createElement('option', { value: '' }, '全部严重度'),
        ...options.severities.map((s) =>
          React.createElement('option', { key: s.value, value: s.value }, `${severityLabel(s.value)} (${s.count})`),
        ),
      ),
      React.createElement('select', { className: 'iterate-filter-select', value: filter.dimensions[0] || '', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDimensionFilter(e.target.value), 'aria-label': '按维度筛选' },
        React.createElement('option', { value: '' }, '全部维度'),
        ...options.dimensions.map((d) =>
          React.createElement('option', { key: d.value, value: d.value }, `${d.value} (${d.count})`),
        ),
      ),
      React.createElement('input', {
        className: 'iterate-filter-search',
        type: 'search',
        placeholder: '搜索文件 / 摘要…',
        'aria-label': '搜索文件或摘要',
        value: filter.search,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearchFilter(e.target.value),
      }),
      React.createElement('span', { className: 'iterate-filter-count' },
        isFilterActive
          ? React.createElement('button', { className: 'iterate-batch-btn', onClick: clearFilter }, `清除筛选（显示 ${filtered.length}）`)
          : `共 ${findings.length} 项`,
      ),
    ),
    React.createElement('div', { className: 'iterate-batch' },
      React.createElement('span', { className: 'iterate-batch-label' }, '批量作用于：'),
      React.createElement('button', {
        className: selectAll ? 'iterate-batch-btn iterate-batch-scope' : 'iterate-batch-btn iterate-batch-scope iterate-batch-scope-on',
        onClick: () => setSelectAll(false),
        title: '批量按钮仅作用于当前筛选可见的 findings',
      }, `可见 ${indices.length}`),
      React.createElement('button', {
        className: selectAll ? 'iterate-batch-btn iterate-batch-scope iterate-batch-scope-on' : 'iterate-batch-btn iterate-batch-scope',
        onClick: () => setSelectAll(true),
        title: '批量按钮作用于全部 findings',
      }, `全部 ${allIndices.length}`),
      React.createElement('button', { className: 'iterate-batch-btn', onClick: () => applyBatch('keep') }, 'y'),
      React.createElement('button', { className: 'iterate-batch-btn', onClick: () => applyBatch('skip') }, 'n'),
      React.createElement('button', { className: 'iterate-batch-btn', onClick: () => applyBatch('ignore') }, 'a'),
      React.createElement('button', { className: 'iterate-batch-btn', onClick: doResetVerdicts, title: '把所有判定恢复为默认 y（修复）' }, '重置'),
    ),
    ...rows,
    React.createElement('div', { className: 'iterate-triage-foot' },
      React.createElement('span', {}, `y ${counts.keep} · n ${counts.skip} · a ${counts.ignore} · 待写回 known_intentional：${ignoredCount} 条`),
      React.createElement('span', { style: { display: 'flex', gap: 6 } },
        React.createElement('button', {
          className: 'iterate-btn', 'data-primary': '', 'data-copied': copied ? '' : undefined,
          onClick: doCopyYaml, disabled: ignoredCount === 0,
          title: ignoredCount === 0 ? '当前没有标记为「已知有意」的 finding' : '复制 known_intentional YAML',
        }, copied ? '已复制' : `复制 known_intentional${ignoredCount > 0 ? `（${ignoredCount}）` : ''}`),
        React.createElement('button', {
          className: 'iterate-btn', onClick: doBuildInstruction, disabled: ignoredCount === 0,
          title: ignoredCount === 0 ? '当前没有标记为「已知有意」的 finding' : '生成 iterate_triage 应用指令',
        }, '生成应用指令'),
      ),
    ),
    payload
      ? React.createElement('div', { className: 'iterate-payload' }, payload)
      : null,
  )
}

/** Meta-review verdict banner: surfaces the closing dry-run audit result. */
function VerdictBanner(props: SlotProps) {
  const verdict = props.verdict as { verdict?: string; totalFindings?: number; totalRounds?: number; checksRun?: number; reportIssues?: number; converged?: boolean } | null
  if (!verdict) return null
  const ok = verdict.verdict === 'approved'
  const item = (num: number | undefined, unit: string) =>
    React.createElement('span', { className: 'iterate-verdict-item' },
      React.createElement('b', {}, String(num)), ` ${unit}`)
  const phrase = (text: string) =>
    React.createElement('span', { className: 'iterate-verdict-item' }, text)
  return React.createElement(
    'div',
    { 'data-iterate-root': '', 'data-iterate': 'verdict', className: 'iterate-verdict' },
    React.createElement('span', { className: 'iterate-verdict-tag', 'data-ok': ok ? '' : undefined, 'data-warn': ok ? undefined : '' },
      ok ? '报告已批准' : '报告需修订'),
    React.createElement('span', { className: 'iterate-verdict-detail' },
      item(verdict.totalFindings, '项发现'),
      item(verdict.totalRounds, '轮'),
      item(verdict.checksRun, '项审查'),
      ok
        ? phrase('报告通过全部一致性检查')
        : item(verdict.reportIssues, '处报告缺陷'),
      phrase(verdict.converged ? '已收敛' : '未收敛'),
    ),
  )
}

/** Turn-tail chain entry: triage when findings exist, stats card otherwise. */
function TurnTailEntry(props: SlotProps) {
  const candidates: unknown[] = []
  if (props && props.turn) candidates.push(props.turn)
  if (props && props.matched) candidates.push(props.matched)
  if (props && props.data) candidates.push(props.data)
  candidates.push(props)

  // Meta-review verdict (dry-run closing result), found before the report.
  let verdict: { verdict?: string; totalFindings?: number; totalRounds?: number; checksRun?: number; reportIssues?: number; converged?: boolean } | null = null
  for (const c of candidates) {
    const run = scanSessionForRunSummary(c)
    if (run) { verdict = extractVerdict(run); break }
  }

  let report: ReviewReport | null = null
  for (const c of candidates) {
    const raw = findReportInObject(c, undefined, 24) || scanSessionForReport(c)
    if (raw) { report = normalizeReport(raw) as ReviewReport; break }
  }

  const blocks: React.ReactElement[] = []
  if (verdict) blocks.push(React.createElement(VerdictBanner, { key: 'verdict', verdict }))
  if (report) {
    // Render through React.createElement so each panel is a real component with
    // its own hook identity (calling them as functions would violate the Rules
    // of Hooks and crash when the findings/empty branch flips between renders).
    const panel = !report.findings || report.findings.length === 0
      ? React.createElement(StatsCard, { report })
      : React.createElement(TriagePanel, { report })
    blocks.push(React.createElement('div', { key: 'report' }, panel))
  }
  if (blocks.length === 0) return null
  return React.createElement('div', { 'data-iterate-root': '', className: 'iterate-turn-tail-root' }, ...blocks)
}

/** Progress capsule: briefly surfaces round-completion (incl. convergence). */
function ProgressCapsule() {
  const [info, setInfo] = React.useState<{ text: string; ok: boolean } | null>(null)
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const listener = (payload: { round: number; converged: boolean }) => {
      const converged = payload && payload.converged === true
      const round = payload && typeof payload.round === 'number' ? payload.round : '?'
      setInfo({ text: converged ? `Round ${round} 完成 · 已收敛` : `Round ${round} 完成`, ok: converged })
      if (timer) clearTimeout(timer)
      // Converged notifications stay a bit longer.
      timer = setTimeout(() => setInfo(null), converged ? 3600 : 2400)
    }
    roundPulseListeners.push(listener)
    return () => {
      const i = roundPulseListeners.indexOf(listener)
      if (i >= 0) roundPulseListeners.splice(i, 1)
      if (timer) clearTimeout(timer)
    }
  }, [])
  if (!info) return null
  return React.createElement('div', { 'data-iterate-root': '', className: 'iterate-capsule', 'data-ok': info.ok ? '' : undefined }, info.text)
}

/** Settings page section (root scope; reads localStorage + latest known data). */
function SettingsPanel(_props: SlotProps) {
  const [enabled, setEnabled] = React.useState(themeEnabled)
  const [guideCopied, setGuideCopied] = React.useState(false)
  const [statusCopied, setStatusCopied] = React.useState(false)
  const [showGuide, setShowGuide] = React.useState(false)
  const [showStatus, setShowStatus] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [clearedInfo, setClearedInfo] = React.useState<number | null>(null)
  const guide = buildConfigEditGuide()
  const statusGuide = buildRuntimeStatusGuide()

  const toggleTheme = () => {
    const next = !enabled
    setEnabled(next)
    setThemeEnabled(next)
  }

  /** Flash a per-slot "已复制" state for the given duration. */
  const flashCopied = (slot: 'guide' | 'status') => {
    const setter = slot === 'guide' ? setGuideCopied : setStatusCopied
    setter(true)
    setTimeout(() => setter(false), 1600)
  }

  /** Copy a guide/status block; flash success only when it actually copied. */
  const doCopy = (text: string, slot: 'guide' | 'status') => {
    copyText(text).then((ok) => {
      if (ok) flashCopied(slot)
    })
  }

  /** Two-step destroy guard: first click arms, second click clears. */
  const requestClear = () => {
    if (confirming) {
      const count = removeStorageByPrefix(TRIAGE_STORAGE_PREFIX)
      setClearedInfo(count)
      setConfirming(false)
      setTimeout(() => setClearedInfo(null), 3000)
      return
    }
    setConfirming(true)
    setTimeout(() => setConfirming(false), 3000)
  }

  const clearButton = clearedInfo !== null
    ? React.createElement('button', { className: 'iterate-btn', 'data-copied': '', disabled: true }, `已清除 ${clearedInfo} 条`)
    : React.createElement('button', {
        className: 'iterate-btn',
        'data-danger': confirming ? undefined : '',
        'data-confirm': confirming ? '' : undefined,
        onClick: requestClear,
        title: confirming ? '再次点击以确认清除全部判定' : '清除所有分诊判定记录（需要二次确认）',
      }, confirming ? '确认清除？' : '清除分诊')

  const themeCard = React.createElement('div', { key: 'theme', className: 'iterate-scard' },
    React.createElement('div', { className: 'iterate-scard-head' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '迭代主题'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '启用暖琥珀配色的 iterate 专属皮肤，覆盖 dsh 默认主题令牌。'),
      ),
      React.createElement('div', { className: 'iterate-scard-actions' },
        React.createElement('span', { className: 'iterate-chip', 'data-ok': enabled ? '' : undefined }, enabled ? '已启用' : '已关闭'),
        React.createElement('button', {
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': '开关 iterate 主题',
          className: 'iterate-switch',
          'data-on': enabled ? '' : undefined,
          onClick: toggleTheme,
        }, React.createElement('span', { className: 'iterate-switch-knob' })),
      ),
    ),
  )

  const dataCard = React.createElement('div', { key: 'data', className: 'iterate-scard' },
    React.createElement('div', { className: 'iterate-scard-head' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '分诊持久化'),
        React.createElement('div', { className: 'iterate-settings-desc' }, 'y / n / a 判定保存在本地浏览器（localStorage），刷新会话后仍保留。'),
      ),
      React.createElement('div', { className: 'iterate-scard-actions' },
        React.createElement('span', { className: 'iterate-chip' }, '本地保存'),
        clearButton,
      ),
    ),
  )

  const guideCard = React.createElement('div', { key: 'guide', className: 'iterate-scard' },
    React.createElement('div', { className: 'iterate-scard-head' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '配置管理'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '目标 / 维度 / 最大轮数写在项目的 iterate.config.yaml，复制指引可让模型按需调整。'),
      ),
      React.createElement('div', { className: 'iterate-scard-actions' },
        React.createElement('button', { className: 'iterate-btn', 'data-primary': '', 'data-copied': guideCopied ? '' : undefined, onClick: () => doCopy(guide, 'guide') }, guideCopied ? '已复制' : '复制指引'),
        React.createElement('button', { className: 'iterate-btn', 'data-ghost': '', onClick: () => setShowGuide((v) => !v) }, showGuide ? '收起' : '展开'),
      ),
    ),
    showGuide
      ? React.createElement('div', { className: 'iterate-guide' },
          React.createElement('div', { className: 'iterate-guide-bar' },
            React.createElement('span', {}, 'iterate.config.yaml 可编辑字段'),
            React.createElement('button', { className: 'iterate-btn', 'data-ghost': '', onClick: () => doCopy(guide, 'guide') }, '复制'),
          ),
          React.createElement('div', { className: 'iterate-guide-body' }, guide),
        )
      : null,
  )

  const statusCard = React.createElement('div', { key: 'status', className: 'iterate-scard' },
    React.createElement('div', { className: 'iterate-scard-head' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, '状态概览'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '查看运行时产物布局与清理指引。iterate_status / iterate_history / iterate_prune 工具用于查看和管理。'),
      ),
      React.createElement('div', { className: 'iterate-scard-actions' },
        React.createElement('button', { className: 'iterate-btn', 'data-primary': '', 'data-copied': statusCopied ? '' : undefined, onClick: () => doCopy(statusGuide, 'status') }, statusCopied ? '已复制' : '复制指引'),
        React.createElement('button', { className: 'iterate-btn', 'data-ghost': '', onClick: () => setShowStatus((v) => !v) }, showStatus ? '收起' : '展开'),
      ),
    ),
    showStatus
      ? React.createElement('div', { className: 'iterate-guide' },
          React.createElement('div', { className: 'iterate-guide-bar' },
            React.createElement('span', {}, '运行时布局与清理'),
            React.createElement('button', { className: 'iterate-btn', 'data-ghost': '', onClick: () => doCopy(statusGuide, 'status') }, '复制'),
          ),
          React.createElement('div', { className: 'iterate-guide-body' }, statusGuide),
        )
      : null,
  )

  const banner = React.createElement('div', { key: 'banner', className: 'iterate-scard' },
    React.createElement('div', { className: 'iterate-scard-head' },
      React.createElement('div', {},
        React.createElement('div', { className: 'iterate-settings-title' }, 'iterate'),
        React.createElement('div', { className: 'iterate-settings-desc' }, '为每次代码评审生成 Review 报告与交互式分诊视图，专注 AI 自我审查与修正。'),
      ),
      React.createElement('span', { className: 'iterate-pill' },
        React.createElement('span', { className: 'iterate-pill-dot' }),
        '就绪',
      ),
    ),
  )

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'settings', className: 'iterate-settings' },
    React.createElement('div', { className: 'iterate-settings-title', style: { fontSize: 15, fontWeight: 700 } }, 'iterate 设置'),
    banner,
    themeCard,
    dataCard,
    guideCard,
    statusCard,
  )
}

// ─── Runtime observatory panel (F1–F7) ──────────────────────────────────────

/** Tab id → label for the observatory's seven panels. */
const OBS_TABS = [
  { key: 'f1', label: '审查线程' },
  { key: 'f2', label: '收敛趋势' },
  { key: 'f3', label: '发现定位' },
  { key: 'f4', label: '修复与回滚' },
  { key: 'f5', label: '断点恢复' },
  { key: 'f6', label: '运行控制台' },
  { key: 'f7', label: '决策时间线' },
] as const

/** Find the latest runtime-observatory manifest inside a session snapshot. */
function latestTranscript(session: unknown): ObsManifest | null {
  if (!session) return null
  const raw = scanSessionForTranscript(session)
  return raw ? normalizeTranscript(raw) as ObsManifest : null
}

/** Build a human-pasteable `iterate_fix` instruction for one finding. */
function buildObsFixInstruction(f: ObsFinding): string {
  const payload = JSON.stringify({
    file: String(f.file || ''),
    ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
    dimension: String(f.dimension || ''),
    summary: String(f.summary || ''),
    ...(f.suggested_fix ? { suggested_fix: String(f.suggested_fix) } : {}),
  }, null, 2)
  return `请调用 \`iterate_fix\` 修复以下 finding：\n\n\`\`\`json\n${payload}\n\`\`\``
}

/**
 * ObservatoryPanel: a 7-tab runtime observatory that renders the latest
 * iterate_transcript manifest found in the dsh session stream. The panel is
 * collapsed by default to a single entry row so it never re-occludes the main
 * convergence dashboard; clicking expands it into tabs. Every field read is
 * defensively guarded (optional chaining + fallbacks) so a partial/malformed
 * manifest never crashes the slot. The client cannot call harness tools
 * directly, so every action copies a paste-able instruction text instead.
 */
function ObservatoryPanel(props: SlotProps) {
  const session = props && props.session ? props.session : null
  const manifest = latestTranscript(session)

  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState('f1')
  const [expandedThreads, setExpandedThreads] = React.useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)
  const [nudgeText, setNudgeText] = React.useState('')
  const [timelineType, setTimelineType] = React.useState('')
  const [timelineSearch, setTimelineSearch] = React.useState('')

  // Single shared "copied" flash timer (reused across all copy buttons).
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  /** Copy an instruction, flashing "已复制" on the originating button only when the copy actually succeeded. */
  const copyInstruction = (key: string, text: string) => {
    if (!text) return
    copyText(text).then((ok) => {
      if (!ok) return
      setCopiedKey(key)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1600)
    })
  }

  const toggleThread = (key: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // No observable transcript yet: show a compact, collapsed header row.
  if (!manifest) {
    return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'obs', className: 'iterate-obs' },
      React.createElement('div', { className: 'iterate-obs-head', 'data-closed': '' },
        React.createElement('span', { className: 'iterate-obs-title' }, 'iterate 观测台'),
        React.createElement('span', { className: 'iterate-obs-head-meta' }, '暂无运行时观测数据'),
      ),
    )
  }

  const live = manifest.active === true
  const roundMeta = typeof manifest.round === 'number'
    ? (typeof manifest.maxRounds === 'number' ? `Round ${manifest.round}/${manifest.maxRounds}` : `Round ${manifest.round}`)
    : ''
  const headMeta = [manifest.mode || '', roundMeta, manifest.updatedAt || ''].filter(Boolean).join(' · ')

  // ── F1: review threads ─────────────────────────────────────────────────
  const threadFindingPill = (f: ObsFinding, keyBase: string) => {
    const loc = `${String(f.file || '?')}${typeof f.line === 'number' && f.line > 0 ? `:${f.line}` : ''}`
    return React.createElement('div', { key: keyBase, className: 'iterate-obs-row' },
      React.createElement('span', { className: 'iterate-sev-dot', style: { background: severityColor(f.severity) } }),
      React.createElement('span', {}, severityLabel(f.severity)),
      React.createElement('span', { className: 'iterate-obs-file' }, loc),
      React.createElement('span', {}, String(f.dimension || '')),
      React.createElement('span', { className: 'iterate-obs-msg' }, String(f.summary || '')),
    )
  }

  const renderThreads = () => {
    const rounds = manifest.rounds || []
    if (rounds.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无审查线程')
    }
    return React.createElement('div', {}, ...rounds.map((r, ri) => {
      const threads = r.threads || []
      const fCount = threads.reduce((sum, t) => sum + (t.findings ? t.findings.length : 0), 0)
      const threadBlocks = threads.length === 0
        ? [React.createElement('div', { key: 'none', className: 'iterate-obs-empty' }, '本轮无线程')]
        : threads.map((t, ti) => {
            const key = `${ri}-${ti}`
            const expanded = expandedThreads.has(key)
            const dim = t.dimension || '未命名维度'
            const tFindings = t.findings || []
            const files = t.readFiles || []
            const msgs = t.messages || []
            return React.createElement('div', { key, className: 'iterate-obs-block' },
              React.createElement('div', { className: 'iterate-obs-block-head', 'data-click': '', onClick: () => toggleThread(key), title: expanded ? '收起线程' : '展开线程' },
                React.createElement('span', {}, expanded ? '−' : '+'),
                React.createElement('b', {}, dim),
                React.createElement('span', { className: 'iterate-obs-chip' }, `attempt ${typeof t.attempt === 'number' ? t.attempt : '?'}`),
                React.createElement('span', { className: 'iterate-obs-chip' }, `${tFindings.length} findings`),
              ),
              expanded
                ? React.createElement('div', { className: 'iterate-obs-block-body' },
                    React.createElement('div', { className: 'iterate-obs-bar' },
                      React.createElement('b', {}, '叙述'),
                      React.createElement('span', { className: 'iterate-obs-head-meta' }, `${msgs.length} 条`),
                    ),
                    ...(msgs.length === 0
                      ? [React.createElement('div', { key: 'msg-none', className: 'iterate-obs-empty' }, '无线索叙述')]
                      : msgs.map((m, mi) => React.createElement('div', { key: mi, className: 'iterate-obs-msg' }, String(m)))),
                    ...(files.length > 0
                      ? [
                          React.createElement('div', { key: 'files-h', className: 'iterate-obs-bar', style: { marginTop: 6 } },
                            React.createElement('b', {}, '读取文件'),
                          ),
                          ...files.map((f, fi) =>
                            React.createElement('div', { key: `f${fi}`, className: 'iterate-obs-file' }, String(f)),
                          ),
                        ]
                      : []),
                    React.createElement('div', { className: 'iterate-obs-bar', style: { marginTop: 6 } },
                      React.createElement('b', {}, '发现'),
                    ),
                    ...(tFindings.length === 0
                      ? [React.createElement('div', { key: 'finding-none', className: 'iterate-obs-empty' }, '本线程无发现')]
                      : tFindings.map((f, fi) => threadFindingPill(f, `tf${fi}`))),
                  )
                : null,
            )
          })
      return React.createElement('div', { key: ri, className: 'iterate-obs-block' },
        React.createElement('div', { className: 'iterate-obs-block-head' },
          React.createElement('b', {}, `Round ${typeof r.round === 'number' ? r.round : ri + 1}`),
          React.createElement('span', { className: 'iterate-obs-chip' }, `${threads.length} 线程`),
          React.createElement('span', { className: 'iterate-obs-head-meta' }, `${fCount} findings`),
        ),
        React.createElement('div', { className: 'iterate-obs-block-body' }, ...threadBlocks),
      )
    }))
  }

  // ── F2: convergence trend (inline bars, reusing TrendChart) ─────────────
  const renderTrend = () => {
    const conv = manifest.convergence || []
    if (conv.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无收敛数据')
    }
    const points = conv.map((n, i) => ({ round: i + 1, count: n }))
    return React.createElement('div', {},
      React.createElement(TrendChart, { points }),
      React.createElement('div', { className: 'iterate-obs-bar', style: { marginTop: 6 } },
        `各轮发现数量：${conv.join(' → ')}${typeof manifest.round === 'number' ? ` · 当前 Round ${manifest.round}` : ''}`,
      ),
    )
  }

  // ── F3: finding location + action copy buttons ─────────────────────────
  const renderFindings = () => {
    const findings = manifest.findings || []
    if (findings.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无发现')
    }
    return React.createElement('div', {}, ...findings.map((f, i) => {
      const k = `f3-${i}`
      const loc = `${String(f.file || '?')}${typeof f.line === 'number' && f.line > 0 ? `:${f.line}` : ''}`
      const entry = {
        file: String(f.file || ''),
        ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
        dimension: String(f.dimension || ''),
        reason: String(f.summary || ''),
      }
      const knownInstruction = buildApplyInstruction([entry])
      const fixInstruction = buildObsFixInstruction(f)
      return React.createElement('div', { key: k, className: 'iterate-obs-block' },
        React.createElement('div', { className: 'iterate-obs-block-head' },
          React.createElement('span', { className: 'iterate-sev-dot', style: { background: severityColor(f.severity) } }),
          React.createElement('span', {}, severityLabel(f.severity)),
          React.createElement('span', { className: 'iterate-obs-file' }, loc),
          React.createElement('span', {}, String(f.dimension || '')),
          f.acknowledged === true
            ? React.createElement('span', { className: 'iterate-obs-chip' }, '已确认')
            : null,
        ),
        React.createElement('div', { className: 'iterate-obs-block-body' },
          React.createElement('div', { className: 'iterate-obs-msg' }, String(f.summary || '')),
          React.createElement('div', { className: 'iterate-obs-bar', style: { marginTop: 8 } },
            React.createElement('button', {
              className: 'iterate-btn', 'data-copied': copiedKey === `${k}-fix` ? '' : undefined,
              onClick: () => copyInstruction(`${k}-fix`, String(f.suggested_fix || '')),
              title: '复制该 finding 的建议修复文本',
            }, copiedKey === `${k}-fix` ? '已复制' : '复制 suggested_fix'),
            React.createElement('button', {
              className: 'iterate-btn', 'data-copied': copiedKey === `${k}-known` ? '' : undefined,
              onClick: () => copyInstruction(`${k}-known`, knownInstruction),
              title: '复制 iterate_triage 指令文本（标记为 known_intentional）',
            }, copiedKey === `${k}-known` ? '已复制' : 'known_intentional'),
            React.createElement('button', {
              className: 'iterate-btn', 'data-primary': '', 'data-copied': copiedKey === `${k}-repair` ? '' : undefined,
              onClick: () => copyInstruction(`${k}-repair`, fixInstruction),
              title: '复制 iterate_fix 指令文本',
            }, copiedKey === `${k}-repair` ? '已复制' : '复制修复指令'),
          ),
        ),
      )
    }))
  }

  // ── F4: fixes + rollback ───────────────────────────────────────────────
  const renderFixes = () => {
    const fixes = manifest.fixes || []
    if (fixes.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无修复记录')
    }
    return React.createElement('div', {}, ...fixes.map((f, i) => {
      const k = `f4-${i}`
      const id = String(f.id || `fix#${i + 1}`)
      const rollbackText = `请调用 \`iterate_rollback\` 回滚以下修复：\n\n\`\`\`json\n${JSON.stringify({ id }, null, 2)}\n\`\`\``
      const added = typeof f.linesAdded === 'number' ? f.linesAdded : 0
      const removed = typeof f.linesRemoved === 'number' ? f.linesRemoved : 0
      return React.createElement('div', { key: k, className: 'iterate-obs-block' },
        React.createElement('div', { className: 'iterate-obs-block-head' },
          React.createElement('b', {}, id),
          React.createElement('span', { className: 'iterate-obs-file' }, String(f.file || '?')),
          React.createElement('span', { className: 'iterate-obs-chip' }, f.success === true ? '成功' : '失败'),
          typeof f.round === 'number'
            ? React.createElement('span', { className: 'iterate-obs-head-meta' }, `Round ${f.round}`)
            : null,
        ),
        React.createElement('div', { className: 'iterate-obs-block-body' },
          React.createElement('div', { className: 'iterate-obs-msg' }, String(f.summary || '')),
          React.createElement('div', { className: 'iterate-obs-bar', style: { marginTop: 8 } },
            React.createElement('span', { className: 'iterate-obs-chip' }, `+${added}`),
            React.createElement('span', { className: 'iterate-obs-chip' }, `−${removed}`),
            React.createElement('button', {
              className: 'iterate-btn', 'data-danger': '', 'data-copied': copiedKey === `${k}-rb` ? '' : undefined,
              onClick: () => copyInstruction(`${k}-rb`, rollbackText),
              title: '复制 iterate_rollback 指令文本',
            }, copiedKey === `${k}-rb` ? '已复制' : '回滚'),
          ),
        ),
      )
    }))
  }

  // ── F5: checkpoint resume ──────────────────────────────────────────────
  const renderCheckpoint = () => {
    const cp = manifest.checkpoint
    if (!cp) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无断点')
    }
    const resumeText = `请调用 \`iterate_checkpoint\` 从断点恢复迭代：\n\n\`\`\`json\n${JSON.stringify({
      operation: 'resume',
      mode: String(cp.mode || 'normal'),
      maxRounds: typeof cp.maxRounds === 'number' ? cp.maxRounds : null,
    }, null, 2)}\n\`\`\``
    const item = (label: string, value: unknown) =>
      React.createElement('span', { className: 'iterate-obs-chip' }, `${label} ${String(value ?? '?')}`)
    return React.createElement('div', { className: 'iterate-obs-block' },
      React.createElement('div', { className: 'iterate-obs-block-head' },
        React.createElement('b', {}, '断点'),
        React.createElement('span', { className: 'iterate-obs-head-meta' }, String(cp.updatedAt || '')),
      ),
      React.createElement('div', { className: 'iterate-obs-block-body' },
        React.createElement('div', { className: 'iterate-obs-bar', style: { marginBottom: 8 } },
          item('mode', cp.mode || 'normal'),
          item('round', cp.round),
          item('maxRounds', cp.maxRounds),
          item('fixed', cp.fixedCount),
          item('resume', cp.resumeCount),
        ),
        React.createElement('button', {
          className: 'iterate-btn', 'data-primary': '', 'data-copied': copiedKey === 'cp-resume' ? '' : undefined,
          onClick: () => copyInstruction('cp-resume', resumeText),
          title: '复制 iterate_checkpoint 综/恢复指令文本',
        }, copiedKey === 'cp-resume' ? '已复制' : '复制恢复指令'),
      ),
    )
  }

  // ── F6: run console (status / approval / nudge draft) ──────────────────
  const renderConsole = () => {
    const approval = manifest.approval || { policy: 'ask' }
    const policyLabelMap: Record<string, string> = { ask: '询问用户', deny: '拒绝', allow: '直接执行' }
    const policyLabel = policyLabelMap[String(approval.policy || 'ask')] || String(approval.policy || 'ask')
    const nudge = manifest.nudge || null
    const present = Boolean(nudge && nudge.text)
    const activeNudgeText = nudge && nudge.text ? nudge.text : ''
    const nudgeInstruction = `请调用 \`iterate_transcript\` 写入 nudge 指令：\n\n\`\`\`json\n${JSON.stringify({ operation: 'nudge', text: nudgeText }, null, 2)}\n\`\`\``
    return React.createElement('div', { className: 'iterate-obs-block' },
      React.createElement('div', { className: 'iterate-obs-block-head' },
        React.createElement('span', {}, '运行控制台'),
        React.createElement('span', { className: 'iterate-obs-badge', 'data-live': live ? '' : undefined }, live ? '运行中' : '已结束'),
        React.createElement('span', { className: 'iterate-obs-head-meta' }, `批准策略：${policyLabel}`),
      ),
      React.createElement('div', { className: 'iterate-obs-block-body' },
        present
          ? React.createElement('div', { className: 'iterate-obs-bar', style: { marginBottom: 6 } },
              React.createElement('b', {}, '当前 nudge'),
              React.createElement('span', { className: 'iterate-obs-msg' }, activeNudgeText),
              React.createElement('button', { className: 'iterate-btn', onClick: () => setNudgeText('') }, '清除'),
            )
          : null,
        React.createElement('textarea', {
          className: 'iterate-obs-input iterate-obs-mono',
          rows: 3,
          placeholder: '起草一条 nudge 方向指令…',
          value: nudgeText,
          'aria-label': 'nudge 草稿',
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setNudgeText(e.target.value),
        }),
        React.createElement('div', { className: 'iterate-obs-bar', style: { marginTop: 6 } },
          React.createElement('button', {
            className: 'iterate-btn', 'data-primary': '', 'data-copied': copiedKey === 'nudge' ? '' : undefined,
            disabled: !nudgeText,
            onClick: () => copyInstruction('nudge', nudgeInstruction),
            title: '复制 iterate_transcript nudge 指令文本',
          }, copiedKey === 'nudge' ? '已复制' : '复制 nudge 指令'),
        ),
      ),
    )
  }

  // ── F7: decision timeline (type filter + search, newest first) ──────────
  const renderTimeline = () => {
    const entries = manifest.timeline || []
    if (entries.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '暂无时间线条目')
    }
    const types = Array.from(new Set(entries.map((t) => String(t.type || 'unknown')).filter(Boolean))).sort()
    const q = timelineSearch.trim().toLowerCase()
    const filtered = entries.filter((t) => {
      if (timelineType && String(t.type || '') !== timelineType) return false
      if (!q) return true
      const hay = [String(t.type || ''), String(t.round ?? ''), JSON.stringify(t.data || {})].join(' ').toLowerCase()
      return hay.indexOf(q) >= 0
    })
    // Newest first: entries are not guaranteed to be reverse ordered in the
    // manifest, so sort by timestamp string descending for a stable timeline.
    const sorted = filtered.slice().sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    const rows = sorted.map((t, i) => {
      const k = `f7-${i}`
      const dataText = t.data && typeof t.data === 'object' ? JSON.stringify(t.data) : ''
      return React.createElement('div', { key: k, className: 'iterate-obs-row', style: { flexDirection: 'column', alignItems: 'flex-start' } },
        React.createElement('div', { className: 'iterate-obs-bar', style: { width: '100%' } },
          React.createElement('span', { className: 'iterate-obs-chip' }, String(t.type || '?')),
          React.createElement('span', { className: 'iterate-obs-head-meta' },
            `${typeof t.round === 'number' ? `Round ${t.round} · ` : ''}${String(t.timestamp || '')}`,
          ),
        ),
        dataText ? React.createElement('div', { className: 'iterate-obs-code' }, dataText) : null,
      )
    })
    if (rows.length === 0) {
      return React.createElement('div', { className: 'iterate-obs-empty' }, '无匹配的时间线条目')
    }
    return React.createElement('div', {},
      React.createElement('div', { className: 'iterate-obs-bar', style: { marginBottom: 8 } },
        React.createElement('select', {
          className: 'iterate-filter-select',
          value: timelineType,
          'aria-label': '按时间线类型筛选',
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setTimelineType(e.target.value),
        },
          React.createElement('option', { value: '' }, '全部类型'),
          ...types.map((t) => React.createElement('option', { key: t, value: t }, t)),
        ),
        React.createElement('input', {
          className: 'iterate-filter-search',
          type: 'search',
          placeholder: '搜索时间线…',
          'aria-label': '搜索时间线',
          value: timelineSearch,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTimelineSearch(e.target.value),
        }),
        React.createElement('span', { className: 'iterate-filter-count' }, `${filtered.length}/${entries.length}`),
      ),
      ...rows,
    )
  }

  const renderBody = () => {
    switch (tab) {
      case 'f1': return renderThreads()
      case 'f2': return renderTrend()
      case 'f3': return renderFindings()
      case 'f4': return renderFixes()
      case 'f5': return renderCheckpoint()
      case 'f6': return renderConsole()
      case 'f7': return renderTimeline()
      default: return null
    }
  }

  return React.createElement('div', { 'data-iterate-root': '', 'data-iterate': 'obs', className: 'iterate-obs' },
    React.createElement('div', { className: 'iterate-obs-head', 'data-closed': open ? undefined : '', onClick: () => setOpen((v) => !v) },
      React.createElement('span', { className: 'iterate-obs-title' }, 'iterate 观测台'),
      React.createElement('span', { className: 'iterate-obs-badge', 'data-live': live ? '' : undefined }, live ? '运行中' : '已结束'),
      React.createElement('span', { className: 'iterate-obs-head-meta' }, headMeta || 'runtime'),
      React.createElement('button', {
        className: 'iterate-btn', 'data-ghost': '',
        onClick: (e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); setOpen((v) => !v) },
      }, open ? '收起' : '展开'),
    ),
    open
      ? React.createElement('div', {},
          React.createElement('div', { className: 'iterate-obs-tabs' },
            ...OBS_TABS.map((t) =>
              React.createElement('button', {
                key: t.key,
                className: 'iterate-obs-tab',
                'data-active': tab === t.key ? '' : undefined,
                onClick: () => setTab(t.key),
              }, t.label),
            ),
          ),
          React.createElement('div', { className: 'iterate-obs-body' }, renderBody()),
        )
      : null,
  )
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Chain selector for conversation.chat.turnTail.
 * Returns a marker when the turn contains an iterate review report, null otherwise.
 */
function selectTurnTail(owner: SlotProps): { matched: boolean } | null {
  if (!owner) return null
  if (findReportInObject(owner.turn, undefined, 24) || scanSessionForReport(owner.turn)) return { matched: true }
  if (scanSessionForRunSummary(owner.turn)) return { matched: true }
  return null
}

/**
 * Plugin client entry. Called by the dsh client runtime with its context.
 */
export function apply(ctx: ClientContext): void {
  // 1. Resolve optional services (degrade, never throw).
  slotsSvc = readSlots(ctx)
  themeSvc = readTheme(ctx)
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

  // 4. Slot UI requires the slots service.
  if (slotsSvc === undefined) {
    log('slots service unavailable — slot UI disabled')
    return
  }

  // 5. Register the six-part UI.
  if (typeof slotsSvc.inject === 'function') {
    // 1 + 5: convergence dashboard + round pulse (session scope).
    slotsSvc.inject('conversation.input.dock', () =>
      slotsSvc?.register(
        { name: 'conversation.input.dock', id: 'iterate-dashboard', order: 90 },
        (props) => React.createElement(ConvergenceDashboard, props),
      ),
    )

    // F1–F7: runtime observatory board (order 91, below the dashboard's 90 so
    // its collapsed header never occludes the main convergence dashboard).
    slotsSvc.inject('conversation.input.dock', () =>
      slotsSvc?.register(
        { name: 'conversation.input.dock', id: 'iterate-observatory', order: 91 },
        (props) => React.createElement(ObservatoryPanel, props),
      ),
    )

    // 2 + 3: triage panel / stats card (turn-tail chain, session scope).
    slotsSvc.inject('conversation.chat.turnTail', () =>
      slotsSvc?.register(
        { name: 'conversation.chat.turnTail', id: 'iterate-turn-tail', select: selectTurnTail },
        (props) => React.createElement(TurnTailEntry, props),
      ),
    )

    // 5: progress capsule (frame overlay, root scope).
    slotsSvc.inject('shell.overlay', () =>
      slotsSvc?.register(
        { name: 'shell.overlay', id: 'iterate-progress', order: 0 },
        (props) => React.createElement(ProgressCapsule, props),
      ),
    )

    // 6: settings page section (root scope).
    slotsSvc.inject('settings.section', () =>
      slotsSvc?.register(
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