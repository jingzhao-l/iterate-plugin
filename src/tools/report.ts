/**
 * src/tools/report.ts — `iterate_report` tool.
 *
 *   iterate_report — render the current iterate run into a portable report.
 *
 * Two formats, one normalized data model (shared with the client export
 * buttons via `lib/parse.js`, so the on-screen export and this tool can never
 * drift):
 *
 *   - `markdown` — a PR-pasteable run report: header (mode/round/status), the
 *                  quality-gate table, the findings table, the fixes table,
 *                  validations, defense events, and the experience bank.
 *   - `sarif`    — a SARIF 2.1.0 log so CI / GitHub Code Scanning can consume
 *                  iterate findings as code-scanning results (ruleId =
 *                  dimension, severity → error/warning/note, file+line
 *                  locations, suggested fix attached).
 *
 * Reads only local state (`.iterate/transcript.json` + the quality / experience
 * / defense stores) and writes only `.iterate/report.<ext>` when `write:true`.
 * Malformed or missing state is rendered as-is (empty tables) — an export must
 * never fail because a run was partial.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveProjectRootForExec } from '../config-loader.ts'
import { iterateDir, transcriptPath } from '../paths.ts'
import { readQualityGate } from './quality-store.ts'
import { readExperienceBank } from './experience-store.ts'
import { readDefenseEvents } from './defense-store.ts'
import { resultHeadline } from './present.ts'
import { renderRunReportMarkdown, renderRunReportSarif, REPORT_FORMATS } from '../report-render.ts'

/** Formats accepted by the tool (kept in sync with the shared renderer). */
const FORMATS: ReadonlySet<string> = new Set(REPORT_FORMATS)

/** Read the persisted transcript manifest, tolerating a missing/garbled file. */
function readManifest(projectRoot: string): { manifest: unknown; source: 'disk' | 'empty' } {
  const file = transcriptPath(projectRoot)
  if (!existsSync(file)) return { manifest: {}, source: 'empty' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { manifest: parsed, source: 'disk' }
    }
    return { manifest: {}, source: 'empty' }
  } catch {
    return { manifest: {}, source: 'empty' }
  }
}

/**
 * Register the `iterate_report` tool.
 * Renders the current run into a Markdown or SARIF report.
 */
