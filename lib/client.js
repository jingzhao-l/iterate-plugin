window.__ModuleLoader__.load({ id: "iterate-plugin", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// lib/parse.js
var SEVERITY_ORDER = ["critical", "high", "medium", "low"];
var SEVERITY_LABEL = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW"
};
var SEVERITY_COLOR = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280"
};
function safeGet(o, key) {
  try {
    return o[key];
  } catch {
    return void 0;
  }
}
function safeKeys(o) {
  try {
    return Object.keys(o);
  } catch {
    return [];
  }
}
function scanSessionForResume(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return 0;
  if (!obj || typeof obj !== "object") return 0;
  const s = seen || /* @__PURE__ */ new Set();
  if (s.has(obj)) return 0;
  s.add(obj);
  let best = 0;
  const direct = (
    /** @type {Record<string, unknown>} */
    obj
  );
  if (safeGet(direct, "type") === "resume") {
    const data = (
      /** @type {Record<string, unknown>} */
      safeGet(direct, "data") || {}
    );
    if (typeof safeGet(data, "resumeCount") === "number" && safeGet(data, "resumeCount") > best) {
      best = safeGet(data, "resumeCount");
    }
  }
  const directEntry = safeGet(direct, "entry");
  if (directEntry && typeof directEntry === "object") {
    const entry = (
      /** @type {Record<string, unknown>} */
      directEntry
    );
    if (safeGet(entry, "type") === "resume") {
      const data = (
        /** @type {Record<string, unknown>} */
        safeGet(entry, "data") || {}
      );
      if (typeof safeGet(data, "resumeCount") === "number" && safeGet(data, "resumeCount") > best) {
        best = safeGet(data, "resumeCount");
      }
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = scanSessionForResume(item, s, maxDepth - 1);
      if (found > best) best = found;
    }
    return best;
  }
  for (const key of safeKeys(direct)) {
    const val = safeGet(direct, key);
    if (val && typeof val === "object") {
      const found = scanSessionForResume(val, s, maxDepth - 1);
      if (found > best) best = found;
    }
  }
  return best;
}
function countSessionImages(session) {
  if (!session || typeof session !== "object") return 0;
  const ids = /* @__PURE__ */ new Set();
  let count = 0;
  const walk = (obj, depth) => {
    if (depth <= 0 || !obj || typeof obj !== "object") return;
    if (seen.has(obj)) return;
    seen.add(obj);
    const o = (
      /** @type {Record<string, unknown>} */
      obj
    );
    let ref = null;
    if (safeGet(o, "type") === "image" && safeGet(o, "attachment") && typeof safeGet(o, "attachment") === "object") {
      ref = /** @type {Record<string, unknown>} */
      safeGet(o, "attachment");
    }
    if (!ref && typeof safeGet(o, "mediaType") === "string" && String(safeGet(o, "mediaType")).startsWith("image/")) {
      ref = o;
    }
    if (ref) {
      const id = typeof safeGet(ref, "attachmentId") === "string" ? safeGet(ref, "attachmentId") : null;
      if (id) {
        if (!ids.has(id)) {
          ids.add(id);
          count += 1;
        }
      } else {
        count += 1;
      }
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth - 1);
      return;
    }
    for (const key of safeKeys(o)) {
      const val = safeGet(o, key);
      if (val && typeof val === "object") walk(val, depth - 1);
    }
  };
  const seen = /* @__PURE__ */ new Set();
  walk(session, 12);
  return count;
}
function isReviewReport(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  const convergence = safeGet(o, "convergence");
  return typeof convergence === "object" && convergence !== null && Array.isArray(safeGet(o, "findings")) && Array.isArray(safeGet(o, "rounds"));
}
function findReportInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null;
  if (!obj || typeof obj !== "object") return null;
  const s = seen || /* @__PURE__ */ new Set();
  if (s.has(obj)) return null;
  s.add(obj);
  if (isReviewReport(obj)) return (
    /** @type {Record<string, unknown>} */
    obj
  );
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findReportInObject(item, s, maxDepth - 1);
      if (found) return found;
    }
    return null;
  }
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  for (const key of safeKeys(o)) {
    const val = safeGet(o, key);
    if (val && typeof val === "object") {
      const found = findReportInObject(val, s, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}
function scanSessionForReport(session) {
  if (!session || typeof session !== "object") return null;
  const direct = findReportInObject(session);
  if (direct) return direct;
  const s = (
    /** @type {Record<string, unknown>} */
    session
  );
  const toolCalls = safeGet(s, "toolCalls");
  if (Array.isArray(toolCalls)) {
    const calls = (
      /** @type {Array<Record<string, unknown>>} */
      toolCalls
    );
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (!call) continue;
      if (safeGet(call, "tool") === "iterate_review" || String(safeGet(call, "tool") ?? "").endsWith("iterate_review")) {
        const result = safeGet(call, "result");
        if (result && typeof result === "object") {
          const r = (
            /** @type {Record<string, unknown>} */
            result
          );
          const report = safeGet(r, "report");
          if (report && typeof report === "object") {
            return (
              /** @type {Record<string, unknown>} */
              report
            );
          }
        }
      }
    }
  }
  const messages = safeGet(s, "messages");
  if (Array.isArray(messages)) {
    const msgs = (
      /** @type {Array<Record<string, unknown>>} */
      messages
    );
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      const msgCalls = msg && Array.isArray(safeGet(msg, "tool_calls")) ? safeGet(msg, "tool_calls") : null;
      if (!msg || !msgCalls) continue;
      const calls = (
        /** @type {Array<Record<string, unknown>>} */
        msgCalls
      );
      for (const call of calls) {
        if (!call) continue;
        const fn = safeGet(call, "function");
        if (fn && typeof fn === "object") {
          const f = (
            /** @type {Record<string, unknown>} */
            fn
          );
          if (String(safeGet(f, "name") ?? "").endsWith("iterate_review")) {
            try {
              const args = JSON.parse(String(safeGet(f, "arguments") ?? "{}"));
              const found = findReportInObject(args);
              if (found) return found;
            } catch {
            }
          }
        }
      }
    }
  }
  return null;
}
function isRunSummary(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  const final = safeGet(o, "finalReport");
  return !!final && typeof final === "object" && (safeGet(final, "verdict") === "approved" || safeGet(final, "verdict") === "needs_revision");
}
function findRunSummaryInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null;
  if (!obj || typeof obj !== "object") return null;
  const s = seen || /* @__PURE__ */ new Set();
  if (s.has(obj)) return null;
  s.add(obj);
  if (isRunSummary(obj)) return (
    /** @type {Record<string, unknown>} */
    obj
  );
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRunSummaryInObject(item, s, maxDepth - 1);
      if (found) return found;
    }
    return null;
  }
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  for (const key of safeKeys(o)) {
    const val = safeGet(o, key);
    if (val && typeof val === "object") {
      const found = findRunSummaryInObject(val, s, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}
function scanSessionForRunSummary(session) {
  if (!session || typeof session !== "object") return null;
  const direct = findRunSummaryInObject(session);
  if (direct) return direct;
  const s = (
    /** @type {Record<string, unknown>} */
    session
  );
  const toolCalls = safeGet(s, "toolCalls");
  if (Array.isArray(toolCalls)) {
    const calls = (
      /** @type {Array<Record<string, unknown>>} */
      toolCalls
    );
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (!call) continue;
      if (safeGet(call, "tool") === "workflow" || String(safeGet(call, "tool") ?? "").endsWith("workflow")) {
        const found = findRunSummaryInObject(safeGet(call, "result"), void 0, 24);
        if (found) return found;
      }
    }
  }
  const messages = safeGet(s, "messages");
  if (Array.isArray(messages)) {
    const msgs = (
      /** @type {Array<Record<string, unknown>>} */
      messages
    );
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (!msg) continue;
      const found = findRunSummaryInObject(safeGet(msg, "content"));
      if (found) return found;
    }
  }
  return null;
}
function extractVerdict(runSummary) {
  if (!isRunSummary(runSummary)) return null;
  const o = (
    /** @type {Record<string, unknown>} */
    runSummary
  );
  const final = (
    /** @type {Record<string, unknown>} */
    safeGet(o, "finalReport")
  );
  const meta = safeGet(final, "metaReview") && typeof safeGet(final, "metaReview") === "object" ? (
    /** @type {Record<string, unknown>} */
    safeGet(final, "metaReview")
  ) : {};
  const issues = Array.isArray(safeGet(meta, "issues")) ? safeGet(meta, "issues") : [];
  const roundsVal = safeGet(o, "rounds");
  const totalRounds = typeof roundsVal === "number" ? roundsVal : Array.isArray(roundsVal) ? roundsVal.length : 0;
  return {
    verdict: safeGet(final, "verdict") === "needs_revision" ? "needs_revision" : "approved",
    reportIssues: issues.length,
    checksRun: typeof safeGet(meta, "checksRun") === "number" ? safeGet(meta, "checksRun") : 0,
    converged: safeGet(o, "converged") === true,
    totalRounds,
    totalFindings: typeof safeGet(o, "totalFindings") === "number" ? safeGet(o, "totalFindings") : 0
  };
}
function normalizeReport(report) {
  const convergence = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const rounds = (
    /** @type {Array<unknown>} */
    report.rounds ?? []
  );
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    report.findings ?? []
  );
  const totalRounds = typeof convergence.totalRounds === "number" ? convergence.totalRounds : rounds.length;
  const normalizedConvergence = {
    totalRounds,
    findingsByRound: Array.isArray(convergence.findingsByRound) ? convergence.findingsByRound : rounds.map((r) => {
      const rr = (
        /** @type {Record<string, unknown>} */
        r
      );
      return Array.isArray(rr?.findings) ? rr.findings.length : 0;
    }),
    converged: convergence.converged === true,
    stoppedReason: convergence.stoppedReason ?? (rounds.length < totalRounds ? "converged" : "max_rounds_reached")
  };
  let summary = report.summary;
  if (!summary || typeof summary !== "object") {
    summary = computeSummaryFromFindings(findings);
  } else {
    const s = (
      /** @type {Record<string, unknown>} */
      summary
    );
    const computed = computeSummaryFromFindings(findings);
    summary = {
      totalFindings: typeof s.totalFindings === "number" ? s.totalFindings : findings.length,
      critical: typeof s.critical === "number" ? s.critical : computed.critical,
      high: typeof s.high === "number" ? s.high : computed.high,
      medium: typeof s.medium === "number" ? s.medium : computed.medium,
      low: typeof s.low === "number" ? s.low : computed.low,
      byDimension: s.byDimension && typeof s.byDimension === "object" ? s.byDimension : computed.byDimension,
      ...typeof s.fixedCount === "number" ? { fixedCount: s.fixedCount } : {}
    };
  }
  return {
    mode: report.mode ?? "dry-run",
    goal: report.goal ?? "",
    dimensions: Array.isArray(report.dimensions) ? report.dimensions : [],
    maxReviewRounds: report.maxReviewRounds ?? totalRounds,
    rounds,
    findings,
    convergence: normalizedConvergence,
    summary
  };
}
function computeSummaryFromFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const byDimension = {};
  for (const f of findings) {
    const sev = String(f.severity ?? "low");
    if (sev in counts) counts[sev]++;
    const dim = String(f.dimension ?? "unknown");
    byDimension[dim] = (byDimension[dim] ?? 0) + 1;
  }
  return {
    totalFindings: findings.length,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    byDimension
  };
}
function computeConvergenceProgress(report) {
  const convergence = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const totalRounds = typeof convergence.totalRounds === "number" ? convergence.totalRounds : 1;
  const currentRounds = (
    /** @type {Array<unknown>} */
    (report.rounds ?? []).length
  );
  if (!(totalRounds > 0)) return 0;
  return Math.min(100, Math.round(currentRounds / totalRounds * 100));
}
function getCurrentRound(report) {
  return (
    /** @type {Array<unknown>} */
    (report.rounds ?? []).length
  );
}
function getTotalRounds(report) {
  const convergence = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  return typeof convergence.totalRounds === "number" ? convergence.totalRounds : 1;
}
function severityStats(report) {
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    report.findings ?? []
  );
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const sev = String(f.severity ?? "low");
    if (sev in counts) counts[sev]++;
  }
  return counts;
}
function groupByDimension(report) {
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    report.findings ?? []
  );
  const groups = {};
  for (const f of findings) {
    const dim = String(f.dimension ?? "unknown");
    if (!groups[dim]) groups[dim] = [];
    groups[dim].push(f);
  }
  return groups;
}
function buildTriageState(report) {
  const findings = (
    /** @type {Array<unknown>} */
    report.findings ?? []
  );
  const state = {};
  for (let i = 0; i < findings.length; i++) {
    state[String(i)] = "keep";
  }
  return state;
}
function hashReport(report) {
  const convergence = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const totalRounds = String(convergence.totalRounds ?? "");
  const findingsCount = String(
    /** @type {Array<unknown>} */
    (report.findings ?? []).length
  );
  const firstFinding = (
    /** @type {Array<Record<string, unknown>>} */
    (report.findings ?? [])[0]
  );
  const firstSummary = firstFinding ? String(firstFinding.summary ?? "") : "";
  const mode = String(report.mode ?? "");
  return `iterate-triage-${mode}-${totalRounds}-${findingsCount}-${firstSummary.slice(0, 20)}`;
}
function toKnownIntentionalYaml(entries) {
  if (!entries || entries.length === 0) return "";
  const lines = ["known_intentional:"];
  for (const e of entries) {
    lines.push(`  - file: ${JSON.stringify(e.file)}`);
    if (e.line !== void 0 && e.line > 0) {
      lines.push(`    line: ${e.line}`);
    }
    lines.push(`    dimension: ${JSON.stringify(e.dimension)}`);
    lines.push(`    reason: ${JSON.stringify(e.reason)}`);
  }
  return lines.join("\n");
}
function buildApplyInstruction(entries) {
  if (!entries || entries.length === 0) return "";
  const payload = JSON.stringify(
    {
      operation: "apply",
      entries: entries.map((e) => ({
        file: e.file,
        ...e.line !== void 0 ? { line: e.line } : {},
        dimension: e.dimension,
        reason: e.reason
      }))
    },
    null,
    2
  );
  return `Please call \`iterate_triage\` with the following payload to apply the triage verdicts:

\`\`\`json
${payload}
\`\`\``;
}
function collectIgnoredEntries(triageState, findings) {
  const entries = [];
  for (const [idx, verdict] of Object.entries(triageState)) {
    if (verdict !== "ignore") continue;
    const finding = findings[Number(idx)];
    if (!finding) continue;
    entries.push({
      file: String(finding.file ?? ""),
      ...typeof finding.line === "number" && finding.line > 0 ? { line: finding.line } : {},
      dimension: String(finding.dimension ?? ""),
      reason: String(finding.summary ?? "")
    });
  }
  return entries;
}
function normalizeFindingFilter(filter) {
  const f = filter && typeof filter === "object" ? filter : {};
  const severities = Array.isArray(f.severities) ? f.severities.filter((s) => SEVERITY_ORDER.includes(String(s))) : [];
  const dimensions = Array.isArray(f.dimensions) ? f.dimensions.filter((d) => typeof d === "string" && d.length > 0) : [];
  const search = typeof f.search === "string" ? f.search.trim().toLowerCase() : "";
  return { severities, dimensions, search };
}
function findingMatches(finding, filter) {
  const f = normalizeFindingFilter(filter);
  const sev = String(finding.severity ?? "low");
  if (f.severities.length > 0 && !f.severities.includes(sev)) return false;
  const dim = String(finding.dimension ?? "");
  if (f.dimensions.length > 0 && !f.dimensions.includes(dim)) return false;
  if (f.search) {
    const haystack = [
      String(finding.file ?? ""),
      String(finding.summary ?? ""),
      String(finding.dimension ?? ""),
      String(finding.suggested_fix ?? "")
    ].join(" ").toLowerCase();
    if (haystack.indexOf(f.search) < 0) return false;
  }
  return true;
}
function filterFindingsWithIndices(findings, filter) {
  const f = normalizeFindingFilter(filter);
  const list = Array.isArray(findings) ? findings : [];
  const filtered = [];
  const indices = [];
  for (let i = 0; i < list.length; i++) {
    if (findingMatches(list[i], f)) {
      filtered.push(list[i]);
      indices.push(i);
    }
  }
  return { filtered, indices };
}
function buildFilterOptions(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const severities = SEVERITY_ORDER.map((value) => ({ value, count: 0 }));
  const dimCounts = {};
  for (const f of list) {
    const sev = String(f.severity ?? "low");
    const sv = severities.find((s) => s.value === sev);
    if (sv) sv.count++;
    const dim = String(f.dimension ?? "unknown");
    dimCounts[dim] = (dimCounts[dim] ?? 0) + 1;
  }
  return {
    severities: severities.map((s) => ({ ...s })),
    dimensions: Object.keys(dimCounts).map((value) => ({ value, count: dimCounts[value] }))
  };
}
function countVerdicts(triageState) {
  const counts = { keep: 0, skip: 0, ignore: 0 };
  for (const v of Object.values(triageState ?? {})) {
    if (v === "keep" || v === "skip" || v === "ignore") counts[v]++;
  }
  return counts;
}
function batchSetVerdict(triageState, indices, verdict) {
  if (verdict !== "keep" && verdict !== "skip" && verdict !== "ignore") return triageState;
  if (!Array.isArray(indices) || indices.length === 0) return triageState;
  const next = { ...triageState };
  for (const idx of indices) {
    if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0) {
      next[String(idx)] = verdict;
    }
  }
  return next;
}
function setAllVerdicts(triageState, verdict, indices) {
  const targets = Array.isArray(indices) ? indices : Object.keys(triageState ?? {}).map(Number);
  return batchSetVerdict(triageState, targets, verdict);
}
function buildRoundHistory(report) {
  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  return rounds.map((r) => {
    const rr = (
      /** @type {Record<string, unknown>} */
      r
    );
    const findings = Array.isArray(rr.findings) ? rr.findings : [];
    const sev = severityStats({ findings });
    return {
      round: typeof rr.round === "number" ? rr.round : 0,
      count: findings.length,
      critical: sev.critical,
      high: sev.high,
      medium: sev.medium,
      low: sev.low
    };
  });
}
function buildFindingTrend(report) {
  const conv = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  if (Array.isArray(conv.findingsByRound)) {
    return conv.findingsByRound.map((n, i) => ({ round: i + 1, count: typeof n === "number" ? n : 0 }));
  }
  return buildRoundHistory(report).map((h) => ({ round: h.round, count: h.count }));
}
function computeTrendMetrics(report) {
  const conv = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const points = buildFindingTrend(report);
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const firstRound = points.length > 0 ? points[0].count : 0;
  const lastRound = points.length > 0 ? points[points.length - 1].count : 0;
  const reductionPercent = firstRound > 0 ? Math.round((firstRound - lastRound) / firstRound * 100) : 0;
  return {
    points,
    total,
    firstRound,
    lastRound,
    reductionPercent,
    converged: conv.converged === true
  };
}
function trendMax(points) {
  let max = 1;
  for (const p of Array.isArray(points) ? points : []) {
    if (typeof p.count === "number" && p.count > max) max = p.count;
  }
  return max;
}
function buildCompletionSummary(report) {
  const conv = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const rounds = getCurrentRound(report);
  const total = getTotalRounds(report);
  const stats = severityStats(report);
  const converged = conv.converged === true;
  const reason = converged ? "\u5DF2\u6536\u655B" : `\u5DF2\u8FBE\u6700\u5927\u8F6E\u6570 ${total}`;
  const totalFindings = stats.critical + stats.high + stats.medium + stats.low;
  return `iterate \u8BC4\u5BA1\u5B8C\u6210 \xB7 ${rounds}/${total} \u8F6E \xB7 ${totalFindings} \u9879\u53D1\u73B0 \xB7 ${reason}`;
}
var CONFIG_EDIT_FIELDS = [
  { key: "goal", label: "\u76EE\u6807", hint: "\u4E00\u53E5\u8BDD\u63CF\u8FF0\u672C\u6B21\u8FED\u4EE3\u76EE\u6807\uFF08\u5B57\u7B26\u4E32\uFF09" },
  { key: "dimensions", label: "\u5BA1\u67E5\u7EF4\u5EA6", hint: '\u6570\u7EC4\uFF0C\u5982 ["correctness","security"]' },
  { key: "max_rounds", label: "\u6700\u5927\u8F6E\u6570", hint: "\u6B63\u6574\u6570" },
  { key: "review.scope", label: "\u5BA1\u67E5\u8303\u56F4", hint: '"full" \u6216 "changed-only"' },
  { key: "atomic.max_lines", label: "\u539F\u5B50\u4FEE\u590D\u4E0A\u9650\u884C\u6570", hint: "\u6B63\u6574\u6570" },
  { key: "git.push_per_round", label: "\u6BCF\u8F6E\u63A8\u9001", hint: "true / false" }
];
function buildConfigEditGuide() {
  const lines = [
    "iterate \u914D\u7F6E\u7F16\u8F91\u6307\u5F15",
    "---------------------",
    "\u914D\u7F6E\u6587\u4EF6\uFF1A\u9879\u76EE\u6839\u76EE\u5F55 iterate.config.yaml\u3002",
    "",
    "\u53EF\u7F16\u8F91\u5B57\u6BB5\uFF1A",
    ...CONFIG_EDIT_FIELDS.map((f) => `- ${f.key}\uFF08${f.label}\uFF09\uFF1A${f.hint}`),
    "",
    "\u8BA9\u6A21\u578B\u5E2E\u4F60\u6539\uFF1A",
    '1. \u8C03\u7528 iterate_config({ operation: "read" }) \u67E5\u770B\u5F53\u524D\u914D\u7F6E\uFF1B',
    "2. \u8BF4\u660E\u60F3\u6539\u7684\u5B57\u6BB5\uFF0C\u4F8B\u5982\u300C\u628A max_rounds \u6539\u6210 5\uFF0Cdimensions \u53EA\u4FDD\u7559 correctness \u548C security\u300D\uFF1B",
    '3. \u6A21\u578B\u4F1A\u8C03\u7528 iterate_config({ operation: "write", updates: {...} }) \u5199\u5165\uFF0C\u5199\u5165\u524D\u81EA\u52A8\u5907\u4EFD\uFF0C\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\u3002'
  ];
  return lines.join("\n");
}
var VERDICT_SHORTCUTS = {
  y: "keep",
  Y: "keep",
  n: "skip",
  N: "skip",
  a: "ignore",
  A: "ignore"
};
function keyToVerdict(key) {
  return VERDICT_SHORTCUTS[key] ?? null;
}
function allVerdictKeys(triageState) {
  const state = triageState && typeof triageState === "object" ? triageState : {};
  return Object.keys(state).map(Number).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}
