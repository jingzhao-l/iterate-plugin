/**
 * src/report-render.ts — pure renderers for the portable iterate run report.
 *
 * ONE data model, TWO consumers that must never disagree:
 *   - the `iterate_report` tool (server side), and
 *   - the observatory's "导出报告 / 导出 SARIF" buttons (client side),
 * both call {@link renderRunReportMarkdown} / {@link renderRunReportSarif} on
 * the same normalized {@link RunReportData}.
 *
 * This module is deliberately dependency-free and DOM-free: it is compiled to
 * `dist/` for the server AND inlined into `lib/client.js` by esbuild. It must
 * import NOTHING — importing `lib/parse.js` would drag a file outside `src/`
 * into the server's tsc program and scatter the emit into `dist/src/**`. Every
 * extraction is tolerant: a hand-edited manifest can only ever produce an empty
 * section, never a thrown export.
 *
 * Formats:
 *   - **markdown** — a PR-pasteable run report (header, quality gate, findings,
 *     fixes, validations, defense events, experience bank).
 *   - **sarif**    — SARIF 2.1.0 for CI / GitHub Code Scanning (ruleId =
 *     review dimension, severity → error | warning | note, file+line
 *     locations, suggested fix attached).
 */
/** Report formats accepted by the tool and the export buttons. */
export const REPORT_FORMATS = ['markdown', 'sarif'];
/** Severity ordering (lowest index = most severe). */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
/** Human labels for the report, keyed by language. */
const REPORT_LABELS = {
    en: {
        title: 'iterate run report',
        project: 'Project',
        goal: 'Goal',
        mode: 'Mode',
        status: 'Status',
        round: 'Round',
        updated: 'Updated',
        converged: 'converged',
        running: 'running',
        stopped: 'stopped',
        qualityGate: 'Quality gate',
        overall: 'Overall',
        verification: 'Verification',
        dimension: 'Dimension',
        qstatus: 'Status',
        score: 'Score',
        findingsCount: 'Findings',
        fixed: 'Fixed',
        convergence: 'Convergence',
        findings: 'Findings',
        severity: 'Severity',
        location: 'Location',
        summary: 'Summary',
        defensiveType: 'Type',
        none: '_none_',
        fixes: 'Fixes',
        file: 'File',
        delta: 'Δ',
        result: 'Result',
        applied: 'applied',
        failed: 'failed',
        validations: 'Validations',
        command: 'Command',
        exit: 'Exit',
        allowed: 'Allowed',
        yes: 'yes',
        no: 'no',
        defenseEvents: 'Defense events',
        experienceBank: 'Experience bank',
        hits: 'hits',
        entries: 'entries',
        generatedAt: 'Generated at',
        notRecorded: 'not recorded',
    },
    zh: {
        title: 'iterate 运行报告',
        project: '项目',
        goal: '目标',
        mode: '模式',
        status: '状态',
        round: '轮次',
        updated: '更新时间',
        converged: '已收敛',
        running: '运行中',
        stopped: '已结束',
        qualityGate: '质量门禁',
        overall: '总体',
        verification: '验证',
        dimension: '维度',
        qstatus: '状态',
        score: '得分',
        findingsCount: '发现数',
        fixed: '已修复',
        convergence: '收敛率',
        findings: '发现',
        severity: '严重度',
        location: '位置',
        summary: '摘要',
        defensiveType: '类型',
        none: '无',
        fixes: '修复',
        file: '文件',
        delta: '变更',
        result: '结果',
        applied: '成功',
        failed: '失败',
        validations: '验证',
        command: '命令',
        exit: '退出码',
        allowed: '已授权',
        yes: '是',
        no: '否',
        defenseEvents: '防御事件',
        experienceBank: '经验银行',
        hits: '命中',
        entries: '条目',
        generatedAt: '生成时间',
        notRecorded: '未记录',
    },
};
function reportLabels(lang) {
    return lang === 'en' ? REPORT_LABELS.en : REPORT_LABELS.zh;
}
/** Proxy-safe object read (never lets a hostile getter trap throw). */
function get(source, key) {
    if (!source || typeof source !== 'object')
        return undefined;
    try {
        return source[key];
    }
    catch {
        return undefined;
    }
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/** Escape a value for a Markdown table cell / inline text. */
function mdCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
/** Severity of a finding, defaulting to the least-severe bucket. */
function findingSeverity(f) {
    const s = get(f, 'severity');
    return typeof s === 'string' && SEVERITY_ORDER.includes(s) ? s : 'low';
}
/** Repo-relative POSIX uri for SARIF artifact locations. */
function sarifUri(file) {
    const s = typeof file === 'string' ? file.trim() : '';
    if (!s)
        return '';
    return s.replace(/\\/g, '/').replace(/^\.\//, '');
}
/** SARIF result level for an iterate severity. */
export function sarifLevel(severity) {
    if (severity === 'critical' || severity === 'high')
        return 'error';
    if (severity === 'medium')
        return 'warning';
    return 'note';
}
/**
 * Normalize a manifest (+ the pulled disk artifacts) into ONE shape. Pure;
 * tolerates junk at every field.
 */
export function buildRunReportData(manifest, extra) {
    const src = asObject(manifest) ?? {};
    const ex = asObject(extra);
    const qg = asObject(get(ex, 'qualityGate'));
    const bank = asObject(get(ex, 'experienceBank'));
    const defense = asObject(get(ex, 'defenseEvents'));
    const findings = asArray(get(src, 'findings')).map((f) => ({
        dimension: asString(get(f, 'dimension')),
        file: asString(get(f, 'file')),
        line: asNumber(get(f, 'line')),
        severity: findingSeverity(f),
        summary: asString(get(f, 'summary')),
        failureScenario: asString(get(f, 'failure_scenario')),
        suggestedFix: asString(get(f, 'suggested_fix')),
        isAtomic: get(f, 'is_atomic') === true,
        acknowledged: get(f, 'acknowledged') === true,
    }));
    findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) -
        SEVERITY_ORDER.indexOf(b.severity));
    const fixes = asArray(get(src, 'fixes')).map((f) => ({
        round: asNumber(get(f, 'round')),
        file: asString(get(f, 'file')),
        summary: asString(get(f, 'summary')),
        linesAdded: asNumber(get(f, 'linesAdded')),
        linesRemoved: asNumber(get(f, 'linesRemoved')),
        success: get(f, 'success') !== false,
    }));
    const validations = asArray(get(src, 'validations')).map((v) => ({
        round: asNumber(get(v, 'round')),
        command: asString(get(v, 'command')),
        exitCode: typeof get(v, 'exitCode') === 'number' ? asNumber(get(v, 'exitCode')) : null,
        allowed: get(v, 'allowed') === true,
        rejectReason: asString(get(v, 'rejectReason')),
    }));
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
        const key = f.severity;
        if (key in severityCounts)
            severityCounts[key] += 1;
    }
    const mode = get(src, 'mode');
    const taskMode = get(src, 'taskMode');
    const stoppedReason = get(src, 'stoppedReason');
    return {
        project: asString(get(src, 'project')),
        goal: asString(get(src, 'goal')),
        mode: mode === 'normal' || mode === 'dry-run' ? mode : null,
        taskMode: taskMode === 'code' || taskMode === 'iterate' ? taskMode : null,
        round: asNumber(get(src, 'round')),
        maxRounds: asNumber(get(src, 'maxRounds')),
        active: get(src, 'active') !== false,
        stoppedReason: typeof stoppedReason === 'string' && stoppedReason ? stoppedReason : null,
        updatedAt: asString(get(src, 'updatedAt')),
        convergence: asArray(get(src, 'convergence')).filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0),
        findings,
        severityCounts,
        fixes,
        validations,
        qualityGate: qg,
        experienceBank: bank,
        defenseEvents: defense,
    };
}
/** One-line human status for the report header. */
function reportStatus(data, labels) {
    if (data.active === true)
        return labels.running;
    if (data.stoppedReason)
        return `${labels.stopped} · ${data.stoppedReason}`;
    return labels.stopped;
}
/** Render a PR-pasteable Markdown run report. */
export function renderRunReportMarkdown(manifest, extra, opts) {
    const data = buildRunReportData(manifest, extra);
    const o = opts ?? {};
    const labels = reportLabels(o.lang === 'en' ? 'en' : 'zh');
    const when = o.now && o.now ? o.now : new Date().toISOString();
    const lines = [];
    lines.push(`# ${labels.title}`);
    lines.push('');
    lines.push(`- **${labels.project}**: \`${mdCell(data.project || labels.notRecorded)}\``);
    if (data.goal)
        lines.push(`- **${labels.goal}**: ${mdCell(data.goal)}`);
    lines.push(`- **${labels.mode}**: ${mdCell(data.mode || labels.notRecorded)}${data.taskMode ? ` · task_mode: ${data.taskMode}` : ''}`);
    const roundText = data.maxRounds > 0 ? `${data.round}/${data.maxRounds}` : String(data.round);
    lines.push(`- **${labels.round}**: ${mdCell(roundText)} · **${labels.status}**: ${mdCell(reportStatus(data, labels))}`);
    lines.push(`- **${labels.updated}**: ${mdCell(data.updatedAt || when)}`);
    lines.push(`- **${labels.generatedAt}**: ${mdCell(when)}`);
    lines.push('');
    // ── Quality gate ──
    const qg = data.qualityGate;
    if (qg) {
        lines.push(`## ${labels.qualityGate}`);
        lines.push('');
        const status = typeof qg.overallStatus === 'string' ? qg.overallStatus.toUpperCase() : 'PENDING';
        lines.push(`- **${labels.overall}**: ${mdCell(status)} (${labels.score} ${asNumber(qg.overallScore)})`);
        lines.push(`- **${labels.verification}**: ${asNumber(qg.passedChecks)}/${asNumber(qg.totalChecks)} (${asNumber(qg.verificationPassRate)}%)`);
        if (typeof qg.failReason === 'string' && qg.failReason) {
            lines.push(`- ${labels.status}: ${mdCell(qg.failReason)}`);
        }
        lines.push('');
        const dims = asArray(qg.dimensions);
        if (dims.length > 0) {
            lines.push(`| ${labels.dimension} | ${labels.qstatus} | ${labels.score} | ${labels.findingsCount} | ${labels.fixed} | ${labels.convergence} |`);
            lines.push('| --- | --- | --- | --- | --- | --- |');
            for (const d of dims) {
                lines.push(`| ${mdCell(get(d, 'dimension'))} | ${mdCell(get(d, 'status'))} | ${mdCell(get(d, 'score'))} | ${mdCell(get(d, 'findingsCount'))} | ${mdCell(get(d, 'fixedCount'))} | ${mdCell(get(d, 'convergenceRate'))}% |`);
            }
            lines.push('');
        }
    }
    // ── Findings ──
    lines.push(`## ${labels.findings} (${data.findings.length})`);
    lines.push('');
    if (data.findings.length === 0) {
        lines.push(labels.none);
    }
    else {
        lines.push(`| ${labels.severity} | ${labels.dimension} | ${labels.location} | ${labels.summary} |`);
        lines.push('| --- | --- | --- | --- |');
        for (const f of data.findings) {
            const loc = f.file ? `${f.file}${f.line > 1 ? `:${f.line}` : ''}` : '';
            lines.push(`| ${mdCell(f.severity)} | ${mdCell(f.dimension)} | ${mdCell(loc)} | ${mdCell(f.summary)} |`);
        }
    }
    lines.push('');
    // ── Fixes ──
    lines.push(`## ${labels.fixes} (${data.fixes.length})`);
    lines.push('');
    if (data.fixes.length === 0) {
        lines.push(labels.none);
    }
    else {
        lines.push(`| # | ${labels.file} | ${labels.delta} | ${labels.result} | ${labels.summary} |`);
        lines.push('| --- | --- | --- | --- | --- |');
        for (const f of data.fixes) {
            lines.push(`| ${mdCell(f.round)} | ${mdCell(f.file)} | ${mdCell(`+${f.linesAdded}/-${f.linesRemoved}`)} | ${f.success ? labels.applied : labels.failed} | ${mdCell(f.summary)} |`);
        }
    }
    lines.push('');
    // ── Validations ──
    if (data.validations.length > 0) {
        lines.push(`## ${labels.validations}`);
        lines.push('');
        lines.push(`| # | ${labels.command} | ${labels.exit} | ${labels.allowed} |`);
        lines.push('| --- | --- | --- | --- |');
        for (const v of data.validations) {
            lines.push(`| ${mdCell(v.round)} | \`${mdCell(v.command)}\` | ${v.exitCode === null ? '—' : mdCell(v.exitCode)} | ${v.allowed ? labels.yes : labels.no} |`);
        }
        lines.push('');
    }
    // ── Defense events ──
    const deEvents = asArray(get(data.defenseEvents, 'events'));
    if (deEvents.length > 0) {
        lines.push(`## ${labels.defenseEvents} (${deEvents.length})`);
        lines.push('');
        lines.push(`| ${labels.severity} | ${labels.defensiveType} | ${labels.round} | ${labels.summary} |`);
        lines.push('| --- | --- | --- | --- |');
        for (const e of deEvents) {
            lines.push(`| ${mdCell(get(e, 'severity'))} | ${mdCell(get(e, 'type'))} | ${mdCell(get(e, 'round'))} | ${mdCell(get(e, 'description') || get(e, 'outcome'))} |`);
        }
        lines.push('');
    }
    // ── Experience bank ──
    const entries = asArray(get(data.experienceBank, 'entries'));
    if (entries.length > 0) {
        const totalHits = asNumber(get(data.experienceBank, 'totalHits'));
        lines.push(`## ${labels.experienceBank} (${entries.length} ${labels.entries}, ${totalHits} ${labels.hits})`);
        lines.push('');
        for (const e of entries) {
            lines.push(`- **[${mdCell(get(e, 'id'))}]** ${mdCell(get(e, 'pattern'))} — ${mdCell(get(e, 'description'))} (${labels.hits}: ${mdCell(get(e, 'hitCount'))})`);
        }
        lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
/** Render a SARIF 2.1.0 document from the same normalized data. */
export function renderRunReportSarif(manifest, extra, opts) {
    const data = buildRunReportData(manifest, extra);
    const o = opts ?? {};
    const rules = [];
    const seenRules = new Set();
    for (const f of data.findings) {
        const id = f.dimension || 'review';
        if (seenRules.has(id))
            continue;
        seenRules.add(id);
        rules.push({
            id,
            name: id,
            shortDescription: { text: `${id} review dimension` },
            defaultConfiguration: { level: 'warning' },
        });
    }
    const results = data.findings.map((f) => {
        const result = {
            ruleId: f.dimension || 'review',
            level: sarifLevel(f.severity),
            message: { text: f.summary || `${f.severity} finding` },
            properties: {
                severity: f.severity,
                atomic: f.isAtomic,
                acknowledged: f.acknowledged,
            },
        };
        const uri = sarifUri(f.file);
        if (uri) {
            result.locations = [
                {
                    physicalLocation: {
                        artifactLocation: { uri },
                        ...(f.line > 0 ? { region: { startLine: f.line } } : {}),
                    },
                },
            ];
        }
        if (f.suggestedFix)
            result.fixes = [{ description: { text: f.suggestedFix } }];
        return result;
    });
    const failedValidations = data.validations.filter((v) => v.exitCode !== 0).length;
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'iterate-plugin',
                        informationUri: o.informationUri && o.informationUri
                            ? o.informationUri
                            : 'https://github.com/jingzhao-l/iterate-plugin',
                        ...(o.toolVersion ? { version: o.toolVersion } : {}),
                        rules,
                    },
                },
                invocations: [
                    {
                        executionSuccessful: failedValidations === 0 && data.qualityGate?.overallStatus !== 'fail',
                        ...(data.updatedAt ? { startTimeUtc: data.updatedAt } : {}),
                        properties: {
                            mode: data.mode,
                            taskMode: data.taskMode,
                            round: data.round,
                            maxRounds: data.maxRounds,
                            stoppedReason: data.stoppedReason,
                            qualityStatus: data.qualityGate ? (data.qualityGate.overallStatus ?? null) : null,
                            convergence: data.convergence,
                            findingsBySeverity: data.severityCounts,
                        },
                    },
                ],
                results,
            },
        ],
    };
}
/**
 * Render a report in the requested format. Unknown formats fall back to
 * Markdown (the tool's default).
 */
export function renderRunReport(format, manifest, extra, opts) {
    if (format === 'sarif')
        return renderRunReportSarif(manifest, extra, opts);
    return renderRunReportMarkdown(manifest, extra, opts);
}
/**
 * Deterministic download filename for a report, e.g.
 * `iterate-report-2026-10-18T01-02-03-000Z.md`.
 */
export function runReportFilename(format, opts) {
    const ext = format === 'sarif' ? 'sarif' : 'md';
    const stamp = opts?.now && opts.now ? opts.now.replace(/[:.]/g, '-') : new Date().toISOString().replace(/[:.]/g, '-');
    return `iterate-report-${stamp}.${ext}`;
}