export function registerReportTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_report',
      // Result card: surface the report headline ("report: markdown · N findings")
      // as the card title. Pure: reads only the rendered result (replay-safe).
      presentResult: (_args, result) => {
        const title = resultHeadline(result)
        return title ? { card: 'generic', title } : undefined
      },
      // `write:true` persists a file; a pure render joins a parallel group.
      isConcurrencySafe: (args) => (args as { write?: unknown }).write !== true,
      description:
        'Export the current iterate run as a portable report. ' +
        '`format:"markdown"` (default) renders a PR-pasteable report: run header (mode / round / status), ' +
        'quality-gate table, findings table, fixes table, per-round validations, defense events, and the ' +
        'experience bank. `format:"sarif"` renders a SARIF 2.1.0 log for CI / GitHub Code Scanning ' +
        '(one rule per review dimension; finding severity maps to error/warning/note; findings carry ' +
        'file + line locations and the suggested fix). ' +
        'Set `write:true` to also persist the report under `.iterate/report.md` / `.iterate/report.sarif` ' +
        'and get the path back. `lang` selects the report language (zh | en). ' +
        'Read-only apart from the optional report file; never touches source files.',
      parameters: {
        format: {
          type: 'string',
          description: 'Report format: "markdown" (default) or "sarif".',
          enum: ['markdown', 'sarif'],
        },
        write: {
          type: 'boolean',
          description: 'When true, persist the report to `.iterate/report.md` / `.iterate/report.sarif` and return its path. Default: false.',
        },
        lang: {
          type: 'string',
          description: 'Report language: "zh" (default) or "en". Affects labels/headings only.',
          enum: ['zh', 'en'],
        },
        path: {
          type: 'string',
          description: 'Project root directory (default: current working directory).',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            kind: { type: 'string' },
            format: { type: 'string' },
            /** The rendered report text (Markdown, or pretty-printed SARIF JSON). */
            content: { type: 'string' },
            /** The SARIF log object, when format is "sarif". */
            sarif: { type: 'json' },
            /** Whether a source transcript manifest was found on disk. */
            source: { type: 'string' },
            written: { type: 'boolean' },
            reportPath: { type: 'string' },
            findings: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `report export failed: ${value.error}` }]
          const content = typeof value.content === 'string' ? value.content : ''
          const header = [
            `report: ${String(value.format ?? 'markdown')} · ${String(value.findings ?? 0)} findings · source=${String(value.source ?? 'empty')}`,
            value.written ? `written to ${String(value.reportPath ?? '')}` : '',
          ].filter(Boolean).join(' · ')
          return [{ type: 'text', text: `${header}\n\n${content}` }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) return { ok: false, kind: 'report', error: resolved.reason }
        const projectRoot = resolved.root

        const rawFormat = typeof args.format === 'string' ? args.format : 'markdown'
        const format = FORMATS.has(rawFormat) ? rawFormat : 'markdown'
        const lang = args.lang === 'en' ? 'en' : 'zh'

        const { manifest, source } = readManifest(projectRoot)
        let qualityGate: unknown = null
        let experienceBank: unknown = null
        let defenseEvents: unknown = null
        try {
          qualityGate = readQualityGate(projectRoot)
        } catch {
          qualityGate = null
        }
        try {
          experienceBank = readExperienceBank(projectRoot)
        } catch {
          experienceBank = null
        }
        try {
          defenseEvents = readDefenseEvents(projectRoot)
        } catch {
          defenseEvents = null
        }

        const extra = { qualityGate, experienceBank, defenseEvents }
        let content: string
        let sarif: JsonValue | undefined
        let findings = 0
        try {
          if (format === 'sarif') {
            const doc = renderRunReportSarif(manifest, extra, {
              toolVersion: pluginVersion(),
            }) as unknown as { runs?: Array<{ results?: unknown[] }> }
            sarif = doc as unknown as JsonValue
            content = JSON.stringify(doc, null, 2)
            findings = Array.isArray(doc?.runs?.[0]?.results) ? (doc.runs[0].results as unknown[]).length : 0
          } else {
            content = renderRunReportMarkdown(manifest, extra, { lang }) as unknown as string
            findings = countMarkdownFindings(content)
          }
        } catch (err) {
          return {
            ok: false,
            kind: 'report',
            format,
            error: `failed to render report: ${err instanceof Error ? err.message : String(err)}`,
          }
        }

        let written = false
        let reportPath: string | undefined
        if (args.write === true) {
          try {
            const dir = iterateDir(projectRoot)
            mkdirSync(dir, { recursive: true })
            reportPath = `${dir}/report.${format === 'sarif' ? 'sarif' : 'md'}`
            writeFileSync(reportPath, content, 'utf-8')
            written = true
          } catch (err) {
            return {
              ok: false,
              kind: 'report',
              format,
              error: `failed to write report: ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        }

        return {
          ok: true,
          kind: 'report',
          format,
          content,
          ...(sarif !== undefined ? { sarif } : {}),
          source,
          written,
          ...(reportPath ? { reportPath } : {}),
          findings,
        }
      },
    }),
  )
}

/**
 * Best-effort plugin version for the SARIF driver. Resolved from the package
 * manifest next to this module (`src/tools` and `dist/tools` are both two
 * levels below the root); an unreadable/unparsable manifest yields ''.
 */
function pluginVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** Count the findings table rows in a rendered Markdown report (for the card). */
function countMarkdownFindings(markdown: string): number {
  const m = /##\s+.*?\((\d+)\)/.exec(markdown)
  if (m && m[1]) {
    const n = Number(m[1])
    if (Number.isFinite(n)) return n
  }
  return 0
}