var RUNTIME_ARTIFACTS = [
  {
    key: "decision-log.jsonl",
    label: "\u51B3\u7B56\u65E5\u5FD7",
    hint: "\u8FFD\u52A0\u5F0F JSONL\uFF0C\u8BB0\u5F55\u6BCF\u8F6E plan / review / fix / revert / validation \u51B3\u7B56"
  },
  {
    key: "checkpoint.json",
    label: "\u8FED\u4EE3\u65AD\u70B9",
    hint: "\u957F\u8FED\u4EE3\u7684\u8FDB\u5EA6\u5FEB\u7167\uFF0C\u4E2D\u65AD\u540E\u53EF\u6062\u590D\uFF08iterate_checkpoint\uFF09"
  },
  {
    key: "fixes/registry.json",
    label: "\u4FEE\u590D\u6CE8\u518C\u8868",
    hint: "\u6BCF\u4E2A\u539F\u5B50\u4FEE\u590D\u7684 id / diff / \u5907\u4EFD\u8DEF\u5F84\uFF08iterate_fix / iterate_diff\uFF09"
  },
  {
    key: "fixes/*.bak",
    label: "\u4FEE\u590D\u5907\u4EFD",
    hint: "\u6BCF\u6B21\u4FEE\u590D\u524D\u7684\u539F\u6587\u4EF6\u5907\u4EFD\uFF0C\u56DE\u6EDA\u4F9D\u8D56\uFF08iterate_rollback\uFF09"
  }
];
function buildRuntimeStatusGuide() {
  const lines = [
    "iterate \u8FD0\u884C\u65F6\u72B6\u6001\u6982\u89C8",
    "----------------------",
    "\u6240\u6709\u8FD0\u884C\u65F6\u4EA7\u7269\u4F4D\u4E8E\u9879\u76EE\u6839\u76EE\u5F55 .iterate/ \u4E0B\uFF1A",
    "",
    ...RUNTIME_ARTIFACTS.map((a) => `- ${a.key}\uFF08${a.label}\uFF09\uFF1A${a.hint}`),
    "",
    "\u67E5\u770B\u72B6\u6001\uFF1A\u8BA9\u6A21\u578B\u8C03\u7528 iterate_status\uFF08\u6C47\u603B\uFF09\u6216 iterate_history\uFF08\u660E\u7EC6\uFF09\u3002",
    "\u6E05\u7406\u72B6\u6001\uFF1A\u8BA9\u6A21\u578B\u8C03\u7528 iterate_prune\uFF08\u9ED8\u8BA4 dry-run\uFF0C\u53EA\u62A5\u544A\u4E0D\u5220\u9664\uFF0C\u663E\u5F0F dryRun:false \u624D\u771F\u6B63\u6E05\u7406\uFF09\u3002"
  ];
  return lines.join("\n");
}

// src/client/index.ts
var React = require("react");
var name = "iterate-plugin";
var inject = ["slots", "theme"];
var PLUGIN_TAG = "iterate-ui";
var TRIAGE_STORAGE_PREFIX = "iterate.triage.";
var THEME_STORAGE_KEY = "iterate.theme.enabled";
var THEME_SOURCE = "iterate";
var ITERATE_TOKENS = {
  "--dsw-alias-bg-base": { light: "#FAF8F5", dark: "#171412" },
  "--dsw-alias-bg-layer-1": { light: "#FFFFFF", dark: "#1F1B17" },
  "--dsw-alias-bg-layer-2": { light: "#F4F1EA", dark: "#27221C" },
  "--dsw-alias-bg-overlay": { light: "rgba(255,255,255,0.96)", dark: "rgba(23,20,18,0.96)" },
  "--dsw-alias-border-l1": { light: "#E8E2D8", dark: "#332C25" },
  "--dsw-alias-border-l2": { light: "#DDD5C9", dark: "#3C342B" },
  "--dsw-alias-brand-primary": { light: "#B45309", dark: "#F59E0B" },
  "--dsw-alias-label-primary": { light: "#1C1917", dark: "#F5F0EA" },
  "--dsw-alias-label-secondary": { light: "#57534E", dark: "#A9A29B" },
  "--dsw-alias-state-error-primary": { light: "#DC2626", dark: "#F87171" },
  "--dsw-alias-state-success-primary": { light: "#15803D", dark: "#4ADE80" },
  "--dsw-alias-state-warn-primary": { light: "#D97706", dark: "#FBBF24" },
  "--dsw-specific-sidebar-fill": { light: "#F5F2EC", dark: "#14110E" }
};
var ITERATE_CSS = `
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

/* Button variants */
.iterate-btn[data-ghost] { background: transparent; }
.iterate-btn[data-danger] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); background: transparent; }
.iterate-btn[data-danger]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.iterate-btn[data-confirm] { border-color: var(--dsw-alias-state-error-primary); color: #FFFFFF; background: var(--dsw-alias-state-error-primary); }

/* Collapsible guide / status code blocks */
.iterate-guide { margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
.iterate-guide-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.iterate-guide-body { padding: 12px 14px; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11.5px; line-height: 1.75; white-space: pre-wrap; color: var(--dsw-alias-label-primary); max-height: 260px; overflow: auto; }
`;
function log(...args) {
  if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error(`[${PLUGIN_TAG}]`, ...args);
  }
}
function createStorage() {
  try {
    const testKey = "__iterate_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return {
      get(key) {
        return window.localStorage.getItem(key);
      },
      set(key, value) {
        window.localStorage.setItem(key, value);
      },
      remove(key) {
        window.localStorage.removeItem(key);
      },
      keys() {
        return Object.keys(window.localStorage);
      }
    };
  } catch {
    const mem = /* @__PURE__ */ new Map();
    return {
      get(key) {
        return mem.has(key) ? mem.get(key) : null;
      },
      set(key, value) {
        mem.set(key, value);
      },
      remove(key) {
        mem.delete(key);
      },
      keys() {
        return [...mem.keys()];
      }
    };
  }
}
function removeStorageByPrefix(prefix) {
  if (!storage) return 0;
  let removed = 0;
  try {
    for (const key of storage.keys()) {
      if (key.startsWith(prefix)) {
        storage.remove(key);
        removed++;
      }
    }
  } catch (err) {
    log("failed to clear storage prefix", prefix, err);
  }
  return removed;
}
function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
    return true;
  }
  return false;
}
var SEVERITY_KEYS = ["critical", "high", "medium", "low"];
function coerceSeverity(severity) {
  return SEVERITY_KEYS.includes(severity ?? "") ? severity : "low";
}
function severityColor(severity) {
  return SEVERITY_COLOR[coerceSeverity(severity)];
}
function severityLabel(severity) {
  return SEVERITY_LABEL[coerceSeverity(severity)];
}
function readSlots(ctx) {
  if (ctx && ctx.slots && typeof ctx.slots.inject === "function" && typeof ctx.slots.register === "function") {
    return ctx.slots;
  }
  const raw = ctx && typeof ctx.get === "function" ? ctx.get("slots", false) : void 0;
  if (raw && typeof raw.inject === "function" && typeof raw.register === "function") {
    return raw;
  }
  return void 0;
}
function readTheme(ctx) {
  if (ctx && ctx.theme && typeof ctx.theme.overrideTokens === "function") {
    return ctx.theme;
  }
  const raw = ctx && typeof ctx.get === "function" ? ctx.get("theme", false) : void 0;
  if (raw && typeof raw.overrideTokens === "function") {
    return raw;
  }
  return void 0;
}
var slotsSvc = void 0;
var themeSvc = void 0;
var storage = null;
var themeDisposer = null;
var themeEnabled = true;
var roundPulseListeners = [];
function emitRoundPulse(round, converged) {
  const payload = { round, converged: converged === true };
  for (const fn of roundPulseListeners.slice()) fn(payload);
}
function applyThemeSkin() {
  if (!themeSvc || typeof themeSvc.overrideTokens !== "function") return;
  clearThemeSkin();
  themeDisposer = themeSvc.overrideTokens(THEME_SOURCE, ITERATE_TOKENS);
}
function clearThemeSkin() {
  if (themeDisposer) {
    try {
      themeDisposer();
    } catch (err) {
      log("theme disposer failed", err);
    }
    themeDisposer = null;
  }
}
function setThemeEnabled(enabled) {
  themeEnabled = enabled;
  if (storage) storage.set(THEME_STORAGE_KEY, enabled ? "1" : "0");
  if (enabled) applyThemeSkin();
  else clearThemeSkin();
}
function latestReport(session) {
  if (!session) return null;
  const raw = scanSessionForReport(session) || findReportInObject(session, void 0, 24);
  return raw ? normalizeReport(raw) : null;
}
function TrendChart({ points }) {
  if (!points || points.length === 0) return null;
  const max = trendMax(points);
  const bars = points.map(
    (p) => React.createElement("div", {
      key: p.round,
      className: "iterate-trend-bar",
      "data-hot": p.count > 0 ? "" : void 0,
      title: `Round ${p.round}\uFF1A${p.count} \u9879`,
      style: { height: `${Math.max(4, Math.round(p.count / max * 24))}px` }
    })
  );
  return React.createElement("div", { className: "iterate-trend", title: "\u5404\u8F6E\u53D1\u73B0\u6570\u91CF\u8D8B\u52BF" }, ...bars);
}
function ConvergenceDashboard(props) {
  const [pulseKey, setPulseKey] = React.useState(0);
  const session = props && props.session ? props.session : null;
  const report = latestReport(session);
  React.useEffect(() => {
    if (!report) return;
    const cur = getCurrentRound(report);
    const conv = report.convergence;
    emitRoundPulse(cur, conv?.converged === true);
    setPulseKey((k) => k + 1);
  }, [report && hashReport(report) + ":" + getCurrentRound(report)]);
  if (!report) return null;
  const round = getCurrentRound(report);
  const total = getTotalRounds(report);
  const progress = computeConvergenceProgress(report);
  const stats = severityStats(report);
  const dims = groupByDimension(report);
  const trend = computeTrendMetrics(report);
  const resumeCount = scanSessionForResume(session);
  const imageCount = countSessionImages(session);
  const resumeChip = resumeCount > 0 ? React.createElement("span", {
    className: "iterate-chip-resume",
    key: "resume",
    title: "\u672C\u6B21\u8FED\u4EE3\u4ECE\u4E0A\u4E00\u6B21\u4E2D\u65AD\u7684\u65AD\u70B9\u7EE7\u7EED\u6267\u884C"
  }, `\u5DF2\u4E2D\u65AD\u6062\u590D \xD7${String(resumeCount)}`) : null;
  const imageChip = imageCount > 0 ? React.createElement("span", {
    className: "iterate-chip-images",
    key: "images",
    title: "\u4F1A\u8BDD\u4E2D\u68C0\u6D4B\u5230\u7528\u6237\u9644\u5E26\u7684\u56FE\u7247\uFF0C\u8BC4\u5BA1\u5C06\u4F5C\u4E3A\u89C6\u89C9\u8BC1\u636E\u53C2\u8003"
  }, `\u9644\u4EF6\u56FE\u7247 ${String(imageCount)}`) : null;
  const dimBadges = Object.keys(dims).slice(0, 6).map(
    (dim) => React.createElement(
      "span",
      { key: dim, className: "iterate-dim-badge" },
      `${dim} \xB7 ${dims[dim]?.length ?? 0}`
    )
  );
  const mode = report.mode;
  const summary = report.summary;
  const isNormal = mode === "normal";
  const fixCount = isNormal && summary && typeof summary.fixedCount === "number" ? summary.fixedCount : null;
  const fixBadge = fixCount !== null ? React.createElement("span", {
    className: "iterate-metric",
    key: "fixes",
    title: "\u672C\u8F6E\u5DF2\u5E94\u7528\u7684\u539F\u5B50\u4FEE\u590D\u6570\uFF08\u6B63\u5E38\u6A21\u5F0F\uFF09"
  }, `${String(fixCount)} fixes`) : null;
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "dashboard", className: "iterate-dashboard" },
    React.createElement(
      "span",
      { className: "iterate-round-badge", "data-pulse": pulseKey > 0 ? "" : void 0, key: `round-${round}` },
      `Round ${round} / ${total}`
    ),
    React.createElement(
      "div",
      { className: "iterate-progress" },
      React.createElement("div", { className: "iterate-progress-fill", style: { width: `${progress}%` } })
    ),
    React.createElement(
      "span",
      { className: "iterate-metric" },
      React.createElement("span", { className: "iterate-sev-dot", style: { background: SEVERITY_COLOR.critical } }),
      stats.critical
    ),
    React.createElement(
      "span",
      { className: "iterate-metric" },
      React.createElement("span", { className: "iterate-sev-dot", style: { background: SEVERITY_COLOR.high } }),
      stats.high
    ),
    React.createElement(
      "span",
      { className: "iterate-metric" },
      React.createElement("span", { className: "iterate-sev-dot", style: { background: SEVERITY_COLOR.medium } }),
      stats.medium
    ),
    fixBadge,
    resumeChip,
    imageChip,
    React.createElement(TrendChart, { points: trend.points }),
    ...dimBadges
  );
}
function StatsCard(props) {
  const report = props.report;
  const [showHistory, setShowHistory] = React.useState(false);
  const stats = severityStats(report);
  const total = stats.critical + stats.high + stats.medium + stats.low;
  const rows = [
    { label: "Critical", value: stats.critical, color: SEVERITY_COLOR.critical },
    { label: "High", value: stats.high, color: SEVERITY_COLOR.high },
    { label: "Medium", value: stats.medium, color: SEVERITY_COLOR.medium },
    { label: "Low", value: stats.low, color: SEVERITY_COLOR.low }
  ].map(
    (r) => React.createElement(
      "div",
      { key: r.label, className: "iterate-stat" },
      React.createElement("div", { className: "iterate-stat-num", style: { color: r.color } }, String(r.value)),
      React.createElement("div", { className: "iterate-stat-label" }, r.label)
    )
  );
  const history = buildRoundHistory(report);
  const trend = computeTrendMetrics(report);
  const historyRows = history.map(
    (h) => React.createElement(
      "tr",
      { key: h.round },
      React.createElement("td", { className: "iterate-history-num" }, `Round ${h.round}`),
      React.createElement("td", {}, String(h.count)),
      React.createElement("td", { style: { color: SEVERITY_COLOR.critical } }, String(h.critical)),
      React.createElement("td", { style: { color: SEVERITY_COLOR.high } }, String(h.high)),
      React.createElement("td", { style: { color: SEVERITY_COLOR.medium } }, String(h.medium)),
      React.createElement("td", { style: { color: SEVERITY_COLOR.low } }, String(h.low))
    )
  );
  const trendLine = `\u9996\u8F6E ${trend.firstRound} \u2192 \u672B\u8F6E ${trend.lastRound} \u9879\uFF0C\u964D\u5E45 ${trend.reductionPercent}%${trend.converged ? "\uFF0C\u5DF2\u6536\u655B" : ""}`;
  const completion = buildCompletionSummary(report);
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "stats", className: "iterate-stats" },
    React.createElement(
      "div",
      { className: "iterate-triage-head" },
      React.createElement("span", {}, "Iterate \xB7 \u6536\u655B\u7EDF\u8BA1"),
      React.createElement(
        "span",
        { className: "iterate-triage-hint" },
        `Round ${getCurrentRound(report)}/${getTotalRounds(report)} \xB7 ${total} findings \xB7 ${report.convergence && report.convergence.converged ? "\u5DF2\u6536\u655B" : "\u672A\u6536\u655B"}`
      )
    ),
    React.createElement("div", { className: "iterate-stats-grid" }, ...rows),
    React.createElement("div", { className: "iterate-completion", "data-ok": trend.converged ? "" : void 0, "data-warn": trend.converged ? void 0 : "" }, completion),
    React.createElement(
      "div",
      { className: "iterate-triage-foot", style: { marginTop: 8, borderRadius: 8 } },
      React.createElement("span", {}, trendLine),
      React.createElement("button", {
        className: "iterate-btn",
        "data-primary": showHistory ? "" : void 0,
        onClick: () => setShowHistory((v) => !v)
      }, showHistory ? "\u6536\u8D77\u5386\u53F2" : "\u5386\u53F2 / \u8D8B\u52BF")
    ),
    showHistory ? React.createElement(
      "div",
      { className: "iterate-history-body" },
      React.createElement(
        "table",
        { className: "iterate-history-table" },
        React.createElement(
          "thead",
          {},
          React.createElement(
            "tr",
            {},
            React.createElement("th", {}, "\u8F6E\u6B21"),
            React.createElement("th", {}, "\u53D1\u73B0"),
            React.createElement("th", { style: { color: SEVERITY_COLOR.critical } }, "CRIT"),
            React.createElement("th", { style: { color: SEVERITY_COLOR.high } }, "HIGH"),
            React.createElement("th", { style: { color: SEVERITY_COLOR.medium } }, "MED"),
            React.createElement("th", { style: { color: SEVERITY_COLOR.low } }, "LOW")
          )
        ),
        React.createElement("tbody", {}, ...historyRows)
      ),
      React.createElement(
        "div",
        { className: "iterate-history-trendline" },
        React.createElement(TrendChart, { points: trend.points })
      )
    ) : null
  );
}
function TriagePanel(props) {
  const report = props.report;
  const findings = report.findings || [];
  const storageKey = TRIAGE_STORAGE_PREFIX + hashReport(report);
  const [verdicts, setVerdicts] = React.useState(() => {
    const initial = buildTriageState(report);
    const saved = storage ? storage.get(storageKey) : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          for (const key of Object.keys(initial)) {
            if (parsed[key] === "keep" || parsed[key] === "skip" || parsed[key] === "ignore") {
              initial[key] = parsed[key];
            }
          }
        }
      } catch {
      }
    }
    return initial;
  });
  const [payload, setPayload] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [filter, setFilter] = React.useState({ severities: [], dimensions: [], search: "" });
  const [selected, setSelected] = React.useState(null);
  const [selectAll, setSelectAll] = React.useState(false);
  const persistVerdicts = (next) => {
    if (storage) storage.set(storageKey, JSON.stringify(next));
    return next;
  };
  const setVerdict = (index, verdict) => {
    setVerdicts((prev) => persistVerdicts({ ...prev, [String(index)]: verdict }));
  };
  const { filtered, indices } = filterFindingsWithIndices(findings, filter);
  const indicesKey = indices.join(",");
  const options = buildFilterOptions(findings);
  const isFilterActive = filter.severities.length > 0 || filter.dimensions.length > 0 || filter.search !== "";
  const setSeverityFilter = (value) => setFilter((f) => ({ ...f, severities: value ? [value] : [] }));
  const setDimensionFilter = (value) => setFilter((f) => ({ ...f, dimensions: value ? [value] : [] }));
  const setSearchFilter = (value) => setFilter((f) => ({ ...f, search: value }));
  const clearFilter = () => setFilter({ severities: [], dimensions: [], search: "" });
  const allIndices = allVerdictKeys(verdicts);
  const batchTarget = selectAll ? allIndices : indices;
  const applyBatch = (verdict) => {
    setVerdicts((prev) => persistVerdicts(batchSetVerdict(prev, batchTarget, verdict)));
  };
  const applyBatchAll = (verdict) => {
    setVerdicts((prev) => persistVerdicts(setAllVerdicts(prev, verdict)));
  };
  const doResetVerdicts = () => {
    setVerdicts((prev) => persistVerdicts(setAllVerdicts(prev, "keep")));
    setSelectAll(false);
  };
  React.useEffect(() => {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return;
    const onKeyDown = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const verdict = keyToVerdict(ev.key);
      if (verdict && selected !== null && indices.includes(selected)) {
        ev.preventDefault();
        setVerdict(selected, verdict);
        const pos = indices.indexOf(selected);
        const nextIdx = indices[pos + 1];
        if (nextIdx !== void 0) setSelected(nextIdx);
        return;
      }
      if (ev.key === "ArrowDown" && indices.length > 0) {
        ev.preventDefault();
        const pos = selected === null ? -1 : indices.indexOf(selected);
        setSelected(indices[Math.min(pos + 1, indices.length - 1)] ?? null);
        return;
      }
      if (ev.key === "ArrowUp" && indices.length > 0) {
        ev.preventDefault();
        const pos = selected === null ? 0 : indices.indexOf(selected);
        setSelected(indices[Math.max(pos - 1, 0)] ?? null);
      }
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [selected, indicesKey]);
  const ignored = collectIgnoredEntries(verdicts, findings);
  const ignoredCount = ignored.length;
  const counts = countVerdicts(verdicts);
  const doCopyYaml = () => {
    const yaml = toKnownIntentionalYaml(ignored);
    if (!yaml) return;
    const ok = copyText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    if (!ok) setPayload(yaml);
  };
  const doBuildInstruction = () => {
    const text = buildApplyInstruction(ignored);
    setPayload(text);
    if (text) copyText(text);
  };
  const rows = filtered.map((finding, i) => {
    const index = indices[i];
    const severity = finding.severity || "low";
    const verdict = verdicts[String(index)] || "keep";
    const isSelected = selected === index;
    const btn = (label, value, title) => React.createElement(
      "button",
      {
        key: value,
        className: "iterate-vbtn",
        "data-active": verdict === value ? value : void 0,
        title,
        onClick: () => setVerdict(index, value)
      },
      label
    );
    return React.createElement(
      "div",
      {
        key: String(index),
        className: "iterate-finding",
        "data-selected": isSelected ? "" : void 0,
        onClick: () => setSelected(index)
      },
      React.createElement(
        "div",
        { className: "iterate-finding-meta" },
        React.createElement("span", { className: "iterate-sev-dot", style: { background: severityColor(severity) } }),
        React.createElement("span", {}, severityLabel(severity)),
        React.createElement("span", { className: "iterate-finding-file" }, String(finding.file || "?")),
        finding.line ? React.createElement("span", {}, `:${finding.line}`) : null,
        React.createElement("span", {}, String(finding.dimension || ""))
      ),
      React.createElement("div", { className: "iterate-finding-summary" }, String(finding.summary || "")),
      React.createElement(
        "div",
        { className: "iterate-finding-actions" },
        btn("y \u4FEE\u590D", "keep", "\u4FDD\u7559\u8BE5 finding\uFF0C\u8FDB\u5165\u4FEE\u590D"),
        btn("n \u8DF3\u8FC7", "skip", "\u8DF3\u8FC7\u8BE5 finding"),
        btn("a \u5DF2\u77E5\u6709\u610F", "ignore", "\u6807\u8BB0\u4E3A\u5DF2\u77E5\u6709\u610F\u5E76\u5199\u5165 known_intentional")
      )
    );
  });
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "triage", className: "iterate-triage" },
    React.createElement(
      "div",
      { className: "iterate-triage-head" },
      React.createElement("span", {}, `Iterate \xB7 Findings \u5206\u8BCA (${filtered.length}/${findings.length})`),
      React.createElement("span", { className: "iterate-triage-hint" }, "y=\u4FEE\u590D \xB7 n=\u8DF3\u8FC7 \xB7 a=\u5DF2\u77E5\u6709\u610F \xB7 \u2191/\u2193 \u9009\u62E9")
    ),
    React.createElement(
      "div",
      { className: "iterate-filter" },
      React.createElement(
        "select",
        { className: "iterate-filter-select", value: filter.severities[0] || "", onChange: (e) => setSeverityFilter(e.target.value), title: "\u6309\u4E25\u91CD\u5EA6\u7B5B\u9009" },
        React.createElement("option", { value: "" }, "\u5168\u90E8\u4E25\u91CD\u5EA6"),
        ...options.severities.map(
          (s) => React.createElement("option", { key: s.value, value: s.value }, `${severityLabel(s.value)} (${s.count})`)
        )
      ),
      React.createElement(
        "select",
        { className: "iterate-filter-select", value: filter.dimensions[0] || "", onChange: (e) => setDimensionFilter(e.target.value), title: "\u6309\u7EF4\u5EA6\u7B5B\u9009" },
        React.createElement("option", { value: "" }, "\u5168\u90E8\u7EF4\u5EA6"),
        ...options.dimensions.map(
          (d) => React.createElement("option", { key: d.value, value: d.value }, `${d.value} (${d.count})`)
        )
      ),
      React.createElement("input", {
        className: "iterate-filter-search",
        type: "search",
        placeholder: "\u641C\u7D22\u6587\u4EF6 / \u6458\u8981\u2026",
        value: filter.search,
        onChange: (e) => setSearchFilter(e.target.value)
      }),
      React.createElement(
        "span",
        { className: "iterate-filter-count" },
        isFilterActive ? React.createElement("button", { className: "iterate-batch-btn", onClick: clearFilter }, `\u6E05\u9664\u7B5B\u9009\uFF08\u663E\u793A ${filtered.length}\uFF09`) : `\u5171 ${findings.length} \u9879`
      )
    ),
    React.createElement(
      "div",
      { className: "iterate-batch" },
      React.createElement("span", { className: "iterate-batch-label" }, "\u6279\u91CF\uFF1A"),
      React.createElement(
        "label",
        { className: "iterate-batch-check", title: "\u52FE\u9009\u540E\u6279\u91CF\u6309\u94AE\u4F5C\u7528\u4E8E\u5168\u90E8 findings\uFF0C\u5426\u5219\u4EC5\u5F53\u524D\u53EF\u89C1" },
        React.createElement("input", { type: "checkbox", checked: selectAll, onChange: (e) => setSelectAll(e.target.checked) }),
        selectAll ? `\u5168\u90E8 ${allIndices.length}` : "\u5168\u9009"
      ),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("keep") }, "\u5168\u90E8 y"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("skip") }, "\u5168\u90E8 n"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("ignore") }, "\u5168\u90E8 a"),
      React.createElement("span", { className: "iterate-batch-label", style: { marginLeft: 8 } }, "\u5168\u90E8\uFF1A"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatchAll("keep") }, "y"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatchAll("skip") }, "n"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatchAll("ignore") }, "a"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: doResetVerdicts, title: "\u628A\u6240\u6709\u5224\u5B9A\u6062\u590D\u4E3A\u9ED8\u8BA4 y\uFF08\u4FEE\u590D\uFF09" }, "\u91CD\u7F6E")
    ),
    ...rows,
    React.createElement(
      "div",
      { className: "iterate-triage-foot" },
      React.createElement("span", {}, `y ${counts.keep} \xB7 n ${counts.skip} \xB7 a ${counts.ignore} \xB7 \u5F85\u5199\u56DE known_intentional\uFF1A${ignoredCount} \u6761`),
      React.createElement(
        "span",
        { style: { display: "flex", gap: 6 } },
        React.createElement("button", { className: "iterate-btn", "data-primary": "", "data-copied": copied ? "" : void 0, onClick: doCopyYaml }, copied ? "\u5DF2\u590D\u5236" : "\u590D\u5236 known_intentional"),
        React.createElement("button", { className: "iterate-btn", onClick: doBuildInstruction }, "\u751F\u6210\u5E94\u7528\u6307\u4EE4")
      )
    ),
    payload ? React.createElement("div", { className: "iterate-payload" }, payload) : null
  );
}
function VerdictBanner(props) {
  const verdict = props.verdict;
  if (!verdict) return null;
  const ok = verdict.verdict === "approved";
  const item = (num, unit) => React.createElement(
    "span",
    { className: "iterate-verdict-item" },
    React.createElement("b", {}, String(num)),
    ` ${unit}`
  );
  const phrase = (text) => React.createElement("span", { className: "iterate-verdict-item" }, text);
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "verdict", className: "iterate-verdict" },
    React.createElement(
      "span",
      { className: "iterate-verdict-tag", "data-ok": ok ? "" : void 0, "data-warn": ok ? void 0 : "" },
      ok ? "\u62A5\u544A\u5DF2\u6279\u51C6" : "\u62A5\u544A\u9700\u4FEE\u8BA2"
    ),
    React.createElement(
      "span",
      { className: "iterate-verdict-detail" },
      item(verdict.totalFindings, "\u9879\u53D1\u73B0"),
      item(verdict.totalRounds, "\u8F6E"),
      item(verdict.checksRun, "\u9879\u5BA1\u67E5"),
      ok ? phrase("\u62A5\u544A\u901A\u8FC7\u5168\u90E8\u4E00\u81F4\u6027\u68C0\u67E5") : item(verdict.reportIssues, "\u5904\u62A5\u544A\u7F3A\u9677"),
      phrase(verdict.converged ? "\u5DF2\u6536\u655B" : "\u672A\u6536\u655B")
    )
  );
}
function TurnTailEntry(props) {
  const candidates = [];
  if (props && props.turn) candidates.push(props.turn);
  if (props && props.matched) candidates.push(props.matched);
  if (props && props.data) candidates.push(props.data);
  candidates.push(props);
  let verdict = null;
  for (const c of candidates) {
    const run = scanSessionForRunSummary(c);
    if (run) {
      verdict = extractVerdict(run);
      break;
    }
  }
  let report = null;
  for (const c of candidates) {
    const raw = findReportInObject(c, void 0, 24) || scanSessionForReport(c);
    if (raw) {
      report = normalizeReport(raw);
      break;
    }
  }
  const blocks = [];
  if (verdict) blocks.push(React.createElement(VerdictBanner, { key: "verdict", verdict }));
  if (report) {
    const panel = !report.findings || report.findings.length === 0 ? React.createElement(StatsCard, { report }) : React.createElement(TriagePanel, { report });
    blocks.push(React.createElement("div", { key: "report" }, panel));
  }
  if (blocks.length === 0) return null;
  return React.createElement("div", { "data-iterate-root": "", className: "iterate-turn-tail-root" }, ...blocks);
}
function ProgressCapsule() {
  const [info, setInfo] = React.useState(null);
  React.useEffect(() => {
    let timer = null;
    const listener = (payload) => {
      const converged = payload && payload.converged === true;
      const round = payload && typeof payload.round === "number" ? payload.round : "?";
      setInfo({ text: converged ? `Round ${round} \u5B8C\u6210 \xB7 \u5DF2\u6536\u655B` : `Round ${round} \u5B8C\u6210`, ok: converged });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setInfo(null), converged ? 3600 : 2400);
    };
    roundPulseListeners.push(listener);
    return () => {
      const i = roundPulseListeners.indexOf(listener);
      if (i >= 0) roundPulseListeners.splice(i, 1);
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!info) return null;
  return React.createElement("div", { "data-iterate-root": "", className: "iterate-capsule", "data-ok": info.ok ? "" : void 0 }, info.text);
}
function SettingsPanel(_props) {
  const [enabled, setEnabled] = React.useState(themeEnabled);
  const [guideCopied, setGuideCopied] = React.useState(false);
  const [statusCopied, setStatusCopied] = React.useState(false);
  const [showGuide, setShowGuide] = React.useState(false);
  const [showStatus, setShowStatus] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [clearedInfo, setClearedInfo] = React.useState(null);
  const guide = buildConfigEditGuide();
  const statusGuide = buildRuntimeStatusGuide();
  const toggleTheme = () => {
    const next = !enabled;
    setEnabled(next);
    setThemeEnabled(next);
  };
  const flashCopied = (slot) => {
    const setter = slot === "guide" ? setGuideCopied : setStatusCopied;
    setter(true);
    setTimeout(() => setter(false), 1600);
  };
  const doCopy = (text, slot) => {
    copyText(text);
    flashCopied(slot);
  };
  const requestClear = () => {
    if (confirming) {
      const count = removeStorageByPrefix(TRIAGE_STORAGE_PREFIX);
      setClearedInfo(count);
      setConfirming(false);
      setTimeout(() => setClearedInfo(null), 3e3);
      return;
    }
    setConfirming(true);
    setTimeout(() => setConfirming(false), 3e3);
  };
  const clearButton = clearedInfo !== null ? React.createElement("button", { className: "iterate-btn", "data-copied": "", disabled: true }, `\u5DF2\u6E05\u9664 ${clearedInfo} \u6761`) : React.createElement("button", {
    className: "iterate-btn",
    "data-danger": confirming ? void 0 : "",
    "data-confirm": confirming ? "" : void 0,
    onClick: requestClear,
    title: confirming ? "\u518D\u6B21\u70B9\u51FB\u4EE5\u786E\u8BA4\u6E05\u9664\u5168\u90E8\u5224\u5B9A" : "\u6E05\u9664\u6240\u6709\u5206\u8BCA\u5224\u5B9A\u8BB0\u5F55\uFF08\u9700\u8981\u4E8C\u6B21\u786E\u8BA4\uFF09"
  }, confirming ? "\u786E\u8BA4\u6E05\u9664\uFF1F" : "\u6E05\u9664\u5206\u8BCA");
  const themeCard = React.createElement(
    "div",
    { key: "theme", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, "\u8FED\u4EE3\u4E3B\u9898"),
        React.createElement("div", { className: "iterate-settings-desc" }, "\u542F\u7528\u6696\u7425\u73C0\u914D\u8272\u7684 iterate \u4E13\u5C5E\u76AE\u80A4\uFF0C\u8986\u76D6 dsh \u9ED8\u8BA4\u4E3B\u9898\u4EE4\u724C\u3002")
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("span", { className: "iterate-chip", "data-ok": enabled ? "" : void 0 }, enabled ? "\u5DF2\u542F\u7528" : "\u5DF2\u5173\u95ED"),
        React.createElement("button", {
          role: "switch",
          "aria-checked": enabled,
          "aria-label": "\u5F00\u5173 iterate \u4E3B\u9898",
          className: "iterate-switch",
          "data-on": enabled ? "" : void 0,
          onClick: toggleTheme
        }, React.createElement("span", { className: "iterate-switch-knob" }))
      )
    )
  );
  const dataCard = React.createElement(
    "div",
    { key: "data", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, "\u5206\u8BCA\u6301\u4E45\u5316"),
        React.createElement("div", { className: "iterate-settings-desc" }, "y / n / a \u5224\u5B9A\u4FDD\u5B58\u5728\u672C\u5730\u6D4F\u89C8\u5668\uFF08localStorage\uFF09\uFF0C\u5237\u65B0\u4F1A\u8BDD\u540E\u4ECD\u4FDD\u7559\u3002")
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("span", { className: "iterate-chip" }, "\u672C\u5730\u4FDD\u5B58"),
        clearButton
      )
    )
  );
  const guideCard = React.createElement(
    "div",
    { key: "guide", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, "\u914D\u7F6E\u7BA1\u7406"),
        React.createElement("div", { className: "iterate-settings-desc" }, "\u76EE\u6807 / \u7EF4\u5EA6 / \u6700\u5927\u8F6E\u6570\u5199\u5728\u9879\u76EE\u7684 iterate.config.yaml\uFF0C\u590D\u5236\u6307\u5F15\u53EF\u8BA9\u6A21\u578B\u6309\u9700\u8C03\u6574\u3002")
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("button", { className: "iterate-btn", "data-primary": "", "data-copied": guideCopied ? "" : void 0, onClick: () => doCopy(guide, "guide") }, guideCopied ? "\u5DF2\u590D\u5236" : "\u590D\u5236\u6307\u5F15"),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => setShowGuide((v) => !v) }, showGuide ? "\u6536\u8D77" : "\u5C55\u5F00")
      )
    ),
    showGuide ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, "iterate.config.yaml \u53EF\u7F16\u8F91\u5B57\u6BB5"),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(guide, "guide") }, "\u590D\u5236")
      ),
      React.createElement("div", { className: "iterate-guide-body" }, guide)
    ) : null
  );
  const statusCard = React.createElement(
    "div",
    { key: "status", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, "\u72B6\u6001\u6982\u89C8"),
        React.createElement("div", { className: "iterate-settings-desc" }, "\u67E5\u770B\u8FD0\u884C\u65F6\u4EA7\u7269\u5E03\u5C40\u4E0E\u6E05\u7406\u6307\u5F15\u3002iterate_status / iterate_history / iterate_prune \u5DE5\u5177\u7528\u4E8E\u67E5\u770B\u548C\u7BA1\u7406\u3002")
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("button", { className: "iterate-btn", "data-primary": "", "data-copied": statusCopied ? "" : void 0, onClick: () => doCopy(statusGuide, "status") }, statusCopied ? "\u5DF2\u590D\u5236" : "\u590D\u5236\u6307\u5F15"),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => setShowStatus((v) => !v) }, showStatus ? "\u6536\u8D77" : "\u5C55\u5F00")
      )
    ),
    showStatus ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, "\u8FD0\u884C\u65F6\u5E03\u5C40\u4E0E\u6E05\u7406"),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(statusGuide, "status") }, "\u590D\u5236")
      ),
      React.createElement("div", { className: "iterate-guide-body" }, statusGuide)
    ) : null
  );
  const banner = React.createElement(
    "div",
    { key: "banner", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, "iterate"),
        React.createElement("div", { className: "iterate-settings-desc" }, "\u4E3A\u6BCF\u6B21\u4EE3\u7801\u8BC4\u5BA1\u751F\u6210 Review \u62A5\u544A\u4E0E\u4EA4\u4E92\u5F0F\u5206\u8BCA\u89C6\u56FE\uFF0C\u4E13\u6CE8 AI \u81EA\u6211\u5BA1\u67E5\u4E0E\u4FEE\u6B63\u3002")
      ),
      React.createElement(
        "span",
        { className: "iterate-pill" },
        React.createElement("span", { className: "iterate-pill-dot" }),
        "\u5C31\u7EEA"
      )
    )
  );
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "settings", className: "iterate-settings" },
    React.createElement("div", { className: "iterate-settings-title", style: { fontSize: 15, fontWeight: 700 } }, "iterate \u8BBE\u7F6E"),
    banner,
    themeCard,
    dataCard,
    guideCard,
    statusCard
  );
}
function selectTurnTail(owner) {
  if (!owner) return null;
  if (findReportInObject(owner.turn, void 0, 24) || scanSessionForReport(owner.turn)) return { matched: true };
  if (scanSessionForRunSummary(owner.turn)) return { matched: true };
  return null;
}
function apply(ctx) {
  slotsSvc = readSlots(ctx);
  themeSvc = readTheme(ctx);
  storage = createStorage();
  const savedTheme = storage.get(THEME_STORAGE_KEY);
  themeEnabled = savedTheme === null ? true : savedTheme === "1";
  if (themeEnabled) applyThemeSkin();
  if (typeof document !== "undefined" && document.createElement && document.head) {
    const style = document.createElement("style");
    style.dataset.plugin = PLUGIN_TAG;
    style.dataset.pluginCss = "iterate-main";
    style.textContent = ITERATE_CSS;
    document.head.appendChild(style);
    if (typeof ctx.effect === "function") {
      ctx.effect(() => {
        try {
          style.remove();
        } catch {
        }
      });
    }
  }
  if (slotsSvc === void 0) {
    log("slots service unavailable \u2014 slot UI disabled");
    return;
  }
  if (typeof slotsSvc.inject === "function") {
    slotsSvc.inject(
      "conversation.input.dock",
      () => slotsSvc?.register(
        { name: "conversation.input.dock", id: "iterate-dashboard", order: 90 },
        (props) => React.createElement(ConvergenceDashboard, props)
      )
    );
    slotsSvc.inject(
      "conversation.chat.turnTail",
      () => slotsSvc?.register(
        { name: "conversation.chat.turnTail", id: "iterate-turn-tail", select: selectTurnTail },
        (props) => React.createElement(TurnTailEntry, props)
      )
    );
    slotsSvc.inject(
      "shell.overlay",
      () => slotsSvc?.register(
        { name: "shell.overlay", id: "iterate-progress", order: 0 },
        (props) => React.createElement(ProgressCapsule, props)
      )
    );
    slotsSvc.inject(
      "settings.section",
      () => slotsSvc?.register(
        { name: "settings.section", id: "iterate-settings", order: 30, label: () => "iterate" },
        (props) => React.createElement(SettingsPanel, props)
      )
    );
  }
  if (typeof ctx.on === "function") {
    ctx.on("theme/change", () => {
      if (themeEnabled) applyThemeSkin();
    });
  }
}
return module.exports; } });

