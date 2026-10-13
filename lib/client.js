/* iterate-plugin client source-digest: 7da1ef5af84458a763f4b0ad8cd75ba2de3fb16b9831e00c0a9767bc16fece65 */
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
  // medium is used both for dots/fills and as TEXT (stat numbers, table
  // headers); #eab308 is illegible as text on light backgrounds (~1.6:1).
  // amber-600 (#d97706) ~3.2:1 — still short of AA; go darker for legibility.
  medium: "#b45309",
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
function coerceJsonNode(v) {
  if (typeof v !== "string") return v;
  const t2 = v.trim();
  if (!t2.startsWith("{") && !t2.startsWith("[")) return v;
  try {
    return JSON.parse(t2);
  } catch {
    return v;
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
  const consumed = /* @__PURE__ */ new Set();
  let count = 0;
  const walk = (obj, depth) => {
    if (depth <= 0 || !obj || typeof obj !== "object") return;
    if (seen.has(obj) || consumed.has(obj)) return;
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
      consumed.add(ref);
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
  if (!convergence || typeof convergence !== "object" || Array.isArray(convergence)) return false;
  return Array.isArray(safeGet(o, "findings")) && Array.isArray(safeGet(o, "rounds"));
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
        const result = coerceJsonNode(safeGet(call, "result"));
        if (result && typeof result === "object") {
          const r = (
            /** @type {Record<string, unknown>} */
            result
          );
          const report = safeGet(r, "report");
          if (isReviewReport(report)) return report;
          const found = findReportInObject(result);
          if (found) return found;
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
      for (let j = calls.length - 1; j >= 0; j--) {
        const call = calls[j];
        if (!call) continue;
        const callName = String(safeGet(call, "name") ?? safeGet(call, "tool") ?? "");
        if (callName === "iterate_review" || callName.endsWith("iterate_review")) {
          for (const key of ["result", "response", "message"]) {
            const node = coerceJsonNode(safeGet(call, key));
            if (!node || typeof node !== "object") continue;
            const r = (
              /** @type {Record<string, unknown>} */
              node
            );
            const report = safeGet(r, "report");
            if (isReviewReport(report)) return report;
            const found = findReportInObject(node);
            if (found) return found;
          }
        }
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
function isTranscriptManifest(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  return typeof safeGet(o, "version") === "number" && Array.isArray(safeGet(o, "rounds")) && Array.isArray(safeGet(o, "convergence"));
}
function attachLive(manifest, source) {
  if (!manifest || typeof manifest !== "object") return manifest;
  const live = source && typeof source === "object" ? safeGet(source, "live") : void 0;
  if (!Array.isArray(live)) return manifest;
  const m = (
    /** @type {Record<string, unknown>} */
    manifest
  );
  if (safeGet(m, "live") !== void 0) return manifest;
  const copy = (
    /** @type {Record<string, unknown>} */
    {}
  );
  for (const k of safeKeys(m)) copy[k] = safeGet(m, k);
  copy.live = live;
  return copy;
}
function extractTranscript(obj, seen, depth) {
  if (depth === void 0) depth = 0;
  if (depth > 20) return null;
  if (typeof obj === "string") {
    try {
      const parsed = JSON.parse(obj);
      return extractTranscript(parsed, seen, depth + 1);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  if (!seen) seen = /* @__PURE__ */ new Set();
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (isTranscriptManifest(obj)) return (
    /** @type {Record<string, unknown>} */
    obj
  );
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  if (safeGet(o, "operation") === "capture") {
    const t2 = safeGet(o, "transcript");
    if (t2 && typeof t2 === "object" && isTranscriptManifest(t2)) {
      return attachLive(
        /** @type {Record<string, unknown>} */
        t2,
        o
      );
    }
  }
  for (const key of ["message", "result", "content"]) {
    const val = safeGet(o, key);
    if (val !== void 0) {
      if (Array.isArray(val)) {
        for (const item of val) {
          const found = extractTranscript(item, seen, depth + 1);
          if (found) return attachLive(found, o);
        }
      } else {
        const found = extractTranscript(val, seen, depth + 1);
        if (found) return attachLive(found, o);
      }
    }
  }
  return attachLive(findTranscriptInObject(o), o);
}
function findTranscriptInObject(obj, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null;
  if (!obj || typeof obj !== "object") return null;
  const s = seen || /* @__PURE__ */ new Set();
  if (s.has(obj)) return null;
  s.add(obj);
  if (isTranscriptManifest(obj)) return (
    /** @type {Record<string, unknown>} */
    obj
  );
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findTranscriptInObject(item, s, maxDepth - 1);
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
      const found = findTranscriptInObject(val, s, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}
function scanSessionForTranscript(session) {
  if (!session || typeof session !== "object") return null;
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
      const tool = String(safeGet(call, "tool") ?? "");
      if (tool !== "iterate_transcript" && !tool.endsWith("iterate_transcript")) continue;
      const found = extractTranscript(safeGet(call, "result")) || extractTranscript(safeGet(call, "message"));
      if (found) return found;
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
      const calls = safeGet(msg, "tool_calls");
      if (Array.isArray(calls)) {
        const callList = (
          /** @type {Array<Record<string, unknown>>} */
          calls
        );
        for (let j = callList.length - 1; j >= 0; j--) {
          const call = callList[j];
          if (!call) continue;
          const fn = safeGet(call, "function");
          const candidates = [
            // Result surface first: `{ name|tool, result }` message tool calls
            // (the same shape scanSessionForQualityGate already accepts).
            safeGet(call, "result"),
            safeGet(call, "response"),
            safeGet(call, "message"),
            safeGet(call, "arguments"),
            fn && typeof fn === "object" ? safeGet(
              /** @type {Record<string, unknown>} */
              fn,
              "arguments"
            ) : void 0
          ];
          for (const args of candidates) {
            if (args === void 0 || args === null) continue;
            const found2 = extractTranscript(args);
            if (found2) return found2;
          }
        }
      }
      const found = extractTranscript(safeGet(msg, "content"));
      if (found) return found;
    }
  }
  const loose = findFirstInObject(session, isTranscriptManifest);
  return loose ? (
    /** @type {Record<string, unknown>} */
    loose
  ) : null;
}
function normalizeValidations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (
    const v of
    /** @type {unknown[]} */
    raw
  ) {
    if (!v || typeof v !== "object") continue;
    const rec = (
      /** @type {Record<string, unknown>} */
      v
    );
    const roundRaw = Number(rec.round);
    const exitRaw = rec.exitCode;
    const command = typeof rec.command === "string" ? rec.command : String(rec.command ?? "");
    if (!command) continue;
    const rejectReason = typeof rec.rejectReason === "string" ? rec.rejectReason : "";
    out.push({
      round: Number.isFinite(roundRaw) && roundRaw > 0 ? Math.floor(roundRaw) : 0,
      command,
      exitCode: typeof exitRaw === "number" && Number.isFinite(exitRaw) ? exitRaw : null,
      allowed: rec.allowed === true,
      ...rejectReason ? { rejectReason } : {}
    });
  }
  return out;
}
function normalizeTranscript(manifest) {
  const src = manifest && typeof manifest === "object" ? (
    /** @type {Record<string, unknown>} */
    manifest
  ) : {};
  const asNum = (v) => typeof v === "number" ? v : 0;
  const asStr = (v) => typeof v === "string" ? v : "";
  const asBool = (v) => v === true;
  const asCount = (v) => typeof v === "number" ? v : 0;
  const asArray = (v) => Array.isArray(v) ? (
    /** @type {Array<Record<string, unknown>>} */
    v
  ) : [];
  const rounds = asArray(safeGet(src, "rounds")).map((r) => ({
    round: asNum(safeGet(r, "round")),
    threads: asArray(safeGet(r, "threads")).map((t2) => ({
      dimension: asStr(safeGet(t2, "dimension")),
      attempt: asNum(safeGet(t2, "attempt")),
      messages: asArray(safeGet(t2, "messages")).map((m) => typeof m === "string" ? m : ""),
      readFiles: asArray(safeGet(t2, "readFiles")).map((f) => typeof f === "string" ? f : ""),
      findings: asArray(safeGet(t2, "findings")).map((f) => ({ ...f }))
    }))
  }));
  const cp = safeGet(src, "checkpoint");
  const checkpoint = cp && typeof cp === "object" ? {
    mode: asStr(safeGet(cp, "mode")),
    round: asNum(safeGet(cp, "round")),
    maxRounds: asNum(safeGet(cp, "maxRounds")),
    fixedCount: asNum(safeGet(cp, "fixedCount")),
    resumeCount: asNum(safeGet(cp, "resumeCount")),
    updatedAt: asStr(safeGet(cp, "updatedAt"))
  } : null;
  const ng = safeGet(src, "nudge");
  const nudge = ng && typeof ng === "object" ? { timestamp: asStr(safeGet(ng, "timestamp")), text: asStr(safeGet(ng, "text")) } : null;
  const ap = safeGet(src, "approval");
  const tm = safeGet(src, "taskMode");
  return {
    version: asNum(safeGet(src, "version")),
    project: asStr(safeGet(src, "project")),
    updatedAt: asStr(safeGet(src, "updatedAt")),
    active: asBool(safeGet(src, "active")),
    mode: asStr(safeGet(src, "mode")) || null,
    // v3.0: harness task_mode (code/iterate), tolerated when absent.
    taskMode: tm === "code" || tm === "iterate" ? tm : null,
    goal: asStr(safeGet(src, "goal")),
    phases: asArray(safeGet(src, "phases")).map((p) => typeof p === "string" ? p : ""),
    round: asNum(safeGet(src, "round")),
    maxRounds: asNum(safeGet(src, "maxRounds")),
    // v3.5: why a FINISHED run stopped (converged / max_rounds_reached /
    // aborted_by_validation / aborted_by_config). Required for the
    // observatory badge to render the stop reason instead of a bare "已结束".
    stoppedReason: src.stoppedReason === null || src.stoppedReason === void 0 ? null : asStr(safeGet(src, "stoppedReason")) || null,
    rounds,
    convergence: asArray(safeGet(src, "convergence")).map((n) => asCount(n)),
    findings: asArray(safeGet(src, "findings")).map((f) => ({ ...f })),
    fixes: asArray(safeGet(src, "fixes")).map((f) => ({ ...f })),
    live: asArray(safeGet(src, "live")).map((e) => ({
      ts: typeof safeGet(e, "ts") === "number" ? String(safeGet(e, "ts")) : asStr(safeGet(e, "ts")),
      type: asStr(safeGet(e, "type")),
      tool: asStr(safeGet(e, "tool")),
      target: asStr(safeGet(e, "target"))
    })),
    checkpoint,
    timeline: asArray(safeGet(src, "timeline")).map((t2) => ({ ...t2 })),
    // #6: per-round validation rows (command / exitCode / allowed), captured
    // by the workflow and persisted through `iterate_transcript capture`.
    validations: normalizeValidations(safeGet(src, "validations")),
    nudge,
    approval: ap && typeof ap === "object" ? { active: asBool(safeGet(ap, "active")), policy: asStr(safeGet(ap, "policy")) || "ask" } : { active: false, policy: "ask" }
  };
}
var DEFENSE_EVENT_TYPES = ["precondition_failed", "rollback", "invariant_violated", "assumption_falsified"];
function isQualityGateSnapshot(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  const status = safeGet(o, "overallStatus");
  return (status === "pass" || status === "fail" || status === "pending") && typeof safeGet(o, "overallScore") === "number" && Array.isArray(safeGet(o, "dimensions"));
}
function isExperienceBankResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  const entry = safeGet(o, "entry");
  return Array.isArray(safeGet(o, "entries")) && typeof safeGet(o, "count") === "number" || !!entry && typeof entry === "object" && typeof safeGet(o, "operation") === "string";
}
function isDefenseEventsResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = (
    /** @type {Record<string, unknown>} */
    obj
  );
  const counts = safeGet(o, "counts");
  return Array.isArray(safeGet(o, "events")) && typeof safeGet(o, "count") === "number" || !!counts && typeof counts === "object" && typeof safeGet(o, "operation") === "string";
}
function findFirstInObject(obj, predicate, seen, maxDepth = 20) {
  if (maxDepth <= 0) return null;
  if (typeof obj === "string") {
    const parsed = coerceJsonNode(obj);
    if (parsed === obj) return null;
    return findFirstInObject(parsed, predicate, seen, maxDepth - 1);
  }
  if (!obj || typeof obj !== "object") return null;
  const s = seen || /* @__PURE__ */ new Set();
  if (s.has(obj)) return null;
  s.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstInObject(item, predicate, s, maxDepth - 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    const o = (
      /** @type {Record<string, unknown>} */
      obj
    );
    if (predicate(o)) return o;
    for (const key of safeKeys(o)) {
      const val = safeGet(o, key);
      if (val && typeof val === "object") {
        const found = findFirstInObject(val, predicate, s, maxDepth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}
function findQualityGateInObject(obj) {
  return findFirstInObject(obj, (o) => isQualityGateSnapshot(o));
}
function findExperienceResultInObject(obj) {
  return findFirstInObject(obj, (o) => isExperienceBankResult(o));
}
function findDefenseResultInObject(obj) {
  return findFirstInObject(obj, (o) => isDefenseEventsResult(o));
}
function latestToolResultNode(session, toolName, find) {
  if (!session || typeof session !== "object") return null;
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
      const tool = String(safeGet(call, "tool") ?? "");
      if (tool !== toolName && !tool.endsWith(toolName)) continue;
      const result = safeGet(call, "result");
      if (result !== void 0 && result !== null && find(result)) return result;
      const message = safeGet(call, "message");
      if (message !== void 0 && message !== null && find(message)) return message;
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
      const calls = safeGet(msg, "tool_calls");
      if (!Array.isArray(calls)) continue;
      const callList = (
        /** @type {Array<Record<string, unknown>>} */
        calls
      );
      for (let j = callList.length - 1; j >= 0; j--) {
        const call = callList[j];
        if (!call) continue;
        const name2 = String(safeGet(call, "name") ?? safeGet(call, "tool") ?? "");
        if (name2 !== toolName && !name2.endsWith(toolName)) continue;
        const result = safeGet(call, "result") ?? safeGet(call, "response") ?? safeGet(call, "message");
        if (result !== void 0 && result !== null && find(result)) return result;
      }
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (!msg) continue;
      const content = safeGet(msg, "content");
      if (content === void 0 || content === null) continue;
      if (find(content)) return content;
    }
  }
  return null;
}
function normalizeQualityGateSnapshot(raw) {
  const src = raw && typeof raw === "object" ? (
    /** @type {Record<string, unknown>} */
    raw
  ) : {};
  const asNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const asStr = (v) => typeof v === "string" ? v : "";
  const status = safeGet(src, "overallStatus");
  const dims = Array.isArray(safeGet(src, "dimensions")) ? safeGet(src, "dimensions") : [];
  return {
    timestamp: asStr(safeGet(src, "timestamp")),
    overallStatus: status === "pass" || status === "fail" || status === "pending" ? status : "pending",
    overallScore: asNum(safeGet(src, "overallScore")),
    verificationPassRate: asNum(safeGet(src, "verificationPassRate")),
    totalChecks: asNum(safeGet(src, "totalChecks")),
    passedChecks: asNum(safeGet(src, "passedChecks")),
    failedChecks: asNum(safeGet(src, "failedChecks")),
    failReason: asStr(safeGet(src, "failReason")) || null,
    totalFindings: asNum(safeGet(src, "totalFindings")),
    criticalCount: asNum(safeGet(src, "criticalCount")),
    highCount: asNum(safeGet(src, "highCount")),
    mediumCount: asNum(safeGet(src, "mediumCount")),
    lowCount: asNum(safeGet(src, "lowCount")),
    dimensions: (
      /** @type {unknown[]} */
      dims.map((d) => {
        const rec = (
          /** @type {Record<string, unknown>} */
          d && typeof d === "object" ? d : {}
        );
        const dimStatus = safeGet(rec, "status");
        return {
          dimension: asStr(safeGet(rec, "dimension")),
          convergenceRate: asNum(safeGet(rec, "convergenceRate")),
          findingsCount: asNum(safeGet(rec, "findingsCount")),
          fixedCount: asNum(safeGet(rec, "fixedCount")),
          score: asNum(safeGet(rec, "score")),
          status: dimStatus === "pass" || dimStatus === "warn" || dimStatus === "fail" ? dimStatus : "warn"
        };
      })
    )
  };
}
function scanSessionForQualityGate(session) {
  const node = latestToolResultNode(session, "iterate_quality_gate", findQualityGateInObject);
  if (node !== null) {
    const found = findQualityGateInObject(node);
    if (found) return normalizeQualityGateSnapshot(found);
  }
  const loose = findFirstInObject(session, isQualityGateSnapshot);
  return loose ? normalizeQualityGateSnapshot(loose) : null;
}
function normalizeExperienceBankResult(raw) {
  const src = raw && typeof raw === "object" ? (
    /** @type {Record<string, unknown>} */
    raw
  ) : {};
  const asNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const asStr = (v) => typeof v === "string" ? v : "";
  const asArr = (v) => Array.isArray(v) ? (
    /** @type {unknown[]} */
    v
  ) : [];
  const entry = safeGet(src, "entry");
  const rawEntries = Array.isArray(safeGet(src, "entries")) ? (
    /** @type {unknown[]} */
    safeGet(src, "entries")
  ) : entry && typeof entry === "object" ? [entry] : [];
  return {
    operation: asStr(safeGet(src, "operation")),
    count: asNum(safeGet(src, "count")),
    totalHits: asNum(safeGet(src, "totalHits")),
    added: safeGet(src, "added") === true,
    entries: rawEntries.map((e) => {
      const rec = (
        /** @type {Record<string, unknown>} */
        e && typeof e === "object" ? e : {}
      );
      return {
        id: asStr(safeGet(rec, "id")),
        timestamp: asStr(safeGet(rec, "timestamp")),
        dimension: asStr(safeGet(rec, "dimension")),
        pattern: asStr(safeGet(rec, "pattern")),
        description: asStr(safeGet(rec, "description")),
        verifiedFix: asStr(safeGet(rec, "verifiedFix")),
        findingSummary: asStr(safeGet(rec, "findingSummary")),
        severity: asStr(safeGet(rec, "severity")),
        hitCount: asNum(safeGet(rec, "hitCount")),
        lastHitAt: asStr(safeGet(rec, "lastHitAt")) || null,
        files: asArr(safeGet(rec, "files")).map((f) => typeof f === "string" ? f : ""),
        tags: asArr(safeGet(rec, "tags")).map((t2) => typeof t2 === "string" ? t2 : "")
      };
    })
  };
}
function scanSessionForExperienceBank(session) {
  const node = latestToolResultNode(session, "iterate_experience", findExperienceResultInObject);
  if (node !== null) {
    const found = findExperienceResultInObject(node);
    if (found) return normalizeExperienceBankResult(found);
  }
  const loose = findFirstInObject(session, isExperienceBankResult);
  return loose ? normalizeExperienceBankResult(loose) : null;
}
function normalizeDefenseEventsResult(raw) {
  const src = raw && typeof raw === "object" ? (
    /** @type {Record<string, unknown>} */
    raw
  ) : {};
  const asNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const asStr = (v) => typeof v === "string" ? v : "";
  const countsRaw = safeGet(src, "counts") && typeof safeGet(src, "counts") === "object" ? (
    /** @type {Record<string, unknown>} */
    safeGet(src, "counts")
  ) : {};
  const counts = (
    /** @type {Record<string, number>} */
    {}
  );
  for (const type of DEFENSE_EVENT_TYPES) {
    const n = safeGet(countsRaw, type);
    counts[type] = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const event = safeGet(src, "event");
  const rawEvents = Array.isArray(safeGet(src, "events")) ? (
    /** @type {unknown[]} */
    safeGet(src, "events")
  ) : event && typeof event === "object" ? [event] : [];
  return {
    operation: asStr(safeGet(src, "operation")),
    count: asNum(safeGet(src, "count")),
    language: asStr(safeGet(src, "language")),
    counts,
    events: rawEvents.map((e) => {
      const rec = (
        /** @type {Record<string, unknown>} */
        e && typeof e === "object" ? e : {}
      );
      return {
        id: asStr(safeGet(rec, "id")),
        timestamp: asStr(safeGet(rec, "timestamp")),
        round: asNum(safeGet(rec, "round")),
        type: asStr(safeGet(rec, "type")),
        description: asStr(safeGet(rec, "description")),
        defense: asStr(safeGet(rec, "defense")),
        outcome: asStr(safeGet(rec, "outcome")),
        file: asStr(safeGet(rec, "file")) || null,
        line: asNum(safeGet(rec, "line")) || null,
        severity: asStr(safeGet(rec, "severity"))
      };
    })
  };
}
function scanSessionForDefenseEvents(session) {
  const node = latestToolResultNode(session, "iterate_defense_events", findDefenseResultInObject);
  if (node !== null) {
    const found = findDefenseResultInObject(node);
    if (found) return normalizeDefenseEventsResult(found);
  }
  const loose = findFirstInObject(session, isDefenseEventsResult);
  return loose ? normalizeDefenseEventsResult(loose) : null;
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
    Array.isArray(report.rounds) ? report.rounds : []
  );
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    Array.isArray(report.findings) ? report.findings : []
  );
  const totalRounds = typeof convergence.totalRounds === "number" ? convergence.totalRounds : rounds.length;
  const explicitReason = typeof convergence.stoppedReason === "string" && convergence.stoppedReason.trim() ? convergence.stoppedReason : null;
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
    stoppedReason: explicitReason ?? (convergence.converged === true ? "converged" : rounds.length >= totalRounds ? "max_rounds_reached" : null)
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
  const list = Array.isArray(findings) ? findings : [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const byDimension = /* @__PURE__ */ Object.create(null);
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const sev = String(f.severity ?? "low");
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev]++;
    const dim = String(f.dimension ?? "unknown");
    byDimension[dim] = (byDimension[dim] ?? 0) + 1;
  }
  return {
    totalFindings: list.length,
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
  const currentRounds = currentRoundNumber(report);
  if (!(totalRounds > 0)) return 0;
  return Math.min(100, Math.round(currentRounds / totalRounds * 100));
}
function currentRoundNumber(report) {
  const rounds = (
    /** @type {Array<Record<string, unknown>>} */
    Array.isArray(report.rounds) ? report.rounds : []
  );
  let max = 0;
  for (const r of rounds) {
    if (!r || typeof r !== "object") continue;
    const n = Number(r.round);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return rounds.length > 0 && max === 0 ? rounds.length : max;
}
function getCurrentRound(report) {
  return currentRoundNumber(report);
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
    Array.isArray(report.findings) ? report.findings : []
  );
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const sev = String(f.severity ?? "low");
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev]++;
  }
  return counts;
}
function groupByDimension(report) {
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    Array.isArray(report.findings) ? report.findings : []
  );
  const groups = /* @__PURE__ */ Object.create(null);
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const dim = String(f.dimension ?? "unknown");
    if (!Object.prototype.hasOwnProperty.call(groups, dim)) groups[dim] = [];
    groups[dim].push(f);
  }
  return groups;
}
var TRIAGE_VERDICTS = (
  /** @type {const} */
  ["keep", "skip", "ignore"]
);
function buildTriageState(report) {
  const findings = (
    /** @type {Array<unknown>} */
    Array.isArray(report.findings) ? report.findings : []
  );
  const state = {};
  for (let i = 0; i < findings.length; i++) {
    state[String(i)] = "keep";
  }
  return state;
}
function hashReport(report) {
  const findings = (
    /** @type {Array<Record<string, unknown>>} */
    Array.isArray(report.findings) ? report.findings : []
  );
  let h = 2166136261;
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  mix(`${String(report.mode ?? "")}|`);
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    mix(`${String(f.file ?? "")}|${typeof f.line === "number" ? f.line : 0}|${String(f.dimension ?? "")}|${String(f.summary ?? "")}
`);
  }
  return `iterate-triage-${h.toString(36)}`;
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
  return `\u8BF7\u8C03\u7528 \`iterate_triage\` \u5E94\u7528\u4E0B\u9762\u7684 known_intentional \u6761\u76EE\uFF08\u7C98\u8D34\u540E\u7531\u6A21\u578B\u8C03\u7528 \`iterate_triage\` \u7684 \`operation: "apply"\` \u5199\u5165\u914D\u7F6E\uFF1A\u81EA\u52A8\u53BB\u91CD\u3001\u5199\u5165\u524D\u5907\u4EFD\u3001\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\uFF09\uFF1A

\`\`\`json
${payload}
\`\`\`

\u5199\u5165\u5B8C\u6210\u540E\u8BF7\u590D\u5236\u9762\u677F\u7684\u300C\u56DE\u8BFB\u5DF2\u5199\u5165\u6761\u76EE\u300D\u6307\u4EE4\uFF08\`iterate_triage\` \`operation: "list"\`\uFF09\u6838\u5BF9\u7ED3\u679C\u3002`;
}
function buildTriageReadbackInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_triage\` \u56DE\u8BFB\u5F53\u524D\u5DF2\u5199\u5165\u914D\u7F6E\u7684 known_intentional \u6761\u76EE\uFF0C\u5E76\u628A\u6BCF\u6761\u7684 file / line / dimension / reason \u539F\u6837\u5217\u51FA\u6765\u4F9B\u6211\u6838\u5BF9\uFF1A

\`\`\`json
${JSON.stringify({ operation: "list" }, null, 2)}
\`\`\``;
}
function collectIgnoredEntries(triageState, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const entries = [];
  for (const [idx, verdict] of Object.entries(triageState)) {
    if (verdict !== "ignore") continue;
    const finding = list[Number(idx)];
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
var CONTENT_PLACEHOLDER = "<\u7531\u6A21\u578B\u586B\u5199\uFF1A\u4FEE\u590D\u540E\u7684\u5B8C\u6574\u6587\u4EF6\u5185\u5BB9>";
var ROUND_PLACEHOLDER = "<\u7531\u6A21\u578B\u586B\u5199\uFF1A\u5F53\u524D\u8FED\u4EE3\u8F6E\u6B21\uFF08\u22651 \u7684\u6574\u6570\uFF09>";
var START_INSTRUCTION_FULL = '\u5F00\u59CB\u4E00\u6B21\u5B8C\u6574\u8FED\u4EE3\uFF08\u5BA1\u67E5 \u2192 \u4FEE\u590D \u2192 \u9A8C\u8BC1 \u2192 \u590D\u76D8\uFF09\uFF1A\u8BF7\u8C03\u7528 `workflow` \u5DE5\u5177\u8FD0\u884C iterate \u5DE5\u4F5C\u6D41\uFF0Cmode: "normal"\uFF0C\u6309\u7CFB\u7EDF\u63D0\u793A\u7684 Iterate Workflow \u6267\u884C plan \u2192 \u591A\u7EBF\u7A0B\u5E76\u884C\u8BC4\u5BA1 \u2192 \u5206\u8BCA \u2192 \u539F\u5B50\u4FEE\u590D \u2192 \u6BCF\u8F6E\u9A8C\u8BC1 \u2192 \u5FAA\u73AF\u76F4\u81F3\u6536\u655B\u6216\u8FBE\u5230 max_rounds \u2192 \u7EC8\u62A5\u5E76 `iterate_transcript` capture\u3002\u5F00\u8DD1\u524D\u5148 `iterate_config({operation:"read"})` \u68C0\u67E5 validation.commands\uFF1A\u82E5\u4E3A\u7A7A\uFF0C\u5148\u505C\u4E0B\u6765\u63D0\u793A\u6211\u7528 `iterate_config` \u5199\u5165\u9A8C\u8BC1\u547D\u4EE4\uFF0C\u5426\u5219\u672C\u8F6E\u8FED\u4EE3\u4E0D\u53D7\u4EFB\u4F55\u6D4B\u8BD5\u4FDD\u62A4\u3002';
var START_INSTRUCTION_REVIEW_ONLY = '\u5F00\u59CB\u4E00\u6B21\u4EC5\u8BC4\u5BA1\uFF08dry-run\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\uFF09\uFF1A\u8BF7\u8C03\u7528 `workflow` \u5DE5\u5177\u8FD0\u884C iterate \u5DE5\u4F5C\u6D41\uFF0Cmode: "dry-run"\uFF0C\u6309\u7CFB\u7EDF\u63D0\u793A\u7684 Iterate Workflow \u6267\u884C plan \u2192 \u591A\u7EBF\u7A0B\u5E76\u884C\u8BC4\u5BA1 \u2192 \u5206\u8BCA \u2192 `iterate_review aggregate` / `meta-review` \u7EC8\u62A5\u5E76 `iterate_transcript` capture\uFF1B\u5168\u7A0B\u4E0D\u8981\u8C03\u7528 `iterate_fix` / `iterate_rollback`\u3002';
var START_INSTRUCTIONS = {
  full: START_INSTRUCTION_FULL,
  reviewOnly: START_INSTRUCTION_REVIEW_ONLY
};
function fixFindingPayload(finding) {
  const f = finding && typeof finding === "object" ? finding : {};
  const file = String(f.file ?? "");
  return {
    file,
    ...typeof f.line === "number" && f.line > 0 ? { line: f.line } : {},
    dimension: String(f.dimension ?? ""),
    severity: String(f.severity ?? ""),
    summary: String(f.summary ?? ""),
    ...f.failure_scenario ? { failure_scenario: String(f.failure_scenario) } : {},
    ...f.suggested_fix ? { suggested_fix: String(f.suggested_fix) } : {}
  };
}
function buildFixInstruction(finding, opts) {
  const payload = fixFindingPayload(finding);
  if (!payload.file) return "";
  const round = opts && Number.isInteger(opts.round) ? opts.round : null;
  const call = {
    file: payload.file,
    content: CONTENT_PLACEHOLDER,
    finding: payload,
    round: round !== null ? round : ROUND_PLACEHOLDER
  };
  return [
    "\u8BF7\u4FEE\u590D\u4E0B\u9762\u8FD9\u4E00\u4E2A finding\u3002`iterate_fix` \u4E00\u6B21\u53EA\u63A5\u53D7\u4E00\u4E2A finding\uFF0C\u4E14 file / content / finding / round \u56DB\u4E2A\u53C2\u6570\u5168\u90E8\u5FC5\u586B\uFF1A",
    `\u6B65\u9AA4 1\uFF1A\u8BFB\u53D6 \`${payload.file}\`\uFF0C\u6309 finding \u751F\u6210\u4FEE\u590D\u540E\u7684\u3010\u5B8C\u6574\u6587\u4EF6\u5185\u5BB9\u3011\uFF08content \u5360\u4F4D\u5FC5\u987B\u6362\u6210\u771F\u5B9E\u6587\u4EF6\u5185\u5BB9\uFF09\u3002`,
    `\u6B65\u9AA4 2\uFF1A\u8C03\u7528 \`iterate_fix\`\uFF0C\u628A content \u4E0E round \u586B\u6210\u771F\u5B9E\u503C${round !== null ? `\uFF08\u672C\u8F6E round = ${round}\uFF09` : ""}\uFF1A`,
    "```json",
    JSON.stringify(call, null, 2),
    "```",
    '\u9700\u8981\u8D85\u8FC7 atomic \u884C\u6570\u4E0A\u9650\u65F6\uFF0C\u53E6\u52A0 "force": true\u3002'
  ].join("\n");
}
function buildAssignFixesInstruction(findings) {
  const list = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f === "object");
  if (list.length === 0) return "";
  const payload = list.map((f) => fixFindingPayload(f)).filter((p) => p.file);
  if (payload.length === 0) return "";
  return [
    `\u8BF7\u4FEE\u590D\u4E0B\u9762\u8FD9 ${payload.length} \u4E2A findings\u3002\u6CE8\u610F\uFF1A\`iterate_fix\` \u6BCF\u6B21\u53EA\u5904\u7406\u3010\u4E00\u4E2A\u3011finding\uFF08\u6CA1\u6709\u6570\u7EC4\u5165\u53C2\uFF09\uFF0C\u8BF7\u9010\u4E2A\u8C03\u7528 iterate_fix\u2014\u2014\u4E00\u6B21\u4E00\u4E2A finding\uFF0C\u5904\u7406\u5B8C\u4E00\u4E2A\u518D\u53D1\u8D77\u4E0B\u4E00\u4E2A\uFF0C\u7EDD\u4E0D\u8981\u628A\u6574\u6279\u6570\u7EC4\u5F53\u4F5C\u53C2\u6570\u4F20\u5165\u3002`,
    "\u6BCF\u4E2A finding \u90FD\u8D70\u540C\u6837\u7684\u4E24\u6B65\uFF1A\u2460 \u8BFB\u53D6\u6587\u4EF6\u751F\u6210\u4FEE\u590D\u540E\u7684\u5B8C\u6574 content\uFF1B\u2461 \u8C03\u7528 iterate_fix\uFF08file / content / finding / round \u5FC5\u586B\uFF0Ccontent \u4E0E round \u7531\u4F60\u586B\u5199\uFF09\u3002",
    "\u5F85\u4FEE\u590D\u6E05\u5355\uFF1A",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}
function buildArchitecturalFixInstruction(findings) {
  const list = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f === "object");
  const lines = [
    '\u8BF7\u6279\u51C6\u5E76\u6267\u884C\u67B6\u6784\u578B\u4FEE\u590D\uFF08\u5141\u8BB8\u8D85\u8FC7 atomic \u884C\u6570\u4E0A\u9650\uFF09\uFF1A\u5BF9\u6BCF\u4E2A\u67B6\u6784\u578B finding \u9010\u4E2A\u8C03\u7528 `iterate_fix`\uFF0C\u4E00\u6B21\u4E00\u4E2A finding\uFF0C\u5E76\u663E\u5F0F\u8BBE\u7F6E `"force": true`\uFF1B',
    "file / content / finding / round \u56DB\u4E2A\u5FC5\u586B\u53C2\u6570\u4E00\u4E2A\u90FD\u4E0D\u80FD\u5C11\uFF08content = \u4FEE\u590D\u540E\u7684\u5B8C\u6574\u6587\u4EF6\u5185\u5BB9\uFF0Cround = \u5F53\u524D\u8FED\u4EE3\u8F6E\u6B21\uFF0C\u4E24\u8005\u7531\u4F60\u586B\u5199\uFF09\u3002"
  ];
  if (list.length > 0) {
    lines.push("\u672C\u9879\u76EE\u5269\u4F59\u67B6\u6784\u578B finding\uFF1A", "```json", JSON.stringify(list.map((f) => fixFindingPayload(f)), null, 2), "```");
  }
  return lines.join("\n");
}
function buildCheckpointResumeInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_checkpoint\` \u4ECE\u65AD\u70B9\u6062\u590D\u8FED\u4EE3\uFF08\u52A0\u8F7D\u65AD\u70B9\u5E76\u628A resumeCount +1\uFF09\uFF1A

\`\`\`json
${JSON.stringify({ operation: "resume" }, null, 2)}
\`\`\``;
}
function buildCheckpointClearInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_checkpoint\` \u6E05\u9664\u5F53\u524D\u65AD\u70B9\uFF1A

\`\`\`json
${JSON.stringify({ operation: "clear" }, null, 2)}
\`\`\``;
}
function buildQualityGateQueryInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_quality_gate\` \u67E5\u8BE2\u5F53\u524D\u8D28\u91CF\u95E8\u7981\u72B6\u6001\uFF08\u8BFB\u53D6\u78C1\u76D8\u4E0A\u6301\u4E45\u5316\u7684\u8BC1\u4E66\uFF09\uFF1A

\`\`\`json
${JSON.stringify({ operation: "read" }, null, 2)}
\`\`\``;
}
function buildQualityGateClearInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_quality_gate\` \u6E05\u9664\u5F53\u524D\u8D28\u91CF\u95E8\u7981\u8BC1\u4E66\uFF1A

\`\`\`json
${JSON.stringify({ operation: "clear" }, null, 2)}
\`\`\``;
}
function buildRollbackInstruction(id) {
  return `\u8BF7\u8C03\u7528 \`iterate_rollback\` \u56DE\u6EDA\u4EE5\u4E0B\u4FEE\u590D\uFF1A

\`\`\`json
${JSON.stringify({ id: String(id || "") }, null, 2)}
\`\`\``;
}
function buildExperienceListInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_experience\` \u5217\u51FA\u7ECF\u9A8C\u94F6\u884C\u4E2D\u7684\u6240\u6709\u7ECF\u9A8C\uFF0C\u5E76\u628A\u5B8C\u6574\u8FD4\u56DE\u7ED3\u679C\u56DE\u663E\u5230\u4F1A\u8BDD\u91CC\uFF1A

\`\`\`json
${JSON.stringify({ operation: "list" }, null, 2)}
\`\`\``;
}
function buildDefenseEventsListInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_defense_events\` \u5217\u51FA\u5168\u90E8\u9632\u5FA1\u4E8B\u4EF6\uFF0C\u5E76\u628A\u5B8C\u6574\u8FD4\u56DE\u7ED3\u679C\u56DE\u663E\u5230\u4F1A\u8BDD\u91CC\uFF1A

\`\`\`json
${JSON.stringify({ operation: "list" }, null, 2)}
\`\`\``;
}
function buildDiskSnapshotInstruction() {
  const lines = [
    "\u8BF7\u4ECE\u78C1\u76D8\u62C9\u53D6 iterate \u5FEB\u7167\uFF1A\u9010\u4E2A\u8C03\u7528\u4E0B\u9762\u7684\u53EA\u8BFB\u5DE5\u5177\uFF0C\u5E76\u628A\u6BCF\u4E2A\u5DE5\u5177\u7684\u3010\u5B8C\u6574\u8FD4\u56DE\u7ED3\u679C\u3011\u539F\u6837\u56DE\u663E\u5230\u4F1A\u8BDD\u91CC\uFF08\u4E0D\u8981\u53EA\u7ED9\u6458\u8981\u2014\u2014\u63D2\u4EF6\u9762\u677F\u9760\u8FD9\u4E9B\u56DE\u663E\u586B\u5145\uFF09\uFF1A"
  ];
  DISK_SNAPSHOT_SOURCES.forEach((s, i) => {
    lines.push(`${i + 1}. \`${s.tool}\`\uFF08${s.label}\uFF09\uFF1A${JSON.stringify(s.args)}`);
  });
  lines.push("\u56DE\u663E\u540E\uFF0C\u89C2\u6D4B\u53F0\u5B9E\u65F6\u6D41 / F2 \u8DE8\u8F6E\u5BF9\u6BD4 / F5 \u65AD\u70B9 / F8 \u8D28\u91CF\u95E8\u7981 / F9 \u7ECF\u9A8C\u94F6\u884C / F10 \u9632\u5FA1\u4E8B\u4EF6\u4F1A\u81EA\u52A8\u8BFB\u53D6\u8FD9\u4E9B\u7ED3\u679C\u3002");
  return lines.join("\n");
}
var DISK_SNAPSHOT_SOURCES = [
  { tool: "iterate_status", args: {}, label: "\u8FD0\u884C\u72B6\u6001\u6C47\u603B" },
  { tool: "iterate_transcript", args: { operation: "read" }, label: "transcript \u89C2\u6D4B\u6E05\u5355" },
  { tool: "iterate_quality_gate", args: { operation: "read" }, label: "\u8D28\u91CF\u95E8\u7981\u8BC1\u4E66" },
  { tool: "iterate_experience", args: { operation: "list" }, label: "\u7ECF\u9A8C\u94F6\u884C" },
  { tool: "iterate_defense_events", args: { operation: "list" }, label: "\u9632\u5FA1\u4E8B\u4EF6\u6D41" },
  { tool: "iterate_history", args: {}, label: "\u51B3\u7B56\u65E5\u5FD7\u4E0E\u4FEE\u590D\u6CE8\u518C\u8868\uFF08\u8DE8\u8F6E/\u8DE8\u4F1A\u8BDD\u5BF9\u6BD4\uFF09" }
];
function toolCalledInSession(session, toolName) {
  if (!session || typeof session !== "object" || typeof toolName !== "string" || !toolName) return false;
  const s = (
    /** @type {Record<string, unknown>} */
    session
  );
  const toolCalls = safeGet(s, "toolCalls");
  if (Array.isArray(toolCalls)) {
    for (
      const call of
      /** @type {unknown[]} */
      toolCalls
    ) {
      if (!call || typeof call !== "object") continue;
      const t2 = String(safeGet(
        /** @type {Record<string, unknown>} */
        call,
        "tool"
      ) ?? "");
      if (t2 === toolName || t2.endsWith(toolName)) return true;
    }
  }
  const messages = safeGet(s, "messages");
  if (Array.isArray(messages)) {
    for (
      const msg of
      /** @type {unknown[]} */
      messages
    ) {
      if (!msg || typeof msg !== "object") continue;
      const calls = safeGet(
        /** @type {Record<string, unknown>} */
        msg,
        "tool_calls"
      );
      if (!Array.isArray(calls)) continue;
      for (
        const call of
        /** @type {unknown[]} */
        calls
      ) {
        if (!call || typeof call !== "object") continue;
        const c = (
          /** @type {Record<string, unknown>} */
          call
        );
        const name2 = String(safeGet(c, "name") ?? safeGet(c, "tool") ?? "");
        if (name2 === toolName || name2.endsWith(toolName)) return true;
        const fn = safeGet(c, "function");
        if (fn && typeof fn === "object" && String(safeGet(
          /** @type {Record<string, unknown>} */
          fn,
          "name"
        ) ?? "") === toolName) {
          return true;
        }
      }
    }
  }
  return false;
}
function diskEmptyStateText(pulled, topic, lang = "zh") {
  const subject = topic || (lang === "en" ? "data" : "\u6570\u636E");
  if (lang === "en") {
    return pulled ? `Pulled from disk: ${subject} has no records yet (the disk is empty).` : `Not pulled from disk yet: ${subject} lives under the project's .iterate/ \u2014 copy the "Pull disk snapshot" instruction back into the session and it will fill in.`;
  }
  return pulled ? `\u5DF2\u4ECE\u78C1\u76D8\u62C9\u53D6\uFF1A${subject}\u6682\u65E0\u8BB0\u5F55\uFF08\u78C1\u76D8\u65E0\u6570\u636E\uFF09\u3002` : `\u5C1A\u672A\u4ECE\u78C1\u76D8\u62C9\u53D6${subject}\uFF1A\u6570\u636E\u5B58\u653E\u5728\u9879\u76EE .iterate/ \u4E0B\uFF0C\u70B9\u300C\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u300D\u590D\u5236\u6307\u4EE4\u53D1\u56DE\u4F1A\u8BDD\u5373\u53EF\u56DE\u586B\u3002`;
}
function normalizeFindingFilter(filter) {
  const f = filter && typeof filter === "object" ? filter : {};
  const severities = Array.isArray(f.severities) ? f.severities.filter((s) => SEVERITY_ORDER.includes(String(s))) : [];
  const dimensions = Array.isArray(f.dimensions) ? f.dimensions.filter((d) => typeof d === "string" && d.length > 0) : [];
  const search = typeof f.search === "string" ? f.search.trim().toLowerCase() : "";
  return { severities, dimensions, search };
}
function findingMatches(finding, filter) {
  if (!finding || typeof finding !== "object") return false;
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
    if (!f || typeof f !== "object") continue;
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
  if (!TRIAGE_VERDICTS.includes(verdict)) return triageState;
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
    if (!r || typeof r !== "object") return { round: 0, count: 0, critical: 0, high: 0, medium: 0, low: 0 };
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
function stoppedReasonLabel(reason, lang = "zh") {
  const zh = {
    converged: "\u5DF2\u7ED3\u675F \xB7 \u5DF2\u6536\u655B\uFF08\u65E0\u65B0\u53D1\u73B0\uFF09",
    max_rounds_reached: "\u5DF2\u7ED3\u675F \xB7 \u8FBE\u5230\u8F6E\u6570\u4E0A\u9650",
    aborted_by_validation: "\u5DF2\u7ED3\u675F \xB7 \u9A8C\u8BC1\u5931\u8D25\u540E\u56DE\u6EDA\u505C\u6B62",
    aborted_by_config: "\u5DF2\u7ED3\u675F \xB7 \u9A8C\u8BC1\u547D\u4EE4\u4E0D\u5728\u767D\u540D\u5355\uFF08\u914D\u7F6E\u9700\u4FEE\u590D\uFF09",
    inconclusive: "\u5DF2\u7ED3\u675F \xB7 \u8F6E\u6B21\u7ED3\u8BBA\u4E0D\u660E\uFF08\u5BA1\u67E5\u8F93\u51FA\u65E0\u6548\uFF09",
    schema_invalid: "\u5DF2\u7ED3\u675F \xB7 \u5BA1\u67E5\u8F93\u51FA\u8FDE\u7EED schema \u6821\u9A8C\u5931\u8D25",
    no_usable_reviewer_output: "\u5DF2\u7ED3\u675F \xB7 \u65E0\u53EF\u7528\u5BA1\u67E5\u8F93\u51FA"
  };
  const en = {
    converged: "Done \xB7 converged (no new findings)",
    max_rounds_reached: "Done \xB7 reached the round limit",
    aborted_by_validation: "Done \xB7 rolled back after a validation failure",
    aborted_by_config: "Done \xB7 validation command not allow-listed (config needs fixing)",
    inconclusive: "Done \xB7 inconclusive rounds (invalid review output)",
    schema_invalid: "Done \xB7 repeated schema validation failures in review output",
    no_usable_reviewer_output: "Done \xB7 no usable review output"
  };
  if (lang === "en") return en[reason] ?? (reason ? `Done \xB7 ${reason}` : "Done");
  return zh[reason] ?? (reason ? `\u5DF2\u7ED3\u675F \xB7 ${reason}` : "\u5DF2\u7ED3\u675F");
}
function buildCompletionSummary(report, lang = "zh") {
  const conv = (
    /** @type {Record<string, unknown>} */
    report.convergence ?? {}
  );
  const rounds = getCurrentRound(report);
  const total = getTotalRounds(report);
  const stats = severityStats(report);
  const converged = conv.converged === true;
  const totalFindings = stats.critical + stats.high + stats.medium + stats.low;
  if (lang === "en") {
    const reason2 = converged ? "converged" : `reached the round limit ${total}`;
    return `iterate review complete \xB7 ${rounds}/${total} rounds \xB7 ${totalFindings} findings \xB7 ${reason2}`;
  }
  const reason = converged ? "\u5DF2\u6536\u655B" : `\u5DF2\u8FBE\u6700\u5927\u8F6E\u6570 ${total}`;
  return `iterate \u8BC4\u5BA1\u5B8C\u6210 \xB7 ${rounds}/${total} \u8F6E \xB7 ${totalFindings} \u9879\u53D1\u73B0 \xB7 ${reason}`;
}
var CONFIG_EDIT_FIELDS = [
  {
    key: "goal",
    label: { zh: "\u76EE\u6807", en: "Goal" },
    hint: { zh: "\u4E00\u53E5\u8BDD\u63CF\u8FF0\u672C\u6B21\u8FED\u4EE3\u76EE\u6807\uFF08\u5B57\u7B26\u4E32\uFF09", en: "One-sentence description of this iteration's goal (a string)" }
  },
  {
    key: "dimensions",
    label: { zh: "\u5BA1\u67E5\u7EF4\u5EA6", en: "Review dimensions" },
    hint: { zh: '\u6570\u7EC4\uFF0C\u5982 ["correctness","security"]', en: 'Array, e.g. ["correctness","security"]' }
  },
  {
    key: "max_rounds",
    label: { zh: "\u6700\u5927\u8F6E\u6570", en: "Max rounds" },
    hint: { zh: "\u6B63\u6574\u6570", en: "Positive integer" }
  },
  {
    key: "review.scope",
    label: { zh: "\u5BA1\u67E5\u8303\u56F4", en: "Review scope" },
    hint: { zh: '"full" \u6216 "changed-only"', en: '"full" or "changed-only"' }
  },
  {
    key: "reasoning_effort",
    label: { zh: "\u5BA1\u67E5\u63A8\u7406\u5F3A\u5EA6", en: "Review reasoning effort" },
    hint: { zh: '"low" / "medium" / "high"\uFF0C\u7F3A\u7701\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4', en: '"low" / "medium" / "high"; omitted = follow the model default' }
  },
  {
    key: "validation.commands",
    label: { zh: "\u9A8C\u8BC1\u547D\u4EE4", en: "Validation commands" },
    hint: {
      zh: '\u6570\u7EC4\uFF0C\u6BCF\u9879\u662F\u4E00\u6761\u767D\u540D\u5355\u547D\u4EE4\u5B57\u7B26\u4E32\uFF0C\u5982 ["npm test","npm run lint"]\uFF1B\u6BCF\u8F6E\u9A8C\u8BC1\u9010\u6761\u6267\u884C\u3002\u7559\u7A7A\u6570\u7EC4 = \u4E0D\u9A8C\u8BC1\uFF08\u672C\u8F6E\u8FED\u4EE3\u4E0D\u53D7\u4EFB\u4F55\u6D4B\u8BD5\u4FDD\u62A4\uFF09',
      en: 'Array of allow-listed command strings, e.g. ["npm test","npm run lint"]; run one by one every round. An empty array = no verification (this iteration runs with no test protection)'
    }
  },
  {
    key: "language",
    label: { zh: "\u754C\u9762\u8BED\u8A00", en: "Interface language" },
    hint: {
      zh: '"zh" \u6216 "en"\uFF08\u9ED8\u8BA4 "en"\uFF09\uFF1A\u63A7\u5236\u5BA1\u6279\u7406\u7531\u3001\u9632\u5FA1\u4E8B\u4EF6\u6807\u7B7E\u7B49\u9762\u5411\u4EBA\u6587\u6848\u7684\u8BED\u8A00',
      en: '"zh" or "en" (default "en"): language of human-facing copy such as approval rationales and defense-event labels'
    }
  },
  {
    key: "personalization.known_intentional",
    label: { zh: "\u5DF2\u77E5\u6709\u610F\u95EE\u9898", en: "Known intentional issues" },
    hint: {
      zh: "\u6570\u7EC4\uFF0C\u6BCF\u9879 {file, line?, dimension, reason}\uFF1B\u547D\u4E2D\u6761\u76EE\u5728\u8BC4\u5BA1\u4E2D\u88AB\u8DF3\u8FC7\u3002\u53EF\u7528\u5206\u8BCA\u9762\u677F\u7684\u300C\u56DE\u8BFB\u5DF2\u5199\u5165\u6761\u76EE\u300D\u6838\u5BF9",
      en: `Array of {file, line?, dimension, reason}; findings hitting an entry are skipped in review. Verify via the triage panel's "read back written entries"`
    }
  },
  {
    key: "atomic.max_lines",
    label: { zh: "\u539F\u5B50\u4FEE\u590D\u4E0A\u9650\u884C\u6570", en: "Atomic fix line cap" },
    hint: { zh: "\u6B63\u6574\u6570", en: "Positive integer" }
  },
  {
    key: "git.push_per_round",
    label: { zh: "\u6BCF\u8F6E\u63A8\u9001", en: "Push per round" },
    hint: { zh: "true / false", en: "true / false" }
  }
];
function buildConfigEditGuide() {
  const lines = [
    "iterate \u914D\u7F6E\u7F16\u8F91\u6307\u5F15",
    "---------------------",
    "\u914D\u7F6E\u6587\u4EF6\uFF1A\u9879\u76EE\u6839\u76EE\u5F55 iterate.config.yaml\u3002",
    "",
    "\u26A0 \u672A\u914D\u7F6E validation.commands \u65F6\u8FED\u4EE3\u4E0D\u88AB\u4FDD\u62A4\uFF1A\u6BCF\u8F6E validate \u62FF\u5230\u7A7A\u7ED3\u679C\u4F1A\u88AB\u5F53\u4F5C",
    "  \u201C\u9A8C\u8BC1\u901A\u8FC7\u201D\uFF0C\u7B49\u4E8E\u5728\u6CA1\u6709\u4EFB\u4F55\u6D4B\u8BD5\u4FDD\u62A4\u7684\u60C5\u51B5\u4E0B\u7EE7\u7EED\u6536\u655B\u3002\u7B2C\u4E00\u6B21\u542F\u52A8\u8FED\u4EE3\u524D\uFF0C",
    "  \u8BF7\u5148\u7ED9 validation.commands \u914D\u4E0A\u81F3\u5C11\u4E00\u6761\u771F\u5B9E\u547D\u4EE4\uFF08\u5982 npm test\uFF09\u3002",
    "",
    "\u53EF\u7F16\u8F91\u5B57\u6BB5\uFF1A",
    ...CONFIG_EDIT_FIELDS.map((f) => `- ${f.key}\uFF08${f.label.zh}\uFF09\uFF1A${f.hint.zh}`),
    "",
    "\u8BA9\u6A21\u578B\u5E2E\u4F60\u6539\uFF1A",
    '1. \u8C03\u7528 iterate_config({ operation: "read" }) \u67E5\u770B\u5F53\u524D\u914D\u7F6E\uFF1B',
    "2. \u8BF4\u660E\u60F3\u6539\u7684\u5B57\u6BB5\uFF0C\u4F8B\u5982\u300C\u628A max_rounds \u6539\u6210 5\uFF0Cvalidation.commands \u52A0\u4E0A npm test\u300D\uFF1B",
    '3. \u6A21\u578B\u4F1A\u8C03\u7528 iterate_config({ operation: "write", updates: {...} }) \u5199\u5165\uFF0C\u5199\u5165\u524D\u81EA\u52A8\u5907\u4EFD\uFF0C\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\u3002',
    "",
    "\u4E5F\u53EF\u4EE5\u7528\u8BBE\u7F6E\u9875\u7684\u201C\u9009\u5B57\u6BB5 \u2192 \u751F\u6210\u5199\u5165\u6307\u4EE4\u201D\u76F4\u63A5\u590D\u5236\u7B2C 3 \u6B65\u7684\u6307\u4EE4\u7C98\u8D34\u7ED9\u6A21\u578B\u3002"
  ];
  return lines.join("\n");
}
function buildConfigEditInstruction(desiredChanges) {
  const payload = JSON.stringify({ operation: "write", updates: desiredChanges }, null, 2);
  return `\u8BF7\u8C03\u7528 \`iterate_config\` \u5199\u5165\u4EE5\u4E0B\u914D\u7F6E\u66F4\u65B0\uFF1A

\`\`\`json
${payload}
\`\`\``;
}
var CONFIG_VALUE_PLACEHOLDER = "<\u7531\u6A21\u578B\u586B\u5199\uFF1A\u8BE5\u5B57\u6BB5\u7684\u65B0\u503C>";
function configFieldByKey(key) {
  if (typeof key !== "string" || !key) return null;
  return CONFIG_EDIT_FIELDS.find((f) => f.key === key) ?? null;
}
function buildConfigFieldInstruction(key, value) {
  const field = configFieldByKey(key);
  const label = field ? field.label.zh : key;
  const hint = field ? field.hint.zh : "\u89C1 iterate.config.yaml";
  const updates = { [key]: value === void 0 ? CONFIG_VALUE_PLACEHOLDER : value };
  const payload = buildConfigEditInstruction(updates);
  return [
    `\u914D\u7F6E\u5B57\u6BB5 \xB7 ${label}\uFF08${key}\uFF09`,
    `\u5B57\u6BB5\u8BF4\u660E\uFF1A${hint}`,
    "",
    payload,
    "",
    '\u5199\u5165\u524D\u8BF7\u5148 `operation: "read"` \u5C55\u793A\u5F53\u524D\u503C\uFF1B\u5199\u5165\u7531\u5DE5\u5177\u81EA\u52A8\u5907\u4EFD\uFF0C\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\u3002'
  ].join("\n");
}
function buildConfigReadInstruction() {
  return `\u8BF7\u8C03\u7528 \`iterate_config\` \u56DE\u8BFB\u5F53\u524D\u751F\u6548\u914D\u7F6E\uFF0C\u5E76\u628A\u5B8C\u6574\u7ED3\u679C\uFF08\u542B config \u5B57\u6BB5\uFF09\u539F\u6837\u56DE\u663E\uFF0C\u4F9B\u6211\u6838\u5BF9\u754C\u9762\u4E0A\u5C55\u793A\u7684\u5F53\u524D\u503C\uFF1A

\`\`\`json
${JSON.stringify({ operation: "read" }, null, 2)}
\`\`\``;
}
var CONFIG_TOP_LEVEL_KEYS = [...new Set(CONFIG_EDIT_FIELDS.map((f) => f.key.split(".")[0]))];
function isEffectiveConfig(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const rec = (
    /** @type {Record<string, unknown>} */
    v
  );
  let hits = 0;
  for (const key of CONFIG_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(rec, key)) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}
function findConfigInResult(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = (
    /** @type {Record<string, unknown>} */
    v
  );
  const cfg = safeGet(rec, "config");
  if (isEffectiveConfig(cfg)) return (
    /** @type {Record<string, unknown>} */
    cfg
  );
  return isEffectiveConfig(v) ? rec : null;
}
function scanSessionForConfigRead(session) {
  const node = latestToolResultNode(session, "iterate_config", findConfigInResult);
  if (node !== null) {
    const cfg = findConfigInResult(node);
    if (cfg) return cfg;
  }
  const loose = findFirstInObject(session, isEffectiveConfig);
  return loose ? (
    /** @type {Record<string, unknown>} */
    loose
  ) : null;
}
function configValueByPath(config, key) {
  if (!config || typeof config !== "object" || typeof key !== "string" || !key) {
    return { resolved: false, value: void 0 };
  }
  let node = (
    /** @type {unknown} */
    config
  );
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return { resolved: false, value: void 0 };
    const rec = (
      /** @type {Record<string, unknown>} */
      node
    );
    if (!Object.hasOwn(rec, part)) return { resolved: false, value: void 0 };
    node = rec[part];
  }
  return { resolved: true, value: node };
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
  const verdict = VERDICT_SHORTCUTS[key];
  return verdict !== void 0 && TRIAGE_VERDICTS.includes(verdict) ? verdict : null;
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
    "\u6E05\u7406\u72B6\u6001\uFF1A\u8BA9\u6A21\u578B\u8C03\u7528 iterate_prune\uFF08\u9ED8\u8BA4 dry-run\uFF0C\u53EA\u62A5\u544A\u4E0D\u5220\u9664\uFF0C\u663E\u5F0F dryRun:false \u624D\u771F\u6B63\u6E05\u7406\uFF09\u3002",
    '\u91CD\u7F6E\u72B6\u6001\uFF1A\u4E2D\u65AD\u540E\u91CD\u65B0\u5F00\u59CB\u524D\uFF0C\u53EF\u5206\u522B\u8BA9\u6A21\u578B\u8C03\u7528 iterate_checkpoint(operation:"clear")\u3001',
    '  iterate_quality_gate(operation:"clear")\u3001iterate_defense_events(operation:"clear")',
    "  \u6E05\u9664\u9648\u65E7\u65AD\u70B9\u3001\u8D28\u91CF\u95E8\u7981\u8BC1\u4E66\u4E0E\u9632\u5FA1\u4E8B\u4EF6\u6D41\u3002"
  ];
  return lines.join("\n");
}
function filterLiveEntries(entries, type) {
  const list = Array.isArray(entries) ? entries : [];
  const t2 = typeof type === "string" ? type.trim() : "";
  if (!t2) return list.slice();
  return list.filter((e) => e && typeof e === "object" && String(e.type ?? "") === t2);
}
function filterTimelineEntries(entries, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const o = opts && typeof opts === "object" ? opts : {};
  const type = typeof o.type === "string" ? o.type : "";
  const round = typeof o.round === "string" ? o.round : "";
  const q = typeof o.search === "string" ? o.search.trim().toLowerCase() : "";
  const filtered = list.filter((t2) => {
    if (!t2 || typeof t2 !== "object") return false;
    if (type && String(t2.type ?? "") !== type) return false;
    if (round && String(t2.round ?? "") !== round) return false;
    if (q) {
      let dataText = "";
      try {
        dataText = JSON.stringify(t2.data ?? {});
      } catch {
        dataText = t2.data === void 0 ? "{}" : String(t2.data);
      }
      const hay = [String(t2.type ?? ""), String(t2.round ?? ""), dataText].join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  return filtered.slice().sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
}
function serializeObservatoryExport(manifest, live, extra) {
  const payload = {
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    manifest: manifest && typeof manifest === "object" ? manifest : null,
    live: Array.isArray(live) ? live : [],
    ...pickExportExtras(extra)
  };
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return JSON.stringify({ exportedAt: payload.exportedAt, manifest: null, live: [] }, null, 2);
  }
}
var EXPORT_EXTRA_KEYS = ["qualityGate", "experienceBank", "defenseEvents", "report"];
function pickExportExtras(extra) {
  const out = {};
  if (!extra || typeof extra !== "object") return out;
  for (const key of EXPORT_EXTRA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) continue;
    const value = extra[key];
    if (value === void 0) continue;
    out[key] = value;
  }
  return out;
}
function buildRoundComparison(report, validations) {
  const rounds = /* @__PURE__ */ new Map();
  const rowsFor = (round) => {
    const n = Number(round);
    const key = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (!rounds.has(key)) {
      rounds.set(key, { round: key, findings: 0, fixed: 0, severities: /* @__PURE__ */ Object.create(null), validations: [] });
    }
    return rounds.get(key);
  };
  const list = report && Array.isArray(report.findings) ? report.findings : [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const row = rowsFor(f.round);
    row.findings += 1;
    const sev = typeof f.severity === "string" && f.severity ? f.severity : "unknown";
    row.severities[sev] = (row.severities[sev] || 0) + 1;
    if (f.status === "fixed") row.fixed += 1;
  }
  const vals = Array.isArray(validations) ? validations : [];
  for (const v of vals) {
    if (!v || typeof v !== "object") continue;
    const row = rowsFor(v.round);
    row.validations.push({
      command: typeof v.command === "string" ? v.command : "",
      exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
      allowed: v.allowed === true
    });
  }
  return [...rounds.values()].filter((r) => r.round > 0).sort((a, b) => a.round - b.round).map((r) => ({ ...r, severities: { ...r.severities } }));
}
function dashboardRunState(transcript) {
  const t2 = transcript && typeof transcript === "object" ? transcript : null;
  if (!t2) return { state: "empty", round: 0, phase: "", stoppedReason: "" };
  const rawRound = Number(t2.round);
  const round = Number.isFinite(rawRound) && rawRound > 0 ? Math.floor(rawRound) : 1;
  const stoppedReason = typeof t2.stoppedReason === "string" ? t2.stoppedReason.trim() : "";
  return {
    state: t2.active === true ? "running" : "done",
    round,
    phase: latestPhase(t2.phases),
    stoppedReason
  };
}
function latestPhase(phases) {
  const list = Array.isArray(phases) ? phases : [];
  let latest = "";
  for (const p of list) {
    if (typeof p === "string" && p.trim()) latest = p.trim();
  }
  return latest;
}

// src/client/i18n.ts
var LANG_STORAGE_KEY = "iterate-ui-lang";
var LANG_NAMES = {
  zh: "\u7B80\u4F53\u4E2D\u6587",
  en: "English"
};
var EN = {
  // ── run state / dashboard ────────────────────────────────────────────────
  \u8FD0\u884C\u4E2D: "Running",
  \u5DF2\u7ED3\u675F: "Finished",
  "Round {a0}\uFF1A{a1} \u9879": "Round {a0}: {a1} findings",
  "\u5404\u8F6E\u53D1\u73B0\u6570\u91CF\u8D8B\u52BF\uFF1A{a0}": "Findings per round: {a0}",
  \u5B8C\u6574\u8FED\u4EE3: "Full iteration",
  "\u590D\u5236\u542F\u52A8\u6307\u4EE4\uFF1A\u5B8C\u6574\u300C\u5BA1\u67E5 \u2192 \u4FEE\u590D \u2192 \u9A8C\u8BC1 \u2192 \u590D\u76D8\u300D\u95ED\u73AF\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u5373\u53EF\uFF09": 'Copy the start instruction: the full "review \u2192 fix \u2192 validate \u2192 debrief" loop (paste it to the model)',
  \u4EC5\u8BC4\u5BA1: "Review only",
  "\u590D\u5236\u542F\u52A8\u6307\u4EE4\uFF1A\u53EA\u5BA1\u67E5\u4E0D\u4FEE\u6539\uFF08dry-run\uFF09\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u5373\u53EF\uFF09": "Copy the start instruction: review without changing anything (dry-run) \u2014 paste it to the model",
  "\u7B2C {a0} \u8F6E\u8FDB\u884C\u4E2D{a1}\u2014\u2014\u9996\u8F6E\u6C47\u603B\u62A5\u544A\u843D\u5730\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u6536\u655B\u8FDB\u5EA6\u4E0E\u53D1\u73B0\u7EDF\u8BA1\u3002": "Round {a0} in progress{a1} \u2014 convergence progress and finding stats appear here once the first aggregated report lands.",
  " \xB7 \u9636\u6BB5\u300C{a0}\u300D": ' \xB7 phase "{a0}"',
  "\u4E0A\u6B21\u8FED\u4EE3\u5728\u7B2C {a0} \u8F6E\u540E\u505C\u6B62{a1}\uFF0C\u4F46\u6CA1\u6709\u53EF\u5C55\u793A\u7684\u6C47\u603B\u62A5\u544A\u3002": "The last iteration stopped at round {a0}{a1}, but there is no report to show.",
  "\u8FD0\u884C\u4E00\u6B21\u8BC4\u5BA1\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u6536\u655B\u8FDB\u5EA6\u4E0E\u53D1\u73B0\u7EDF\u8BA1\u3002": "Run a review and convergence progress and finding stats will show up here.",
  \u672C\u6B21\u8FED\u4EE3\u4ECE\u4E0A\u4E00\u6B21\u4E2D\u65AD\u7684\u65AD\u70B9\u7EE7\u7EED\u6267\u884C: "This run resumed from the previous interrupted checkpoint",
  "\u5DF2\u4E2D\u65AD\u6062\u590D \xD7{a0}": "Resumed \xD7{a0}",
  "\u4F1A\u8BDD\u4E2D\u68C0\u6D4B\u5230\u7528\u6237\u9644\u5E26\u7684\u56FE\u7247\uFF0C\u8BC4\u5BA1\u5C06\u4F5C\u4E3A\u89C6\u89C9\u8BC1\u636E\u53C2\u8003": "Images attached by the user were detected in this session; the review treats them as visual evidence",
  "\u9644\u4EF6\u56FE\u7247 {a0}": "Attached images {a0}",
  "\u5F53\u524D\u5904\u4E8E\u300C{a0}\u300D\u9636\u6BB5\uFF08\u8FD0\u884C\u4E2D\uFF09": 'Currently in the "{a0}" phase (running)',
  "\u6700\u8FD1\u4E00\u6B21\u6267\u884C\u505C\u7559\u5728\u300C{a0}\u300D\u9636\u6BB5\uFF08\u5DF2\u7ED3\u675F\uFF09": 'The last run stopped in the "{a0}" phase (finished)',
  "\u4EE3\u7801\u6A21\u5F0F\uFF1A\u76F4\u63A5\u4FEE\u6539\u6587\u4EF6": "Code mode: edits files directly",
  "\u8FED\u4EE3\u6A21\u5F0F\uFF1A\u5BA1\u67E5-\u4FEE\u590D\u5FAA\u73AF": "Iterate mode: review \u2192 fix loop",
  "+{a0} \u66F4\u591A": "+{a0} more",
  "\u672C\u8F6E\u5DF2\u5E94\u7528\u7684\u539F\u5B50\u4FEE\u590D\u6570\uFF08\u6B63\u5E38\u6A21\u5F0F\uFF09": "Atomic fixes applied this round (normal mode)",
  "\u5BA1\u67E5\u5DF2\u6536\u655B\uFF1A\u6700\u540E\u4E00\u8F6E\u672A\u53D1\u73B0\u65B0\u95EE\u9898": "Review converged: the final round found nothing new",
  "\u2713 \u5DF2\u6536\u655B": "\u2713 Converged",
  "\u9996\u8F6E {a0} \u2192 \u672B\u8F6E {a1} \u9879\uFF0C\u964D\u5E45 {a2}%{a3}": "Round {a0} \u2192 round {a1} findings, down {a2}%{a3}",
  "\uFF0C\u5DF2\u6536\u655B": ", converged",
  "Iterate \xB7 \u6536\u655B\u7EDF\u8BA1": "Iterate \xB7 Convergence stats",
  \u6536\u8D77\u5386\u53F2: "Collapse history",
  "\u5386\u53F2 / \u8D8B\u52BF": "History / trend",
  \u8F6E\u6B21: "Round",
  \u53D1\u73B0: "Findings",
  \u8BF7\u7EE7\u7EED\u6267\u884C\u4E0B\u4E00\u8F6E\u8FED\u4EE3\u5BA1\u67E5: "Please continue with the next review round",
  "\u8BF7\u56DE\u6EDA\u4E0A\u4E00\u8F6E\u8FED\u4EE3\u7684\u4FEE\u590D\uFF1A\u8C03\u7528 `iterate_history` \u67E5\u770B\u672C\u8F6E fix id\uFF0C\u518D\u7528 `iterate_rollback` \u9010\u4E2A\u64A4\u9500\u8FD9\u4E9B\u4FEE\u590D": "Please roll back the fixes from the last round: call `iterate_history` for this round\u2019s fix ids, then `iterate_rollback` to undo them one by one",
  "y \u4FEE\u590D": "y fix",
  "\u4FDD\u7559\u8BE5 finding\uFF0C\u8FDB\u5165\u4FEE\u590D": "Keep this finding and move it to fixing",
  "n \u8DF3\u8FC7": "n skip",
  "\u8DF3\u8FC7\u8BE5 finding": "Skip this finding",
  "a \u5DF2\u77E5\u6709\u610F": "a known-intentional",
  "\u6807\u8BB0\u4E3A\u5DF2\u77E5\u6709\u610F\u5E76\u5199\u5165 known_intentional": "Mark as known-intentional and write it into known_intentional",
  // ── triage panel ─────────────────────────────────────────────────────────
  "Iterate \xB7 Findings \u5206\u8BCA ({a0}/{a1})": "Iterate \xB7 Findings triage ({a0}/{a1})",
  "y=\u4FEE\u590D \xB7 n=\u8DF3\u8FC7 \xB7 a=\u5DF2\u77E5\u6709\u610F \xB7 \u2191/\u2193 \u9009\u62E9": "y=fix \xB7 n=skip \xB7 a=known-intentional \xB7 \u2191/\u2193 to move",
  \u6309\u4E25\u91CD\u5EA6\u7B5B\u9009: "Filter by severity",
  \u5168\u90E8\u4E25\u91CD\u5EA6: "All severities",
  \u6309\u7EF4\u5EA6\u7B5B\u9009: "Filter by dimension",
  \u5168\u90E8\u7EF4\u5EA6: "All dimensions",
  "\u641C\u7D22\u6587\u4EF6 / \u6458\u8981\u2026": "Search file / summary\u2026",
  \u641C\u7D22\u6587\u4EF6\u6216\u6458\u8981: "Search file or summary",
  "\u6E05\u9664\u7B5B\u9009\uFF08\u663E\u793A {a0}\uFF09": "Clear filters (showing {a0})",
  "\u5171 {a0} \u9879": "{a0} in total",
  "\u6279\u91CF\u4F5C\u7528\u4E8E\uFF1A": "Batch applies to:",
  "\u6279\u91CF\u6309\u94AE\u4EC5\u4F5C\u7528\u4E8E\u5F53\u524D\u7B5B\u9009\u53EF\u89C1\u7684 findings": "Batch buttons only apply to the findings visible under the current filter",
  "\u53EF\u89C1 {a0}": "Visible {a0}",
  "\u6279\u91CF\u6309\u94AE\u4F5C\u7528\u4E8E\u5168\u90E8 findings": "Batch buttons apply to every finding",
  "\u5168\u90E8 {a0}": "All {a0}",
  "\u628A\u6240\u6709\u5224\u5B9A\u6062\u590D\u4E3A\u9ED8\u8BA4 y\uFF08\u4FEE\u590D\uFF09": "Reset every verdict to the default y (fix)",
  \u91CD\u7F6E: "Reset",
  "y {a0} \xB7 n {a1} \xB7 a {a2} \xB7 \u5F85\u5199\u56DE known_intentional\uFF1A{a3} \u6761": "y {a0} \xB7 n {a1} \xB7 a {a2} \xB7 pending known_intentional write-back: {a3}",
  "\u5F53\u524D\u6CA1\u6709\u6807\u8BB0\u4E3A\u300C\u5DF2\u77E5\u6709\u610F\u300D\u7684 finding": "No finding is marked known-intentional yet",
  "\u590D\u5236\u5E94\u7528\u6307\u4EE4\uFF1A\u7C98\u8D34\u540E\u6A21\u578B\u4F1A\u8C03\u7528 iterate_triage apply\uFF08\u6821\u9A8C\u3001\u53BB\u91CD\u3001\u5199\u5165\u524D\u5907\u4EFD\u3001\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\uFF09": "Copy the apply instruction: once pasted, the model calls iterate_triage apply (validates, dedupes, backs up before writing, rolls back on failure)",
  "\u751F\u6210\u5E94\u7528\u6307\u4EE4{a0}": "Generate apply instruction{a0}",
  "\u53EA\u590D\u5236 known_intentional YAML \u7247\u6BB5\uFF08\u9700\u81EA\u884C\u7C98\u5230 iterate.config.yaml \u7684 personalization.known_intentional \u4E0B\uFF09": "Copy only the known_intentional YAML fragment (you must paste it under personalization.known_intentional in iterate.config.yaml yourself)",
  "\u4EC5\u590D\u5236 YAML \u7247\u6BB5": "Copy YAML fragment only",
  "\u590D\u5236 iterate_triage list \u6307\u4EE4\uFF0C\u6838\u5BF9\u5DF2\u7ECF\u5199\u5165\u7684 known_intentional \u6761\u76EE\uFF08\u5199\u56DE\u95ED\u73AF\u786E\u8BA4\uFF09": "Copy the iterate_triage list instruction to check which known_intentional entries actually landed (write-back \u2192 readback)",
  \u56DE\u8BFB\u5DF2\u5199\u5165\u6761\u76EE: "Read back written entries",
  "\u5DF2\u590D\u5236\u5E94\u7528\u6307\u4EE4\u2014\u2014\u7C98\u8D34\u56DE\u4F1A\u8BDD\uFF0C\u6A21\u578B\u5C06\u8C03\u7528 iterate_triage apply \u5E76\u56DE\u62A5\u5199\u5165\u6761\u6570\u3002": "Apply instruction copied \u2014 paste it back into the chat and the model will call iterate_triage apply and report how many entries were written.",
  "\u5DF2\u590D\u5236\u56DE\u8BFB\u6307\u4EE4\u2014\u2014\u7C98\u8D34\u56DE\u4F1A\u8BDD\u53EF\u5217\u51FA\u5F53\u524D\u5DF2\u5199\u5165\u7684 known_intentional\u3002": "Readback instruction copied \u2014 paste it back to list the known_intentional entries currently written.",
  // ── command actions ──────────────────────────────────────────────────────
  \u6307\u6325\u64CD\u4F5C: "Command actions",
  "\u6279\u51C6\u67B6\u6784\u4FEE\u590D\uFF08\u590D\u5236\u6307\u4EE4\u6587\u672C\uFF1Aiterate_fix force:true\uFF0C\u542B\u5168\u90E8\u5FC5\u586B\u53C2\u6570\uFF09": "Approve the architectural fix (copies the instruction text: iterate_fix with force:true and every required argument)",
  \u6279\u51C6\u67B6\u6784\u4FEE\u590D: "Approve architectural fix",
  \u89E6\u53D1\u65B0\u4E00\u8F6E\u8FED\u4EE3\u5BA1\u67E5: "Trigger the next review round",
  \u89E6\u53D1\u65B0\u4E00\u8F6E: "New round",
  "\u6307\u6D3E\u5168\u90E8 {a0} \u4E2A findings \u4FEE\u590D\uFF08\u9010\u4E2A iterate_fix\uFF09": "Assign all {a0} findings for fixing (one iterate_fix each)",
  "\u6307\u6D3E\u5F53\u524D\u53EF\u89C1 {a0} \u4E2A findings \u4FEE\u590D\uFF08\u9010\u4E2A iterate_fix\uFF09": "Assign the {a0} visible findings for fixing (one iterate_fix each)",
  \u6307\u6D3E\u4FEE\u590D: "Assign fixes",
  \u56DE\u6EDA\u5230\u4E0A\u4E00\u4E2A\u68C0\u67E5\u70B9: "Roll back to the previous checkpoint",
  \u56DE\u6EDA\u68C0\u67E5\u70B9: "Rollback to checkpoint",
  // ── verdict banner / stats card ──────────────────────────────────────────
  \u62A5\u544A\u5DF2\u6279\u51C6: "Report approved",
  \u62A5\u544A\u9700\u4FEE\u8BA2: "Report needs revision",
  \u9879\u53D1\u73B0: " findings",
  \u8F6E: " rounds",
  \u9879\u5BA1\u67E5: " reviews",
  \u62A5\u544A\u901A\u8FC7\u5168\u90E8\u4E00\u81F4\u6027\u68C0\u67E5: "The report passed every consistency check",
  \u5904\u62A5\u544A\u7F3A\u9677: " report defects found",
  \u5DF2\u6536\u655B: "Converged",
  \u672A\u6536\u655B: "Not converged",
  "Round {a0} \u5B8C\u6210 \xB7 \u5DF2\u6536\u655B": "Round {a0} complete \xB7 converged",
  "Round {a0} \u5B8C\u6210": "Round {a0} complete",
  // ── settings ─────────────────────────────────────────────────────────────
  "\u5DF2\u6E05\u9664 {a0} \u6761": "Cleared {a0}",
  \u518D\u6B21\u70B9\u51FB\u4EE5\u786E\u8BA4\u6E05\u9664\u5168\u90E8\u5224\u5B9A: "Click again to confirm clearing every verdict",
  "\u6E05\u9664\u6240\u6709\u5206\u8BCA\u5224\u5B9A\u8BB0\u5F55\uFF08\u9700\u8981\u4E8C\u6B21\u786E\u8BA4\uFF09": "Clear every triage verdict (requires a second click)",
  "\u786E\u8BA4\u6E05\u9664\uFF1F": "Confirm clear?",
  \u6E05\u9664\u5206\u8BCA: "Clear triage",
  \u8FED\u4EE3\u4E3B\u9898: "Iterate theme",
  "\u542F\u7528\u6696\u7425\u73C0\u914D\u8272\u7684 iterate \u4E13\u5C5E\u76AE\u80A4\uFF0C\u8986\u76D6 dsh \u9ED8\u8BA4\u4E3B\u9898\u4EE4\u724C\u3002": "Enables the warm-amber iterate skin, overriding the default dsh theme tokens.",
  \u5DF2\u542F\u7528: "Enabled",
  \u5DF2\u5173\u95ED: "Off",
  "\u5F00\u5173 iterate \u4E3B\u9898": "Toggle the iterate theme",
  \u5206\u8BCA\u6301\u4E45\u5316: "Triage persistence",
  "y / n / a \u5224\u5B9A\u4FDD\u5B58\u5728\u672C\u5730\u6D4F\u89C8\u5668\uFF08localStorage\uFF09\uFF0C\u5237\u65B0\u4F1A\u8BDD\u540E\u4ECD\u4FDD\u7559\u3002": "y / n / a verdicts are stored in your browser (localStorage) and survive a session refresh.",
  \u672C\u5730\u4FDD\u5B58: "Stored locally",
  \u914D\u7F6E\u7BA1\u7406: "Configuration",
  "\u76EE\u6807 / \u7EF4\u5EA6 / \u6700\u5927\u8F6E\u6570 / validation.commands \u5199\u5728\u9879\u76EE\u7684 iterate.config.yaml\uFF0C\u590D\u5236\u6307\u5F15\u53EF\u8BA9\u6A21\u578B\u6309\u9700\u8C03\u6574\u3002": "Goal / dimensions / max rounds / validation.commands live in the project\u2019s iterate.config.yaml; copy the guide to let the model adjust them on demand.",
  \u590D\u5236\u6307\u5F15: "Copy guide",
  \u6536\u8D77: "Collapse",
  \u5C55\u5F00: "Expand",
  \u9009\u62E9\u8981\u4FEE\u6539\u7684\u914D\u7F6E\u5B57\u6BB5: "Pick the config field to edit",
  "\u751F\u6210\u5E76\u590D\u5236\u8BE5\u5B57\u6BB5\u7684 iterate_config \u5199\u5165\u6307\u4EE4\uFF08\u5199\u5165\u524D\u81EA\u52A8\u5907\u4EFD\u3001\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\uFF09": "Build and copy the iterate_config write instruction for this field (backs up first, rolls back on failure)",
  \u751F\u6210\u5199\u5165\u6307\u4EE4: "Build write instruction",
  "\u526A\u8D34\u677F\u88AB\u62D2\u7EDD\u2014\u2014\u6307\u4EE4\u5DF2\u5C55\u793A\u5728\u4E0B\u65B9\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\u3002": "The clipboard write was refused \u2014 the instruction is shown below, copy it manually.",
  "\u5199\u5165\u6307\u4EE4\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\uFF09": "Write instruction (paste to the model)",
  "\u5C1A\u672A\u56DE\u8BFB\u5F53\u524D\u914D\u7F6E\u2014\u2014\u70B9\u300C\u56DE\u8BFB\u5F53\u524D\u914D\u7F6E\u300D\u590D\u5236\u6307\u4EE4\u53D1\u7ED9\u6A21\u578B\uFF0C\u56DE\u663E\u540E\u5373\u53EF\u5728\u6B64\u770B\u5230\u5F53\u524D\u503C\u3002": "No config read back yet \u2014 press \u201CRead back current config\u201D, send the instruction to the model, and the current value shows up here.",
  "\u5F53\u524D\u503C {a0}\uFF1A{a1}": "Current value for {a0}: {a1}",
  "\u56DE\u8BFB\u7ED3\u679C\u4E2D\u6CA1\u6709 {a0}\uFF08\u8BE5\u5B57\u6BB5\u53EF\u80FD\u5C1A\u672A\u5199\u5165\u914D\u7F6E\u6587\u4EF6\uFF09\u3002": "The read-back does not contain {a0} (it may not have been written to the config file yet).",
  '\u590D\u5236\u56DE\u8BFB\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u8C03\u7528 iterate_config(operation:"read") \u5E76\u56DE\u663E\u7ED3\u679C': 'Copy the read-back instruction: have the model call iterate_config(operation:"read") and echo the result',
  \u56DE\u8BFB\u5F53\u524D\u914D\u7F6E: "Read back current config",
  "\u56DE\u8BFB\u6307\u4EE4\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\uFF09": "Read-back instruction (paste to the model)",
  \u590D\u5236: "Copy",
  "iterate.config.yaml \u53EF\u7F16\u8F91\u5B57\u6BB5": "Editable iterate.config.yaml fields",
  "\u4E2D\u6587\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u7684\u5951\u7EA6\u6587\u6848\uFF09": "Chinese (contract text to paste to the model)",
  \u72B6\u6001\u6982\u89C8: "Runtime status",
  "\u67E5\u770B\u8FD0\u884C\u65F6\u4EA7\u7269\u5E03\u5C40\u4E0E\u6E05\u7406\u6307\u5F15\u3002iterate_status / iterate_history / iterate_prune \u5DE5\u5177\u7528\u4E8E\u67E5\u770B\u548C\u7BA1\u7406\u3002": "The runtime artifact layout and cleanup guide. Use iterate_status / iterate_history / iterate_prune to inspect and manage them.",
  \u62C9\u53D6\u78C1\u76D8\u5FEB\u7167: "Pull disk snapshot",
  \u8FD0\u884C\u65F6\u5E03\u5C40\u4E0E\u6E05\u7406: "Runtime layout & cleanup",
  "\u4E3A\u6BCF\u6B21\u4EE3\u7801\u8BC4\u5BA1\u751F\u6210 Review \u62A5\u544A\u4E0E\u4EA4\u4E92\u5F0F\u5206\u8BCA\u89C6\u56FE\uFF0C\u4E13\u6CE8 AI \u81EA\u6211\u5BA1\u67E5\u4E0E\u4FEE\u6B63\u3002": "Generates a review report and an interactive triage view for every code review, focused on AI self-review and correction.",
  \u5C31\u7EEA: "Ready",
  "iterate \u8BBE\u7F6E": "iterate settings",
  "\u526A\u8D34\u677F\u5199\u5165\u88AB\u62D2\u7EDD\uFF0C\u590D\u5236\u672A\u751F\u6548\u2014\u2014\u8BF7\u5C55\u5F00\u5BF9\u5E94\u533A\u5757\u624B\u52A8\u9009\u4E2D\u6587\u672C\u590D\u5236\u3002": "The clipboard write was refused, so nothing was copied \u2014 expand the section and copy the text manually.",
  "\u754C\u9762\u8BED\u8A00": "Interface language",
  "\u9762\u677F\u6587\u6848\u7684\u663E\u793A\u8BED\u8A00\uFF1B\u590D\u5236\u7ED9\u6A21\u578B\u7684\u6307\u4EE4\u4FDD\u6301\u4E2D\u6587\uFF0C\u4E0E SKILL.md \u7684\u5DE5\u4F5C\u6D41\u5951\u7EA6\u4E00\u81F4\u3002": "The language of the panel copy. Instructions copied for the model stay Chinese \u2014 they mirror the SKILL.md workflow contract.",
  "\u5207\u6362\u754C\u9762\u8BED\u8A00": "Switch the interface language",
  // ── observatory shell / live feed ────────────────────────────────────────
  "{a0} \u9875 \xB7 \u6309 1-9/0 \u5207 Fn\u3001- \u56DE\u5B9E\u65F6\u6D41": "{a0} tabs \xB7 keys 1-9/0 switch Fn, - returns to the live feed",
  "\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u9010\u4E2A\u8C03\u7528 {a0} \u5E76\u56DE\u663E\u5B8C\u6574\u7ED3\u679C": "Copy the disk-snapshot instruction: have the model call {a0} and echo the full results",
  "iterate \u89C2\u6D4B\u53F0": "iterate observatory",
  "\u6682\u65E0\u8FD0\u884C\u65F6\u89C2\u6D4B\u6570\u636E \xB7 {a0}": "No runtime observations yet \xB7 {a0}",
  "\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u78C1\u76D8\u4E0A\u53EF\u80FD\u5DF2\u6709\u5386\u53F2\u4EA7\u7269\uFF0C\u56DE\u663E\u8FDB\u4F1A\u8BDD\u540E\u89C2\u6D4B\u53F0\u5373\u53EF\u586B\u5145": "Copy the disk-snapshot instruction: older artifacts may already be on disk; once echoed back into the chat the observatory fills up",
  "\u5B9E\u65F6\u6D3B\u52A8\u6D41\u4EC5\u5728\u8FD0\u884C\u671F\u95F4\u8BB0\u5F55\uFF0C\u5F53\u524D\u5DF2\u5B8C\u6210\u3002": "The live activity stream is only recorded while a run is active; this run has finished.",
  \u67E5\u770B\u5BA1\u67E5\u7EBF\u7A0B: "View review threads",
  \u67E5\u770B\u53D1\u73B0: "View findings",
  \u6682\u65E0\u5B9E\u65F6\u6D3B\u52A8: "No live activity yet",
  \u5B9E\u65F6\u6D3B\u52A8: "Live activity",
  \u6309\u6D3B\u52A8\u7C7B\u578B\u7B5B\u9009: "Filter by activity type",
  \u5168\u90E8\u6D3B\u52A8: "All activity",
  \u65E0\u5339\u914D\u7684\u5B9E\u65F6\u6D3B\u52A8: "No matching live activity",
  \u590D\u5236\u672A\u6210\u529F: "Copy failed",
  "\u526A\u8D34\u677F\u5199\u5165\u88AB\u62D2\u7EDD\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u4E0B\u65B9\u6307\u4EE4\u590D\u5236": "The clipboard write was refused \u2014 select the instruction below and copy it manually",
  \u5173\u95ED\u590D\u5236\u5931\u8D25\u63D0\u793A: "Dismiss the copy-failure notice",
  \u5173\u95ED: "Dismiss",
  "\u5C06\u89C2\u6D4B\u53F0\u5168\u90E8\u6570\u636E\u5BFC\u51FA\u4E3A JSON\uFF08\u4F18\u5148\u4E0B\u8F7D\uFF0C\u5931\u8D25\u5219\u590D\u5236\uFF09": "Export every observatory panel as JSON (downloads first, falls back to copying)",
  \u5DF2\u5BFC\u51FA: "Exported",
  "\u5BFC\u51FA JSON": "Export JSON",
  "\u89C2\u6D4B\u53F0\u9875\u7B7E\uFF08\u5FEB\u6377\u952E 1-9 / 0 / -\uFF09": "Observatory tabs (keys 1-9 / 0 / -)",
  "{a0}\uFF08\u6309 {a1} \u5207\u6362\uFF09": "{a0} (press {a1})",
  "{a0}\uFF08\u6309 - \u5207\u6362\uFF09": "{a0} (press -)",
  // ── F1 review threads ────────────────────────────────────────────────────
  \u6682\u65E0\u5BA1\u67E5\u7EBF\u7A0B: "No review threads yet",
  \u5BA1\u67E5\u7EBF\u7A0B: "Review threads",
  \u5C55\u5F00\u5168\u90E8\u7EBF\u7A0B: "Expand all threads",
  \u5168\u90E8\u5C55\u5F00: "Expand all",
  \u6536\u8D77\u5168\u90E8\u7EBF\u7A0B: "Collapse all threads",
  \u5168\u90E8\u6536\u8D77: "Collapse all",
  "{a0} \xB7 {a1} \u8F6E": "{a0} \xB7 {a1} rounds",
  \u81EA\u7531\u5207\u6362: "Mixed",
  \u672C\u8F6E\u65E0\u7EBF\u7A0B: "No threads in this round",
  \u672A\u547D\u540D\u7EF4\u5EA6: "Unnamed dimension",
  \u6536\u8D77\u7EBF\u7A0B: "Collapse thread",
  \u5C55\u5F00\u7EBF\u7A0B: "Expand thread",
  \u53D9\u8FF0: "Narration",
  "{a0} \u6761": "{a0}",
  \u65E0\u7EBF\u7D22\u53D9\u8FF0: "No narration recorded",
  \u8BFB\u53D6\u6587\u4EF6: "Files read",
  \u672C\u7EBF\u7A0B\u65E0\u53D1\u73B0: "This thread found nothing",
  "{a0} \u7EBF\u7A0B": "{a0} threads",
  // ── F2 convergence trend ─────────────────────────────────────────────────
  \u6682\u65E0\u6536\u655B\u6570\u636E: "No convergence data yet",
  \u5DF2\u4FEE\u590D: "Fixed",
  \u4E25\u91CD\u5EA6\u5206\u5E03: "Severity mix",
  \u9A8C\u8BC1: "Validation",
  "{a0}/{a1} \u901A\u8FC7{a2}": "{a0}/{a1} passed{a2}",
  "\uFF08\u542B\u5931\u8D25\uFF09": " (failures included)",
  "\u5404\u8F6E\u53D1\u73B0\u6570\u91CF\uFF1A{a0}{a1}": "Findings per round: {a0}{a1}",
  " \xB7 \u5F53\u524D Round {a0}": " \xB7 current round {a0}",
  "\u8DE8\u8F6E\u5BF9\u6BD4\uFF08\u672C\u4F1A\u8BDD\uFF09": "Cross-round comparison (this session)",
  "\u8DE8\u4F1A\u8BDD\u5BF9\u6BD4\uFF1A\u672C\u8868\u53EA\u8986\u76D6\u5F53\u524D\u4F1A\u8BDD\uFF1B\u70B9\u300C\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u300D\u8BA9\u6A21\u578B\u56DE\u663E iterate_history\uFF0C\u518D\u7528\u300C\u5BFC\u51FA JSON\u300D\u5E76\u6392\u6BD4\u8F83\u4E24\u6B21\u8FD0\u884C": 'Cross-session comparison: this table only covers the current session \u2014 click "Pull disk snapshot" to have the model echo iterate_history, then use "Export JSON" to compare two runs side by side',
  // ── F3 finding locations ─────────────────────────────────────────────────
  \u6682\u65E0\u53D1\u73B0: "No findings",
  "{a0}\uFF08{a1} \u9879\uFF09": "{a0} ({a1} findings)",
  "\u641C\u7D22\u53D1\u73B0\u2026": "Search findings\u2026",
  \u641C\u7D22\u53D1\u73B0: "Search findings",
  \u6E05\u9664\u5168\u90E8\u7B5B\u9009: "Clear all filters",
  \u6E05\u9664\u7B5B\u9009: "Clear filters",
  \u5DF2\u786E\u8BA4: "Acknowledged",
  "\u590D\u5236\u8BE5 finding \u7684\u5EFA\u8BAE\u4FEE\u590D\u6587\u672C": "Copy this finding\u2019s suggested fix text",
  "\u590D\u5236 suggested_fix": "Copy suggested_fix",
  "\u590D\u5236 iterate_triage \u6307\u4EE4\u6587\u672C\uFF08\u6807\u8BB0\u4E3A known_intentional\uFF09": "Copy the iterate_triage instruction text (mark as known_intentional)",
  "\u590D\u5236 iterate_fix \u6307\u4EE4\u6587\u672C": "Copy the iterate_fix instruction text",
  \u590D\u5236\u4FEE\u590D\u6307\u4EE4: "Copy fix instruction",
  \u65E0\u5339\u914D\u7684\u53D1\u73B0: "No matching findings",
  // ── F4 fixes & rollback ──────────────────────────────────────────────────
  \u6682\u65E0\u4FEE\u590D\u8BB0\u5F55: "No fixes recorded yet",
  \u6210\u529F: "Success",
  \u5931\u8D25: "Failed",
  "\u590D\u5236 iterate_rollback \u6307\u4EE4\u6587\u672C": "Copy the iterate_rollback instruction text",
  \u56DE\u6EDA: "Rollback",
  // ── F5 checkpoint ────────────────────────────────────────────────────────
  \u65AD\u70B9: "Checkpoint",
  "\u590D\u5236 iterate_checkpoint resume \u6307\u4EE4\u6587\u672C\uFF08\u52A0\u8F7D\u65AD\u70B9\u5E76\u8BA1\u6570\u4E00\u6B21\u6062\u590D\uFF09": "Copy the iterate_checkpoint resume instruction (loads the checkpoint and counts one resume)",
  \u590D\u5236\u6062\u590D\u6307\u4EE4: "Copy resume instruction",
  "\u590D\u5236 iterate_checkpoint clear \u6307\u4EE4\u6587\u672C\uFF08\u6E05\u9664\u5F53\u524D\u65AD\u70B9\uFF0C\u4F9B\u91CD\u65B0\u5F00\u59CB\uFF09": "Copy the iterate_checkpoint clear instruction (drops the current checkpoint so you can start over)",
  \u6E05\u9664\u65AD\u70B9: "Clear checkpoint",
  // ── F6 run console ───────────────────────────────────────────────────────
  \u8BE2\u95EE\u7528\u6237: "Ask the user",
  \u62D2\u7EDD: "Deny",
  \u76F4\u63A5\u6267\u884C: "Run directly",
  "\u8BF7\u8C03\u7528 `iterate_transcript` \u5199\u5165 nudge \u6307\u4EE4\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_transcript` to write this nudge instruction:\n\n```json\n{a0}\n```",
  "\u8BF7\u8C03\u7528 `iterate_transcript` \u6E05\u9664\u5F53\u524D nudge\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_transcript` to clear the current nudge:\n\n```json\n{a0}\n```",
  \u901A\u8FC7: "Passed",
  \u5BFC\u81F4\u4E2D\u6B62: " aborted the run",
  \u9A8C\u8BC1\u7ED3\u679C: "Validation results",
  \u672C\u8F6E\u5C1A\u65E0\u9A8C\u8BC1\u8BB0\u5F55: "No validation was recorded in this round",
  "{a0} \u6761\u547D\u4EE4": "{a0} commands",
  \u56E0\u9A8C\u8BC1\u5931\u8D25\u4E2D\u6B62: "Stopped because validation failed",
  "\u5C1A\u672A\u62C9\u53D6\u9A8C\u8BC1\u7ED3\u679C\uFF1A\u6570\u636E\u5728\u78C1\u76D8 transcript \u91CC\uFF0C\u70B9\u300C\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u300D\u590D\u5236\u6307\u4EE4\u53D1\u56DE\u4F1A\u8BDD\u5373\u53EF\u56DE\u586B\u3002": 'Validation results have not been pulled yet: they live in the transcript on disk \u2014 click "Pull disk snapshot", paste the instruction back into the chat, and this panel fills.',
  \u8FD0\u884C\u63A7\u5236\u53F0: "Run console",
  "\u6279\u51C6\u7B56\u7565\uFF1A{a0}": "Approval policy: {a0}",
  "\u5F53\u524D nudge": "Current nudge",
  "\u590D\u5236\u6E05\u9664 nudge \u6307\u4EE4\uFF08\u5199 text:null\uFF09\uFF0C\u5728\u8FD0\u884C\u63A7\u5236\u53F0\u63D0\u793A\u6E05\u9664\u5DF2\u6301\u4E45\u5316\u7684 nudge": "Copy the clear-nudge instruction (writes text:null) to ask the model to drop the persisted nudge",
  \u5DF2\u590D\u5236\u6E05\u9664\u6307\u4EE4: "Clear instruction copied",
  \u590D\u5236\u6E05\u9664\u6307\u4EE4: "Copy clear instruction",
  "\u8D77\u8349\u4E00\u6761 nudge \u65B9\u5411\u6307\u4EE4\u2026": "Draft a nudge to steer the run\u2026",
  "nudge \u8349\u7A3F": "Nudge draft",
  "\u590D\u5236 iterate_transcript nudge \u6307\u4EE4\u6587\u672C": "Copy the iterate_transcript nudge instruction text",
  "\u590D\u5236 nudge \u6307\u4EE4": "Copy nudge instruction",
  // ── F7 decision timeline ─────────────────────────────────────────────────
  \u6682\u65E0\u65F6\u95F4\u7EBF\u6761\u76EE: "No timeline entries yet",
  \u65F6\u95F4\u7EBF: "Timeline",
  \u6309\u65F6\u95F4\u7EBF\u7C7B\u578B\u7B5B\u9009: "Filter the timeline by type",
  \u5168\u90E8\u7C7B\u578B: "All types",
  \u6309\u8F6E\u6B21\u7B5B\u9009: "Filter by round",
  \u5168\u90E8\u8F6E\u6B21: "All rounds",
  "\u641C\u7D22\u65F6\u95F4\u7EBF\u2026": "Search timeline\u2026",
  \u641C\u7D22\u65F6\u95F4\u7EBF: "Search timeline",
  \u6E05\u9664: "Clear",
  \u65E0\u5339\u914D\u7684\u65F6\u95F4\u7EBF\u6761\u76EE: "No matching timeline entries",
  // ── F8 quality gate ──────────────────────────────────────────────────────
  \u8D28\u91CF\u95E8\u7981: "Quality gate",
  "\u590D\u5236 iterate_quality_gate \u67E5\u8BE2\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09": "Copy the iterate_quality_gate query instruction (JSON arguments included)",
  \u67E5\u8BE2\u95E8\u7981: "Query gate",
  "\u590D\u5236 iterate_quality_gate clear \u6307\u4EE4\u6587\u672C\uFF08\u91CD\u7F6E\u9648\u65E7\u7684 FAIL \u8BC1\u4E66\uFF09": "Copy the iterate_quality_gate clear instruction (resets a stale FAIL certificate)",
  \u6E05\u9664\u95E8\u7981: "Clear gate",
  "\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u56DE\u663E .iterate/ \u4E0B\u7684\u95E8\u7981\u3001\u7ECF\u9A8C\u3001\u9632\u5FA1\u4E8B\u4EF6\u4E0E transcript": "Copy the disk-snapshot instruction: have the model echo the gate, experience, defense events and transcript artifacts under .iterate/",
  \u8D28\u91CF\u95E8\u7981\u89C6\u56FE: "Quality gate view",
  \u8D28\u91CF\u95E8\u7981\u8BC1\u4E66: "Quality gate certificate",
  "\u8D28\u91CF\u95E8\u7981\u663E\u793A\u5404\u7EF4\u5EA6\u6536\u655B\u5EA6\u3001\u9A8C\u8BC1\u901A\u8FC7\u7387\u548C\u6574\u4F53 PASS/FAIL \u72B6\u6001\u3002": "The quality gate shows per-dimension convergence, the validation pass rate and the overall PASS/FAIL state.",
  \u590D\u5236\u67E5\u8BE2\u6307\u4EE4: "Copy query instruction",
  \u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4: "Copy disk-snapshot instruction",
  "\u6574\u4F53\u8BC4\u5206 {a0} \xB7 \u9A8C\u8BC1 {a1}/{a2} \xB7 \u901A\u8FC7\u7387 {a3}%": "Overall score {a0} \xB7 validation {a1}/{a2} \xB7 pass rate {a3}%",
  "{a0} \xB7 \u6536\u655B {a1}% \xB7 \u8BC4\u5206 {a2}": "{a0} \xB7 convergence {a1}% \xB7 score {a2}",
  "\u8BC4\u5206 {a0} \xB7 \u53D1\u73B0 {a1} \xB7 \u5DF2\u4FEE\u590D {a2}": "Score {a0} \xB7 findings {a1} \xB7 fixed {a2}",
  "\u5931\u8D25\u539F\u56E0\uFF1A{a0}": "Failure reason: {a0}",
  // ── F9 experience bank ───────────────────────────────────────────────────
  "\u8BF7\u8C03\u7528 `iterate_experience` \u641C\u7D22\u7ECF\u9A8C\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_experience` to search the experience bank:\n\n```json\n{a0}\n```",
  "\u8BF7\u8C03\u7528 `iterate_experience` \u91C7\u7EB3\u7ECF\u9A8C\u5E76\u5E94\u7528\u5DF2\u9A8C\u8BC1\u4FEE\u6CD5\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_experience` to adopt this entry and apply its verified fix:\n\n```json\n{a0}\n```",
  "\u547D\u4E2D {a0} \u6B21": "Hit {a0} times",
  "\u590D\u5236\u91C7\u7EB3\u6307\u4EE4\uFF08\u67E5\u8BE2\u8BE5\u7ECF\u9A8C\u5E76\u5E94\u7528\u5230\u5F53\u524D\u4E0A\u4E0B\u6587\uFF09": "Copy the adopt instruction (queries this entry and applies it to the current context)",
  \u91C7\u7EB3: "Adopt",
  \u7ECF\u9A8C\u94F6\u884C: "Experience bank",
  "\u4F1A\u8BDD\u5185 {a0} \u6761": "{a0} in this session",
  "\u590D\u5236\u5217\u51FA\u7ECF\u9A8C\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09": "Copy the list-experience instruction (JSON arguments included)",
  \u5217\u51FA\u7ECF\u9A8C: "List experiences",
  "\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u628A .iterate/ \u4E0B\u7684\u7ECF\u9A8C\u94F6\u884C\u7B49\u4EA7\u7269\u56DE\u663E\u8FDB\u4F1A\u8BDD": "Copy the disk-snapshot instruction: echo the experience bank and other .iterate/ artifacts back into the chat",
  "\u641C\u7D22\u7ECF\u9A8C\u6A21\u5F0F\u2026": "Search experience patterns\u2026",
  \u641C\u7D22\u7ECF\u9A8C: "Search experiences",
  \u590D\u5236\u641C\u7D22\u6307\u4EE4: "Copy search instruction",
  \u641C\u7D22: "Search",
  "\u6CA1\u6709\u5339\u914D\u300C": "No experience matches \u201C",
  "\u300D\u7684\u7ECF\u9A8C": "\u201D",
  "\u4E5F\u53EF\u70B9\u300C\u5217\u51FA\u7ECF\u9A8C\u300D\u67E5\u8BE2\u78C1\u76D8\u4E0A\u7684\u5168\u90E8\u5386\u53F2\u7ECF\u9A8C\u3002": 'You can also click "List experiences" to query every historical entry on disk.',
  // ── F10 defense events ───────────────────────────────────────────────────
  "\u8BF7\u8C03\u7528 `iterate_defense_events` \u67E5\u8BE2\u9632\u5FA1\u4E8B\u4EF6\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_defense_events` to query defense events:\n\n```json\n{a0}\n```",
  \u524D\u7F6E\u6821\u9A8C\u5931\u8D25: "Precondition failed",
  \u4E0D\u53D8\u91CF\u8FDD\u53CD: "Invariant violated",
  \u5047\u8BBE\u88AB\u8BC1\u4F2A: "Assumption falsified",
  \u9632\u5FA1\u4E8B\u4EF6: "Defense events",
  "\u4F1A\u8BDD\u5185 {a0} \u6761 / \u7D2F\u8BA1 {a1}": "{a0} in this session / {a1} total",
  "\u590D\u5236\u5217\u51FA\u9632\u5FA1\u4E8B\u4EF6\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09": "Copy the list-defense-events instruction (JSON arguments included)",
  \u5217\u51FA\u4E8B\u4EF6: "List events",
  "\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u628A .iterate/ \u4E0B\u7684\u9632\u5FA1\u4E8B\u4EF6\u6D41\u56DE\u663E\u8FDB\u4F1A\u8BDD": "Copy the disk-snapshot instruction: echo the defense event stream under .iterate/ back into the chat",
  "\u8BF7\u8C03\u7528 `iterate_defense_events` \u67E5\u8BE2\u4E8B\u4EF6\u7EDF\u8BA1\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_defense_events` for the event counts:\n\n```json\n{a0}\n```",
  "\u590D\u5236\u7EDF\u8BA1\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09": "Copy the counts instruction (JSON arguments included)",
  \u7EDF\u8BA1: "Counts",
  "\u8BF7\u8C03\u7528 `iterate_defense_events` \u6E05\u9664\u9632\u5FA1\u4E8B\u4EF6\u6D41\uFF1A\n\n```json\n{a0}\n```": "Please call `iterate_defense_events` to clear the defense event stream:\n\n```json\n{a0}\n```",
  "\u590D\u5236 iterate_defense_events clear \u6307\u4EE4\u6587\u672C\uFF08\u91CD\u7F6E\u9648\u65E7\u4E8B\u4EF6\u6D41\uFF09": "Copy the iterate_defense_events clear instruction (resets a stale event stream)",
  \u6E05\u9664\u4E8B\u4EF6: "Clear events",
  \u9632\u5FA1\u4E8B\u4EF6\u6D41: "Defense event stream",
  "\u9632\u5FA1\u4E8B\u4EF6\u5305\u62EC\uFF1A\u524D\u7F6E\u6821\u9A8C\u5931\u8D25\u3001\u56DE\u6EDA\u3001\u4E0D\u53D8\u91CF\u8FDD\u53CD\u3001\u5047\u8BBE\u88AB\u8BC1\u4F2A\u3002": "Defense events cover failed preconditions, rollbacks, violated invariants and falsified assumptions.",
  \u6309\u4E8B\u4EF6\u7C7B\u578B\u7B5B\u9009: "Filter by event type",
  \u6E05\u9664\u7C7B\u578B\u7B5B\u9009: "Clear type filter",
  "\u9632\u7EBF\uFF1A{a0}": "Defense: {a0}",
  \u6CA1\u6709\u5339\u914D\u8BE5\u7C7B\u578B\u7684\u9632\u5FA1\u4E8B\u4EF6: "No defense events of this type",
  // ── copy feedback ────────────────────────────────────────────────────────
  \u5DF2\u590D\u5236: "Copied",
  \u590D\u5236\u5931\u8D25: "Copy failed"
};
var current = "zh";
var storage = null;
var listeners = /* @__PURE__ */ new Set();
function getLang() {
  return current;
}
function setLang(next, persist = true) {
  if (next !== current) {
    current = next;
    if (persist) {
      try {
        storage?.set(LANG_STORAGE_KEY, next);
      } catch {
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
      }
    }
  }
}
function subscribeLang(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function configureLangStorage(next) {
  storage = next;
}
function detectLang(stored, navigatorLanguage) {
  if (stored === "en" || stored === "zh") return stored;
  return /^zh\b/i.test(navigatorLanguage ?? "") ? "zh" : "en";
}
function t(key) {
  return current === "en" ? EN[key] ?? key : key;
}
function tf(template, params = {}) {
  const translated = current === "en" ? EN[template] ?? template : template;
  return translated.replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (whole, name2) => Object.prototype.hasOwnProperty.call(params, name2) ? String(params[name2]) : whole
  );
}

// src/client/session-cache.ts
var current2 = null;
var listeners2 = /* @__PURE__ */ new Set();
function noteSession(session) {
  if (Object.is(session, current2)) return;
  current2 = session;
  for (const listener of [...listeners2]) listener();
}
function readSession() {
  return current2;
}
function subscribeSession(listener) {
  listeners2.add(listener);
  return () => {
    listeners2.delete(listener);
  };
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
.iterate-btn[data-failed], .iterate-cmd[data-failed] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
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
.iterate-filter-chip { padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.iterate-filter-chip:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.iterate-filter-chip[data-active] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); font-weight: 600; }
.iterate-filter-clear { padding: 3px 9px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); color: var(--dsw-alias-state-warn-primary); background: transparent; font-size: 11px; cursor: pointer; }
.iterate-filter-clear:hover { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
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
/* Live workflow-phase chip (dashboard) */
.iterate-chip-phase { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent); }
.iterate-chip-phase[data-live] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }

/* v3.0: task_mode indicator chip */
.iterate-chip-taskmode { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.iterate-chip-taskmode[data-mode="code"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); }
.iterate-chip-taskmode[data-mode="iterate"] { color: #B45309; background: color-mix(in srgb, #B45309 12%, transparent); border: 1px solid color-mix(in srgb, #B45309 28%, transparent); }

/* v3.0: Quality gate status */
.iterate-gate { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.iterate-gate[data-status="pass"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
.iterate-gate[data-status="fail"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); }
.iterate-gate[data-status="pending"] { color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent); }

/* v3.0: Experience bank hit highlight */
.iterate-exp-hit { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); font-size: 11px; color: var(--dsw-alias-state-success-primary); }
.iterate-exp-hit b { font-weight: 600; }

/* v3.0: Defense event type badges */
.iterate-defense-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.iterate-defense-badge[data-type="precondition_failed"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); }
.iterate-defense-badge[data-type="rollback"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent); }
.iterate-defense-badge[data-type="invariant_violated"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); }
.iterate-defense-badge[data-type="assumption_falsified"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); }

/* v3.0: Command buttons */
.iterate-cmd { padding: 4px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 11px; cursor: pointer; font-weight: 500; }
.iterate-cmd:hover { background: var(--dsw-alias-bg-layer-2); }
.iterate-cmd[data-primary] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.iterate-cmd[data-danger] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); }
.iterate-cmd:disabled { opacity: 0.5; cursor: not-allowed; }

/* v3.0: Dimension score bar */
.iterate-dim-score { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.iterate-dim-score-bar { width: 60px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.iterate-dim-score-fill { height: 100%; border-radius: 3px; transition: width 300ms ease; }
.iterate-dim-score-fill[data-status="pass"] { background: var(--dsw-alias-state-success-primary); }
.iterate-dim-score-fill[data-status="warn"] { background: var(--dsw-alias-state-warn-primary); }
.iterate-dim-score-fill[data-status="fail"] { background: var(--dsw-alias-state-error-primary); }

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
.iterate-dashboard-launch { display: inline-flex; align-items: center; gap: 6px; }

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

/* \u2500\u2500 Runtime observatory panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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
/* Gap #6: validation / gate status colors (pass=green, fail=red). */
.iterate-obs-chip[data-status="pass"], .iterate-obs-badge[data-status="pass"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
.iterate-obs-chip[data-status="fail"], .iterate-obs-badge[data-status="fail"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); }
.iterate-obs-row[data-status="fail"] { color: var(--dsw-alias-state-error-primary); }
.iterate-obs-row[data-highlight] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); border-radius: 6px; padding-left: 6px; padding-right: 6px; border-bottom-color: transparent; font-weight: 600; }
/* Gap #13: cross-round comparison table. */
.iterate-obs-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.iterate-obs-table th, .iterate-obs-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.iterate-obs-table th { color: var(--dsw-alias-label-secondary); font-weight: 600; }
.iterate-obs-table td { color: var(--dsw-alias-label-primary); }
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
.iterate-obs-livebadge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; border: 1px solid currentColor; background: color-mix(in srgb, currentColor 10%, transparent); font-size: 10.5px; font-weight: 600; white-space: nowrap; }
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
  if (!storage2) return 0;
  let removed = 0;
  try {
    for (const key of storage2.keys()) {
      if (key.startsWith(prefix)) {
        storage2.remove(key);
        removed++;
      }
    }
  } catch (err) {
    log("failed to clear storage prefix", prefix, err);
  }
  return removed;
}
function useLang() {
  const [lang, set] = React.useState(getLang());
  React.useEffect(() => subscribeLang(set), []);
  return lang;
}
function useSessionSnapshot() {
  return React.useSyncExternalStore(subscribeSession, readSession, readSession);
}
function withLang(Component) {
  return function LangScoped(props) {
    useLang();
    return React.createElement(Component, props);
  };
}
function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
  }
  return Promise.resolve(false);
}
function downloadTextFile(filename, text) {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
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
function formatConfigValue(value) {
  if (typeof value === "string") return value;
  if (value === void 0) return "\u2014";
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function parenthesize(label) {
  return getLang() === "en" ? ` (${label})` : `\uFF08${label}\uFF09`;
}
function runStatusText(live, manifest) {
  if (live) return t("\u8FD0\u884C\u4E2D");
  const reason = manifest && typeof manifest.stoppedReason === "string" ? manifest.stoppedReason : "";
  return reason ? stoppedReasonLabel(reason, getLang()) : t("\u5DF2\u7ED3\u675F");
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
var storage2 = null;
var themeDisposer = null;
var themeListener = null;
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
function registerThemeListener(ctx) {
  if (typeof ctx.on !== "function") return;
  if (themeListener) {
    try {
      themeListener();
    } catch {
    }
    themeListener = null;
  }
  const off = ctx.on("theme/change", () => {
    if (themeEnabled) applyThemeSkin();
  });
  themeListener = typeof off === "function" ? off : null;
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      if (themeListener) {
        try {
          themeListener();
        } catch {
        }
        themeListener = null;
      }
    });
  }
}
function setThemeEnabled(enabled) {
  themeEnabled = enabled;
  if (storage2) storage2.set(THEME_STORAGE_KEY, enabled ? "1" : "0");
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
      title: tf(`Round {a0}\uFF1A{a1} \u9879`, { a0: p.round, a1: p.count }),
      style: { height: `${Math.max(4, Math.round(p.count / max * 24))}px` }
    })
  );
  const summary = points.map((p) => `Round ${p.round}: ${p.count}`).join(", ");
  return React.createElement("div", {
    className: "iterate-trend",
    role: "img",
    "aria-label": tf(`\u5404\u8F6E\u53D1\u73B0\u6570\u91CF\u8D8B\u52BF\uFF1A{a0}`, { a0: summary })
  }, ...bars);
}
function StartIterationButton() {
  const [copied, setCopied] = React.useState(null);
  const [failed, setFailed] = React.useState(null);
  const timers = React.useRef([]);
  React.useEffect(
    () => () => {
      for (const t2 of timers.current) clearTimeout(t2);
      timers.current = [];
    },
    []
  );
  const copy = (key, text) => {
    copyText(text).then((ok) => {
      if (ok) {
        setFailed(null);
        setCopied(key);
        const t2 = window.setTimeout(() => setCopied((cur) => cur === key ? null : cur), 1600);
        timers.current.push(t2);
      } else {
        setCopied(null);
        setFailed(key);
      }
    });
  };
  const btn = (key, label, command, primary, title) => React.createElement("button", {
    key,
    className: "iterate-cmd",
    "data-primary": primary ? "" : void 0,
    "data-copied": copied === key ? "" : void 0,
    "data-failed": failed === key ? "" : void 0,
    onClick: () => copy(key, command),
    title
  }, copied === key ? t("\u5DF2\u590D\u5236") : failed === key ? t("\u590D\u5236\u5931\u8D25") : label);
  return React.createElement(
    "span",
    { className: "iterate-dashboard-launch" },
    btn("start-full", t("\u5B8C\u6574\u8FED\u4EE3"), START_INSTRUCTIONS.full, true, t("\u590D\u5236\u542F\u52A8\u6307\u4EE4\uFF1A\u5B8C\u6574\u300C\u5BA1\u67E5 \u2192 \u4FEE\u590D \u2192 \u9A8C\u8BC1 \u2192 \u590D\u76D8\u300D\u95ED\u73AF\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u5373\u53EF\uFF09")),
    btn("start-review", t("\u4EC5\u8BC4\u5BA1"), START_INSTRUCTIONS.reviewOnly, false, t("\u590D\u5236\u542F\u52A8\u6307\u4EE4\uFF1A\u53EA\u5BA1\u67E5\u4E0D\u4FEE\u6539\uFF08dry-run\uFF09\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u5373\u53EF\uFF09"))
  );
}
function ConvergenceDashboard(props) {
  const [pulseKey, setPulseKey] = React.useState(0);
  const session = props && props.session ? props.session : null;
  React.useEffect(() => {
    noteSession(session);
  }, [session]);
  const report = latestReport(session);
  React.useEffect(() => {
    if (!report) return;
    const cur = getCurrentRound(report);
    const conv = report.convergence;
    emitRoundPulse(cur, conv?.converged === true);
    setPulseKey((k) => k + 1);
  }, [report && hashReport(report) + ":" + getCurrentRound(report)]);
  if (!report) {
    const runState = dashboardRunState(latestTranscript(session));
    if (runState.state === "running") {
      return React.createElement(
        "div",
        { "data-iterate-root": "", "data-iterate": "dashboard", "data-run-state": "running", className: "iterate-dashboard iterate-dashboard-empty" },
        React.createElement("span", { className: "iterate-round-badge", "data-live": "" }, t("\u8FD0\u884C\u4E2D")),
        React.createElement(
          "span",
          { className: "iterate-empty-hint" },
          tf(`\u7B2C {a0} \u8F6E\u8FDB\u884C\u4E2D{a1}\u2014\u2014\u9996\u8F6E\u6C47\u603B\u62A5\u544A\u843D\u5730\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u6536\u655B\u8FDB\u5EA6\u4E0E\u53D1\u73B0\u7EDF\u8BA1\u3002`, { a0: String(runState.round), a1: runState.phase ? tf(` \xB7 \u9636\u6BB5\u300C{a0}\u300D`, { a0: runState.phase }) : "" })
        )
        // No start button while a run is active.
      );
    }
    if (runState.state === "done") {
      return React.createElement(
        "div",
        { "data-iterate-root": "", "data-iterate": "dashboard", "data-run-state": "done", className: "iterate-dashboard iterate-dashboard-empty" },
        React.createElement("span", { className: "iterate-round-badge" }, t("\u5DF2\u7ED3\u675F")),
        React.createElement(
          "span",
          { className: "iterate-empty-hint" },
          tf(`\u4E0A\u6B21\u8FED\u4EE3\u5728\u7B2C {a0} \u8F6E\u540E\u505C\u6B62{a1}\uFF0C\u4F46\u6CA1\u6709\u53EF\u5C55\u793A\u7684\u6C47\u603B\u62A5\u544A\u3002`, { a0: String(runState.round), a1: runState.stoppedReason ? parenthesize(stoppedReasonLabel(runState.stoppedReason, getLang())) : "" })
        ),
        React.createElement(StartIterationButton, null)
      );
    }
    return React.createElement(
      "div",
      { "data-iterate-root": "", "data-iterate": "dashboard", "data-run-state": "empty", className: "iterate-dashboard iterate-dashboard-empty" },
      React.createElement("span", { className: "iterate-round-badge" }, "iterate"),
      React.createElement("span", { className: "iterate-empty-hint" }, t("\u8FD0\u884C\u4E00\u6B21\u8BC4\u5BA1\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u6536\u655B\u8FDB\u5EA6\u4E0E\u53D1\u73B0\u7EDF\u8BA1\u3002")),
      React.createElement(StartIterationButton, null)
    );
  }
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
    title: t("\u672C\u6B21\u8FED\u4EE3\u4ECE\u4E0A\u4E00\u6B21\u4E2D\u65AD\u7684\u65AD\u70B9\u7EE7\u7EED\u6267\u884C")
  }, tf(`\u5DF2\u4E2D\u65AD\u6062\u590D \xD7{a0}`, { a0: String(resumeCount) })) : null;
  const imageChip = imageCount > 0 ? React.createElement("span", {
    className: "iterate-chip-images",
    key: "images",
    title: t("\u4F1A\u8BDD\u4E2D\u68C0\u6D4B\u5230\u7528\u6237\u9644\u5E26\u7684\u56FE\u7247\uFF0C\u8BC4\u5BA1\u5C06\u4F5C\u4E3A\u89C6\u89C9\u8BC1\u636E\u53C2\u8003")
  }, tf(`\u9644\u4EF6\u56FE\u7247 {a0}`, { a0: String(imageCount) })) : null;
  const transcript = latestTranscript(session);
  const phase = transcript ? latestPhase(transcript.phases) : "";
  const liveChip = transcript && phase ? React.createElement("span", {
    className: "iterate-chip-phase",
    key: "phase",
    "data-live": transcript.active === true ? "" : void 0,
    title: transcript.active === true ? tf(`\u5F53\u524D\u5904\u4E8E\u300C{a0}\u300D\u9636\u6BB5\uFF08\u8FD0\u884C\u4E2D\uFF09`, { a0: phase }) : tf(`\u6700\u8FD1\u4E00\u6B21\u6267\u884C\u505C\u7559\u5728\u300C{a0}\u300D\u9636\u6BB5\uFF08\u5DF2\u7ED3\u675F\uFF09`, { a0: phase })
  }, `${phase} \xB7 ${runStatusText(transcript.active === true, transcript)}`) : null;
  const taskModeTranscript = latestTranscript(session);
  const taskMode = taskModeTranscript?.taskMode;
  const taskModeChip = taskMode ? React.createElement("span", {
    className: "iterate-chip-taskmode",
    key: "taskmode",
    "data-mode": taskMode,
    title: taskMode === "code" ? t("\u4EE3\u7801\u6A21\u5F0F\uFF1A\u76F4\u63A5\u4FEE\u6539\u6587\u4EF6") : t("\u8FED\u4EE3\u6A21\u5F0F\uFF1A\u5BA1\u67E5-\u4FEE\u590D\u5FAA\u73AF")
  }, taskMode === "code" ? "\u25CF code" : "\u25CF iterate") : null;
  const dimNames = Object.keys(dims);
  const dimBadges = dimNames.slice(0, 6).map(
    (dim) => React.createElement(
      "span",
      { key: dim, className: "iterate-dim-badge" },
      `${dim} \xB7 ${dims[dim]?.length ?? 0}`
    )
  );
  const overflow = dimNames.length - 6;
  if (overflow > 0) {
    dimBadges.push(
      React.createElement(
        "span",
        { key: "+more", className: "iterate-dim-badge iterate-dim-more", title: dimNames.slice(6).join(", ") },
        tf(`+{a0} \u66F4\u591A`, { a0: overflow })
      )
    );
  }
  const mode = report.mode;
  const summary = report.summary;
  const isNormal = mode === "normal";
  const fixCount = isNormal && summary && typeof summary.fixedCount === "number" ? summary.fixedCount : null;
  const fixBadge = fixCount !== null ? React.createElement("span", {
    className: "iterate-metric",
    key: "fixes",
    title: t("\u672C\u8F6E\u5DF2\u5E94\u7528\u7684\u539F\u5B50\u4FEE\u590D\u6570\uFF08\u6B63\u5E38\u6A21\u5F0F\uFF09")
  }, `${String(fixCount)} fixes`) : null;
  const converged = report.convergence && report.convergence.converged === true;
  const convChip = converged ? React.createElement("span", {
    className: "iterate-chip-resume",
    key: "converged",
    title: t("\u5BA1\u67E5\u5DF2\u6536\u655B\uFF1A\u6700\u540E\u4E00\u8F6E\u672A\u53D1\u73B0\u65B0\u95EE\u9898")
  }, t("\u2713 \u5DF2\u6536\u655B")) : null;
  const sevMetric = (key, label) => React.createElement(
    "span",
    { className: "iterate-metric", key, title: label },
    React.createElement("span", { className: "iterate-sev-dot", style: { background: SEVERITY_COLOR[key] } }),
    `${label} ${String(stats[key])}`
  );
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
      React.createElement("div", {
        className: converged ? "iterate-progress-fill iterate-progress-fill-done" : "iterate-progress-fill",
        style: { width: `${progress}%` }
      })
    ),
    convChip,
    sevMetric("critical", "CRIT"),
    sevMetric("high", "HIGH"),
    sevMetric("medium", "MED"),
    sevMetric("low", "LOW"),
    fixBadge,
    resumeChip,
    imageChip,
    liveChip,
    taskModeChip,
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
  const trendLine = tf(`\u9996\u8F6E {a0} \u2192 \u672B\u8F6E {a1} \u9879\uFF0C\u964D\u5E45 {a2}%{a3}`, { a0: trend.firstRound, a1: trend.lastRound, a2: trend.reductionPercent, a3: trend.converged ? t("\uFF0C\u5DF2\u6536\u655B") : "" });
  const completion = buildCompletionSummary(report, getLang());
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "stats", className: "iterate-stats" },
    React.createElement(
      "div",
      { className: "iterate-triage-head" },
      React.createElement("span", {}, t("Iterate \xB7 \u6536\u655B\u7EDF\u8BA1")),
      React.createElement(
        "span",
        { className: "iterate-triage-hint" },
        `Round ${getCurrentRound(report)}/${getTotalRounds(report)} \xB7 ${total} findings \xB7 ${report.convergence && report.convergence.converged ? t("\u5DF2\u6536\u655B") : t("\u672A\u6536\u655B")}`
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
      }, showHistory ? t("\u6536\u8D77\u5386\u53F2") : t("\u5386\u53F2 / \u8D8B\u52BF"))
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
            React.createElement("th", {}, t("\u8F6E\u6B21")),
            React.createElement("th", {}, t("\u53D1\u73B0")),
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
    const saved = storage2 ? storage2.get(storageKey) : null;
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
  const [cmdCopied, setCmdCopied] = React.useState(null);
  const [cmdFailed, setCmdFailed] = React.useState(null);
  const cmdTimers = React.useRef([]);
  React.useEffect(() => () => {
    for (const t2 of cmdTimers.current) clearTimeout(t2);
    cmdTimers.current = [];
  }, []);
  const copyWithFeedback = (text, key) => {
    copyText(text).then((ok) => {
      if (ok) {
        setCmdFailed(null);
        setCmdCopied(key);
        cmdTimers.current.push(window.setTimeout(() => setCmdCopied((cur) => cur === key ? null : cur), 1600));
      } else {
        setCmdCopied(null);
        setCmdFailed(key);
        setPayload(text);
      }
    });
  };
  React.useEffect(() => {
    if (storage2) storage2.set(storageKey, JSON.stringify(verdicts));
  }, [storageKey, verdicts]);
  const setVerdict = (index, verdict) => {
    setVerdicts((prev) => ({ ...prev, [String(index)]: verdict }));
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
    setVerdicts((prev) => batchSetVerdict(prev, batchTarget, verdict));
  };
  const doResetVerdicts = () => {
    setVerdicts((prev) => setAllVerdicts(prev, "keep"));
    setSelectAll(false);
  };
  React.useEffect(() => {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return;
    const onKeyDown = (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t2 = ev.target;
      if (t2 && (t2.tagName === "INPUT" || t2.tagName === "TEXTAREA" || t2.tagName === "SELECT")) return;
      if (t2 && typeof t2.isContentEditable === "boolean" && t2.isContentEditable) return;
      const rootEl = doc.querySelector('[data-iterate="triage"]');
      if (!rootEl) return;
      const activeEl = doc.activeElement;
      if (!activeEl) return;
      if (activeEl !== rootEl && !(typeof rootEl.contains === "function" && rootEl.contains(activeEl))) return;
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
  const doApproveArchitecturalFix = () => {
    const cmd = buildArchitecturalFixInstruction(findings);
    if (!cmd) return;
    copyWithFeedback(cmd, "approve-arch");
  };
  const doTriggerNewRound = () => {
    const cmd = t("\u8BF7\u7EE7\u7EED\u6267\u884C\u4E0B\u4E00\u8F6E\u8FED\u4EE3\u5BA1\u67E5");
    copyWithFeedback(cmd, "new-round");
  };
  const doRollbackToCheckpoint = () => {
    const cmd = t("\u8BF7\u56DE\u6EDA\u4E0A\u4E00\u8F6E\u8FED\u4EE3\u7684\u4FEE\u590D\uFF1A\u8C03\u7528 `iterate_history` \u67E5\u770B\u672C\u8F6E fix id\uFF0C\u518D\u7528 `iterate_rollback` \u9010\u4E2A\u64A4\u9500\u8FD9\u4E9B\u4FEE\u590D");
    copyWithFeedback(cmd, "rollback");
  };
  const doAssignFindings = () => {
    const targetAll = selectAll;
    const scopeIndices = targetAll ? allIndices : indices;
    const scopeFindings = findings.filter((f, i) => scopeIndices.includes(i));
    if (scopeFindings.length === 0) return;
    const cmd = buildAssignFixesInstruction(scopeFindings);
    if (!cmd) return;
    copyWithFeedback(cmd, "assign");
  };
  const doCopyYaml = () => {
    const yaml = toKnownIntentionalYaml(ignored);
    if (!yaml) return;
    copyText(yaml).then((ok) => {
      if (ok) {
        setCopied(true);
        cmdTimers.current.push(window.setTimeout(() => setCopied(false), 1600));
      } else {
        setPayload(yaml);
        setCmdFailed("yaml");
      }
    });
  };
  const doBuildInstruction = () => {
    const text = buildApplyInstruction(ignored);
    if (!text) return;
    setPayload(text);
    copyWithFeedback(text, "apply");
  };
  const doReadback = () => {
    const text = buildTriageReadbackInstruction();
    setPayload(text);
    copyWithFeedback(text, "readback");
  };
  const rowPairs = [];
  for (let i = 0; i < filtered.length; i++) {
    const idx = indices[i];
    const f = filtered[i];
    if (typeof idx === "number" && f) rowPairs.push({ index: idx, finding: f });
  }
  const rows = rowPairs.map(({ index, finding }) => {
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
        role: "option",
        "aria-selected": isSelected,
        tabIndex: 0,
        onClick: () => setSelected(index),
        onFocus: () => setSelected(index),
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setSelected(index);
          }
        }
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
        btn(t("y \u4FEE\u590D"), "keep", t("\u4FDD\u7559\u8BE5 finding\uFF0C\u8FDB\u5165\u4FEE\u590D")),
        btn(t("n \u8DF3\u8FC7"), "skip", t("\u8DF3\u8FC7\u8BE5 finding")),
        btn(t("a \u5DF2\u77E5\u6709\u610F"), "ignore", t("\u6807\u8BB0\u4E3A\u5DF2\u77E5\u6709\u610F\u5E76\u5199\u5165 known_intentional"))
      )
    );
  });
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "triage", className: "iterate-triage" },
    React.createElement(
      "div",
      { className: "iterate-triage-head" },
      React.createElement("span", { role: "heading", "aria-level": 3 }, tf(`Iterate \xB7 Findings \u5206\u8BCA ({a0}/{a1})`, { a0: filtered.length, a1: findings.length })),
      React.createElement("span", { className: "iterate-triage-hint" }, t("y=\u4FEE\u590D \xB7 n=\u8DF3\u8FC7 \xB7 a=\u5DF2\u77E5\u6709\u610F \xB7 \u2191/\u2193 \u9009\u62E9"))
    ),
    React.createElement(
      "div",
      { className: "iterate-filter" },
      React.createElement(
        "select",
        { className: "iterate-filter-select", value: filter.severities[0] || "", onChange: (e) => setSeverityFilter(e.target.value), "aria-label": t("\u6309\u4E25\u91CD\u5EA6\u7B5B\u9009") },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u4E25\u91CD\u5EA6")),
        ...options.severities.map(
          (s) => React.createElement("option", { key: s.value, value: s.value }, `${severityLabel(s.value)} (${s.count})`)
        )
      ),
      React.createElement(
        "select",
        { className: "iterate-filter-select", value: filter.dimensions[0] || "", onChange: (e) => setDimensionFilter(e.target.value), "aria-label": t("\u6309\u7EF4\u5EA6\u7B5B\u9009") },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u7EF4\u5EA6")),
        ...options.dimensions.map(
          (d) => React.createElement("option", { key: d.value, value: d.value }, `${d.value} (${d.count})`)
        )
      ),
      React.createElement("input", {
        className: "iterate-filter-search",
        type: "search",
        placeholder: t("\u641C\u7D22\u6587\u4EF6 / \u6458\u8981\u2026"),
        "aria-label": t("\u641C\u7D22\u6587\u4EF6\u6216\u6458\u8981"),
        value: filter.search,
        onChange: (e) => setSearchFilter(e.target.value)
      }),
      React.createElement(
        "span",
        { className: "iterate-filter-count" },
        isFilterActive ? React.createElement("button", { className: "iterate-batch-btn", onClick: clearFilter }, tf(`\u6E05\u9664\u7B5B\u9009\uFF08\u663E\u793A {a0}\uFF09`, { a0: filtered.length })) : tf(`\u5171 {a0} \u9879`, { a0: findings.length })
      )
    ),
    React.createElement(
      "div",
      { className: "iterate-batch" },
      React.createElement("span", { className: "iterate-batch-label" }, t("\u6279\u91CF\u4F5C\u7528\u4E8E\uFF1A")),
      React.createElement("button", {
        className: selectAll ? "iterate-batch-btn iterate-batch-scope" : "iterate-batch-btn iterate-batch-scope iterate-batch-scope-on",
        onClick: () => setSelectAll(false),
        title: t("\u6279\u91CF\u6309\u94AE\u4EC5\u4F5C\u7528\u4E8E\u5F53\u524D\u7B5B\u9009\u53EF\u89C1\u7684 findings")
      }, tf(`\u53EF\u89C1 {a0}`, { a0: indices.length })),
      React.createElement("button", {
        className: selectAll ? "iterate-batch-btn iterate-batch-scope iterate-batch-scope-on" : "iterate-batch-btn iterate-batch-scope",
        onClick: () => setSelectAll(true),
        title: t("\u6279\u91CF\u6309\u94AE\u4F5C\u7528\u4E8E\u5168\u90E8 findings")
      }, tf(`\u5168\u90E8 {a0}`, { a0: allIndices.length })),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("keep") }, "y"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("skip") }, "n"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: () => applyBatch("ignore") }, "a"),
      React.createElement("button", { className: "iterate-batch-btn", onClick: doResetVerdicts, title: t("\u628A\u6240\u6709\u5224\u5B9A\u6062\u590D\u4E3A\u9ED8\u8BA4 y\uFF08\u4FEE\u590D\uFF09") }, t("\u91CD\u7F6E"))
    ),
    ...rows,
    React.createElement(
      "div",
      { className: "iterate-triage-foot" },
      React.createElement("span", {}, tf(`y {a0} \xB7 n {a1} \xB7 a {a2} \xB7 \u5F85\u5199\u56DE known_intentional\uFF1A{a3} \u6761`, { a0: counts.keep, a1: counts.skip, a2: counts.ignore, a3: ignoredCount })),
      React.createElement(
        "span",
        { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
        // Gap #7: the apply instruction (safe path) is PRIMARY; the raw YAML
        // is demoted to an explicit "just the snippet" escape hatch.
        React.createElement("button", {
          className: "iterate-btn",
          "data-primary": "",
          "data-copied": cmdCopied === "apply" ? "" : void 0,
          "data-failed": cmdFailed === "apply" ? "" : void 0,
          onClick: doBuildInstruction,
          disabled: ignoredCount === 0,
          title: ignoredCount === 0 ? t("\u5F53\u524D\u6CA1\u6709\u6807\u8BB0\u4E3A\u300C\u5DF2\u77E5\u6709\u610F\u300D\u7684 finding") : t("\u590D\u5236\u5E94\u7528\u6307\u4EE4\uFF1A\u7C98\u8D34\u540E\u6A21\u578B\u4F1A\u8C03\u7528 iterate_triage apply\uFF08\u6821\u9A8C\u3001\u53BB\u91CD\u3001\u5199\u5165\u524D\u5907\u4EFD\u3001\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\uFF09")
        }, cmdCopied === "apply" ? t("\u5DF2\u590D\u5236") : cmdFailed === "apply" ? t("\u590D\u5236\u5931\u8D25") : tf(`\u751F\u6210\u5E94\u7528\u6307\u4EE4{a0}`, { a0: ignoredCount > 0 ? `\uFF08${ignoredCount}\uFF09` : "" })),
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": copied ? "" : void 0,
          "data-failed": cmdFailed === "yaml" ? "" : void 0,
          onClick: doCopyYaml,
          disabled: ignoredCount === 0,
          title: ignoredCount === 0 ? t("\u5F53\u524D\u6CA1\u6709\u6807\u8BB0\u4E3A\u300C\u5DF2\u77E5\u6709\u610F\u300D\u7684 finding") : t("\u53EA\u590D\u5236 known_intentional YAML \u7247\u6BB5\uFF08\u9700\u81EA\u884C\u7C98\u5230 iterate.config.yaml \u7684 personalization.known_intentional \u4E0B\uFF09")
        }, copied ? t("\u5DF2\u590D\u5236") : cmdFailed === "yaml" ? t("\u590D\u5236\u5931\u8D25") : t("\u4EC5\u590D\u5236 YAML \u7247\u6BB5")),
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": cmdCopied === "readback" ? "" : void 0,
          "data-failed": cmdFailed === "readback" ? "" : void 0,
          onClick: doReadback,
          title: t("\u590D\u5236 iterate_triage list \u6307\u4EE4\uFF0C\u6838\u5BF9\u5DF2\u7ECF\u5199\u5165\u7684 known_intentional \u6761\u76EE\uFF08\u5199\u56DE\u95ED\u73AF\u786E\u8BA4\uFF09")
        }, cmdCopied === "readback" ? t("\u5DF2\u590D\u5236") : cmdFailed === "readback" ? t("\u590D\u5236\u5931\u8D25") : t("\u56DE\u8BFB\u5DF2\u5199\u5165\u6761\u76EE"))
      ),
      cmdCopied === "apply" ? React.createElement("span", { className: "iterate-triage-hint", role: "status" }, t("\u5DF2\u590D\u5236\u5E94\u7528\u6307\u4EE4\u2014\u2014\u7C98\u8D34\u56DE\u4F1A\u8BDD\uFF0C\u6A21\u578B\u5C06\u8C03\u7528 iterate_triage apply \u5E76\u56DE\u62A5\u5199\u5165\u6761\u6570\u3002")) : cmdCopied === "readback" ? React.createElement("span", { className: "iterate-triage-hint", role: "status" }, t("\u5DF2\u590D\u5236\u56DE\u8BFB\u6307\u4EE4\u2014\u2014\u7C98\u8D34\u56DE\u4F1A\u8BDD\u53EF\u5217\u51FA\u5F53\u524D\u5DF2\u5199\u5165\u7684 known_intentional\u3002")) : null
    ),
    // v3.0: Command buttons for native actions (§8)
    React.createElement(
      "div",
      { className: "iterate-triage-foot", style: { borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      React.createElement("span", { style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" } }, t("\u6307\u6325\u64CD\u4F5C")),
      React.createElement(
        "span",
        { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
        React.createElement("button", {
          className: "iterate-cmd",
          "data-primary": "",
          "data-copied": cmdCopied === "approve-arch" ? "" : void 0,
          "data-failed": cmdFailed === "approve-arch" ? "" : void 0,
          onClick: doApproveArchitecturalFix,
          title: t("\u6279\u51C6\u67B6\u6784\u4FEE\u590D\uFF08\u590D\u5236\u6307\u4EE4\u6587\u672C\uFF1Aiterate_fix force:true\uFF0C\u542B\u5168\u90E8\u5FC5\u586B\u53C2\u6570\uFF09")
        }, cmdCopied === "approve-arch" ? t("\u5DF2\u590D\u5236") : cmdFailed === "approve-arch" ? t("\u590D\u5236\u5931\u8D25") : t("\u6279\u51C6\u67B6\u6784\u4FEE\u590D")),
        React.createElement("button", {
          className: "iterate-cmd",
          "data-copied": cmdCopied === "new-round" ? "" : void 0,
          "data-failed": cmdFailed === "new-round" ? "" : void 0,
          onClick: doTriggerNewRound,
          title: t("\u89E6\u53D1\u65B0\u4E00\u8F6E\u8FED\u4EE3\u5BA1\u67E5")
        }, cmdCopied === "new-round" ? t("\u5DF2\u590D\u5236") : cmdFailed === "new-round" ? t("\u590D\u5236\u5931\u8D25") : t("\u89E6\u53D1\u65B0\u4E00\u8F6E")),
        React.createElement("button", {
          className: "iterate-cmd",
          "data-primary": "",
          "data-copied": cmdCopied === "assign" ? "" : void 0,
          "data-failed": cmdFailed === "assign" ? "" : void 0,
          onClick: doAssignFindings,
          disabled: (selectAll ? allIndices : indices).length === 0,
          title: selectAll ? tf(`\u6307\u6D3E\u5168\u90E8 {a0} \u4E2A findings \u4FEE\u590D\uFF08\u9010\u4E2A iterate_fix\uFF09`, { a0: allIndices.length }) : tf(`\u6307\u6D3E\u5F53\u524D\u53EF\u89C1 {a0} \u4E2A findings \u4FEE\u590D\uFF08\u9010\u4E2A iterate_fix\uFF09`, { a0: indices.length })
        }, cmdCopied === "assign" ? t("\u5DF2\u590D\u5236") : cmdFailed === "assign" ? t("\u590D\u5236\u5931\u8D25") : t("\u6307\u6D3E\u4FEE\u590D")),
        React.createElement("button", {
          className: "iterate-cmd",
          "data-danger": "",
          "data-copied": cmdCopied === "rollback" ? "" : void 0,
          "data-failed": cmdFailed === "rollback" ? "" : void 0,
          onClick: doRollbackToCheckpoint,
          title: t("\u56DE\u6EDA\u5230\u4E0A\u4E00\u4E2A\u68C0\u67E5\u70B9")
        }, cmdCopied === "rollback" ? t("\u5DF2\u590D\u5236") : cmdFailed === "rollback" ? t("\u590D\u5236\u5931\u8D25") : t("\u56DE\u6EDA\u68C0\u67E5\u70B9"))
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
      ok ? t("\u62A5\u544A\u5DF2\u6279\u51C6") : t("\u62A5\u544A\u9700\u4FEE\u8BA2")
    ),
    React.createElement(
      "span",
      { className: "iterate-verdict-detail" },
      item(verdict.totalFindings, t("\u9879\u53D1\u73B0")),
      item(verdict.totalRounds, t("\u8F6E")),
      item(verdict.checksRun, t("\u9879\u5BA1\u67E5")),
      ok ? phrase(t("\u62A5\u544A\u901A\u8FC7\u5168\u90E8\u4E00\u81F4\u6027\u68C0\u67E5")) : item(verdict.reportIssues, t("\u5904\u62A5\u544A\u7F3A\u9677")),
      phrase(verdict.converged ? t("\u5DF2\u6536\u655B") : t("\u672A\u6536\u655B"))
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
      setInfo({ text: converged ? tf(`Round {a0} \u5B8C\u6210 \xB7 \u5DF2\u6536\u655B`, { a0: round }) : tf(`Round {a0} \u5B8C\u6210`, { a0: round }), ok: converged });
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
  return React.createElement("div", {
    "data-iterate-root": "",
    className: "iterate-capsule",
    "data-ok": info.ok ? "" : void 0,
    role: "status",
    "aria-live": "polite"
  }, info.text);
}
function SettingsPanel(props) {
  const lang = useLang();
  const cachedSession = useSessionSnapshot();
  const session = props && props.session ? props.session : cachedSession;
  const [enabled, setEnabled] = React.useState(themeEnabled);
  const [guideCopied, setGuideCopied] = React.useState(false);
  const [statusCopied, setStatusCopied] = React.useState(false);
  const [showGuide, setShowGuide] = React.useState(false);
  const [showStatus, setShowStatus] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [clearedInfo, setClearedInfo] = React.useState(null);
  const [cfgField, setCfgField] = React.useState(
    () => CONFIG_EDIT_FIELDS.some((f) => f.key === "validation.commands") ? "validation.commands" : CONFIG_EDIT_FIELDS[0]?.key ?? "goal"
  );
  const [cfgCopied, setCfgCopied] = React.useState(false);
  const [cfgFailed, setCfgFailed] = React.useState(false);
  const [cfgText, setCfgText] = React.useState(null);
  const [cfgReadCopied, setCfgReadCopied] = React.useState(false);
  const [cfgReadText, setCfgReadText] = React.useState(null);
  const [pullCopied, setPullCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState(null);
  const guide = buildConfigEditGuide();
  const statusGuide = buildRuntimeStatusGuide();
  const cfgMeta = configFieldByKey(cfgField);
  const cfgRead = scanSessionForConfigRead(session);
  const cfgCurrent = cfgRead ? configValueByPath(cfgRead, cfgField) : null;
  const cfgFieldLabel = cfgMeta ? cfgMeta.label[getLang()] : cfgField;
  const cfgTimers = React.useRef([]);
  React.useEffect(() => () => {
    for (const t2 of cfgTimers.current) clearTimeout(t2);
    cfgTimers.current = [];
  }, []);
  const toggleTheme = () => {
    const next = !enabled;
    setEnabled(next);
    setThemeEnabled(next);
  };
  const flashCopied = (slot) => {
    const setter = slot === "guide" ? setGuideCopied : slot === "status" ? setStatusCopied : slot === "pull" ? setPullCopied : setCfgReadCopied;
    setter(true);
    cfgTimers.current.push(window.setTimeout(() => setter(false), 1600));
  };
  const doCopy = (text, slot) => {
    copyText(text).then((ok) => {
      setCopyError(ok ? null : slot);
      if (ok) flashCopied(slot);
    });
  };
  const doBuildConfigInstruction = () => {
    const text = buildConfigFieldInstruction(cfgField);
    setCfgText(text);
    copyText(text).then((ok) => {
      setCfgFailed(!ok);
      setCfgCopied(ok);
      cfgTimers.current.push(window.setTimeout(() => setCfgCopied(false), 1600));
      if (!ok) return;
    });
  };
  const doCopyConfigRead = () => {
    const text = buildConfigReadInstruction();
    copyText(text).then((ok) => {
      setCopyError(ok ? null : "cfgRead");
      if (ok) {
        flashCopied("cfgRead");
        return;
      }
      setCfgReadText(text);
    });
  };
  const requestClear = () => {
    if (confirming) {
      const count = removeStorageByPrefix(TRIAGE_STORAGE_PREFIX);
      setClearedInfo(count);
      setConfirming(false);
      cfgTimers.current.push(window.setTimeout(() => setClearedInfo(null), 3e3));
      return;
    }
    setConfirming(true);
    cfgTimers.current.push(window.setTimeout(() => setConfirming(false), 3e3));
  };
  const clearButton = clearedInfo !== null ? React.createElement("button", { className: "iterate-btn", "data-copied": "", disabled: true }, tf(`\u5DF2\u6E05\u9664 {a0} \u6761`, { a0: clearedInfo })) : React.createElement("button", {
    className: "iterate-btn",
    "data-danger": confirming ? void 0 : "",
    "data-confirm": confirming ? "" : void 0,
    onClick: requestClear,
    title: confirming ? t("\u518D\u6B21\u70B9\u51FB\u4EE5\u786E\u8BA4\u6E05\u9664\u5168\u90E8\u5224\u5B9A") : t("\u6E05\u9664\u6240\u6709\u5206\u8BCA\u5224\u5B9A\u8BB0\u5F55\uFF08\u9700\u8981\u4E8C\u6B21\u786E\u8BA4\uFF09")
  }, confirming ? t("\u786E\u8BA4\u6E05\u9664\uFF1F") : t("\u6E05\u9664\u5206\u8BCA"));
  const themeCard = React.createElement(
    "div",
    { key: "theme", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, t("\u8FED\u4EE3\u4E3B\u9898")),
        React.createElement("div", { className: "iterate-settings-desc" }, t("\u542F\u7528\u6696\u7425\u73C0\u914D\u8272\u7684 iterate \u4E13\u5C5E\u76AE\u80A4\uFF0C\u8986\u76D6 dsh \u9ED8\u8BA4\u4E3B\u9898\u4EE4\u724C\u3002"))
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("span", { className: "iterate-chip", "data-ok": enabled ? "" : void 0 }, enabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u5173\u95ED")),
        React.createElement("button", {
          role: "switch",
          "aria-checked": enabled,
          "aria-label": t("\u5F00\u5173 iterate \u4E3B\u9898"),
          className: "iterate-switch",
          "data-on": enabled ? "" : void 0,
          onClick: toggleTheme
        }, React.createElement("span", { className: "iterate-switch-knob" }))
      )
    )
  );
  const langCard = React.createElement(
    "div",
    { key: "lang", className: "iterate-scard" },
    React.createElement(
      "div",
      { className: "iterate-scard-head" },
      React.createElement(
        "div",
        {},
        React.createElement("div", { className: "iterate-settings-title" }, t("\u754C\u9762\u8BED\u8A00")),
        React.createElement(
          "div",
          { className: "iterate-settings-desc" },
          t("\u9762\u677F\u6587\u6848\u7684\u663E\u793A\u8BED\u8A00\uFF1B\u590D\u5236\u7ED9\u6A21\u578B\u7684\u6307\u4EE4\u4FDD\u6301\u4E2D\u6587\uFF0C\u4E0E SKILL.md \u7684\u5DE5\u4F5C\u6D41\u5951\u7EA6\u4E00\u81F4\u3002")
        )
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("span", { className: "iterate-chip", "data-ok": "" }, LANG_NAMES[lang]),
        React.createElement("button", {
          role: "switch",
          "aria-checked": lang === "en",
          "aria-label": t("\u5207\u6362\u754C\u9762\u8BED\u8A00"),
          className: "iterate-switch",
          "data-on": lang === "en" ? "" : void 0,
          onClick: () => setLang(lang === "en" ? "zh" : "en")
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
        React.createElement("div", { className: "iterate-settings-title" }, t("\u5206\u8BCA\u6301\u4E45\u5316")),
        React.createElement("div", { className: "iterate-settings-desc" }, t("y / n / a \u5224\u5B9A\u4FDD\u5B58\u5728\u672C\u5730\u6D4F\u89C8\u5668\uFF08localStorage\uFF09\uFF0C\u5237\u65B0\u4F1A\u8BDD\u540E\u4ECD\u4FDD\u7559\u3002"))
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("span", { className: "iterate-chip" }, t("\u672C\u5730\u4FDD\u5B58")),
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
        React.createElement("div", { className: "iterate-settings-title" }, t("\u914D\u7F6E\u7BA1\u7406")),
        React.createElement("div", { className: "iterate-settings-desc" }, t("\u76EE\u6807 / \u7EF4\u5EA6 / \u6700\u5927\u8F6E\u6570 / validation.commands \u5199\u5728\u9879\u76EE\u7684 iterate.config.yaml\uFF0C\u590D\u5236\u6307\u5F15\u53EF\u8BA9\u6A21\u578B\u6309\u9700\u8C03\u6574\u3002"))
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("button", { className: "iterate-btn", "data-primary": "", "data-copied": guideCopied ? "" : void 0, onClick: () => doCopy(guide, "guide") }, guideCopied ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u6307\u5F15")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => setShowGuide((v) => !v) }, showGuide ? t("\u6536\u8D77") : t("\u5C55\u5F00"))
      )
    ),
    // Gap #8: wire up the previously-dead `buildConfigFieldInstruction` — pick
    // a field, generate the `iterate_config` write payload for it, paste it to
    // the model. `validation.commands` is the default selection.
    React.createElement(
      "div",
      { className: "iterate-guide-bar", style: { marginTop: 8, flexWrap: "wrap" } },
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: cfgField,
          "aria-label": t("\u9009\u62E9\u8981\u4FEE\u6539\u7684\u914D\u7F6E\u5B57\u6BB5"),
          onChange: (e) => setCfgField(e.target.value)
        },
        ...CONFIG_EDIT_FIELDS.map(
          (f) => React.createElement("option", { key: f.key, value: f.key }, getLang() === "en" ? `${f.label.en} (${f.key})` : `${f.label.zh}\uFF08${f.key}\uFF09`)
        )
      ),
      React.createElement(
        "span",
        { className: "iterate-settings-desc" },
        cfgMeta?.hint[getLang()] ?? ""
      ),
      React.createElement("button", {
        className: "iterate-btn",
        "data-primary": "",
        "data-copied": cfgCopied ? "" : void 0,
        "data-failed": cfgFailed ? "" : void 0,
        onClick: doBuildConfigInstruction,
        title: t("\u751F\u6210\u5E76\u590D\u5236\u8BE5\u5B57\u6BB5\u7684 iterate_config \u5199\u5165\u6307\u4EE4\uFF08\u5199\u5165\u524D\u81EA\u52A8\u5907\u4EFD\u3001\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\uFF09")
      }, cfgCopied ? t("\u5DF2\u590D\u5236") : cfgFailed ? t("\u590D\u5236\u5931\u8D25") : t("\u751F\u6210\u5199\u5165\u6307\u4EE4")),
      cfgFailed ? React.createElement("span", { className: "iterate-settings-desc" }, t("\u526A\u8D34\u677F\u88AB\u62D2\u7EDD\u2014\u2014\u6307\u4EE4\u5DF2\u5C55\u793A\u5728\u4E0B\u65B9\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\u3002")) : null
    ),
    // Gap #1 (3.7.0): close the write -> read-back loop. Three honest states:
    // nothing echoed yet, the value the model read back, or a read-back that
    // never contained this field (defaults are in play — say so, don't blank).
    React.createElement(
      "div",
      { className: "iterate-guide-bar", style: { marginTop: 8, flexWrap: "wrap" } },
      React.createElement(
        "span",
        { className: "iterate-settings-desc" },
        !cfgRead ? t("\u5C1A\u672A\u56DE\u8BFB\u5F53\u524D\u914D\u7F6E\u2014\u2014\u70B9\u300C\u56DE\u8BFB\u5F53\u524D\u914D\u7F6E\u300D\u590D\u5236\u6307\u4EE4\u53D1\u7ED9\u6A21\u578B\uFF0C\u56DE\u663E\u540E\u5373\u53EF\u5728\u6B64\u770B\u5230\u5F53\u524D\u503C\u3002") : cfgCurrent && cfgCurrent.resolved ? tf("\u5F53\u524D\u503C {a0}\uFF1A{a1}", { a0: cfgFieldLabel, a1: formatConfigValue(cfgCurrent.value) }) : tf("\u56DE\u8BFB\u7ED3\u679C\u4E2D\u6CA1\u6709 {a0}\uFF08\u8BE5\u5B57\u6BB5\u53EF\u80FD\u5C1A\u672A\u5199\u5165\u914D\u7F6E\u6587\u4EF6\uFF09\u3002", { a0: cfgFieldLabel })
      ),
      React.createElement("button", {
        className: "iterate-btn",
        "data-primary": "",
        "data-copied": cfgReadCopied ? "" : void 0,
        onClick: doCopyConfigRead,
        title: t('\u590D\u5236\u56DE\u8BFB\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u8C03\u7528 iterate_config(operation:"read") \u5E76\u56DE\u663E\u7ED3\u679C')
      }, cfgReadCopied ? t("\u5DF2\u590D\u5236") : t("\u56DE\u8BFB\u5F53\u524D\u914D\u7F6E"))
    ),
    cfgReadText ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, t("\u56DE\u8BFB\u6307\u4EE4\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\uFF09")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(cfgReadText, "cfgRead") }, t("\u590D\u5236"))
      ),
      React.createElement("div", { className: "iterate-guide-body" }, cfgReadText)
    ) : null,
    cfgText ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, t("\u5199\u5165\u6307\u4EE4\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\uFF09")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(cfgText, "guide") }, t("\u590D\u5236"))
      ),
      React.createElement("div", { className: "iterate-guide-body" }, cfgText)
    ) : null,
    showGuide ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, t("iterate.config.yaml \u53EF\u7F16\u8F91\u5B57\u6BB5")),
        React.createElement("span", { className: "iterate-chip" }, t("\u4E2D\u6587\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u7684\u5951\u7EA6\u6587\u6848\uFF09")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(guide, "guide") }, t("\u590D\u5236"))
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
        React.createElement("div", { className: "iterate-settings-title" }, t("\u72B6\u6001\u6982\u89C8")),
        React.createElement("div", { className: "iterate-settings-desc" }, t("\u67E5\u770B\u8FD0\u884C\u65F6\u4EA7\u7269\u5E03\u5C40\u4E0E\u6E05\u7406\u6307\u5F15\u3002iterate_status / iterate_history / iterate_prune \u5DE5\u5177\u7528\u4E8E\u67E5\u770B\u548C\u7BA1\u7406\u3002"))
      ),
      React.createElement(
        "div",
        { className: "iterate-scard-actions" },
        React.createElement("button", { className: "iterate-btn", "data-primary": "", "data-copied": statusCopied ? "" : void 0, onClick: () => doCopy(statusGuide, "status") }, statusCopied ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u6307\u5F15")),
        // Gap #4: RUNTIME_ARTIFACTS stops being documentation-only — this
        // copies the instruction that makes the model echo those artifacts
        // into the session so the observatory panels can read them.
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": pullCopied ? "" : void 0,
          onClick: () => doCopy(buildDiskSnapshotInstruction(), "pull")
        }, pullCopied ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => setShowStatus((v) => !v) }, showStatus ? t("\u6536\u8D77") : t("\u5C55\u5F00"))
      )
    ),
    showStatus ? React.createElement(
      "div",
      { className: "iterate-guide" },
      React.createElement(
        "div",
        { className: "iterate-guide-bar" },
        React.createElement("span", {}, t("\u8FD0\u884C\u65F6\u5E03\u5C40\u4E0E\u6E05\u7406")),
        React.createElement("span", { className: "iterate-chip" }, t("\u4E2D\u6587\uFF08\u7C98\u8D34\u7ED9\u6A21\u578B\u7684\u5951\u7EA6\u6587\u6848\uFF09")),
        React.createElement("button", { className: "iterate-btn", "data-ghost": "", onClick: () => doCopy(statusGuide, "status") }, t("\u590D\u5236"))
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
        React.createElement("div", { className: "iterate-settings-desc" }, t("\u4E3A\u6BCF\u6B21\u4EE3\u7801\u8BC4\u5BA1\u751F\u6210 Review \u62A5\u544A\u4E0E\u4EA4\u4E92\u5F0F\u5206\u8BCA\u89C6\u56FE\uFF0C\u4E13\u6CE8 AI \u81EA\u6211\u5BA1\u67E5\u4E0E\u4FEE\u6B63\u3002"))
      ),
      React.createElement(
        "span",
        { className: "iterate-pill" },
        React.createElement("span", { className: "iterate-pill-dot" }),
        t("\u5C31\u7EEA")
      )
    )
  );
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "settings", className: "iterate-settings" },
    React.createElement("div", { className: "iterate-settings-title", style: { fontSize: 15, fontWeight: 700 } }, t("iterate \u8BBE\u7F6E")),
    banner,
    copyError ? React.createElement(
      "div",
      { key: "copy-err", className: "iterate-scard", role: "alert" },
      React.createElement(
        "div",
        { className: "iterate-settings-desc" },
        t("\u526A\u8D34\u677F\u5199\u5165\u88AB\u62D2\u7EDD\uFF0C\u590D\u5236\u672A\u751F\u6548\u2014\u2014\u8BF7\u5C55\u5F00\u5BF9\u5E94\u533A\u5757\u624B\u52A8\u9009\u4E2D\u6587\u672C\u590D\u5236\u3002")
      )
    ) : null,
    langCard,
    themeCard,
    dataCard,
    guideCard,
    statusCard
  );
}
var OBS_TABS = [
  { key: "live", label: { zh: "\u5B9E\u65F6\u6D3B\u52A8\u6D41", en: "Live activity" }, hotkey: "" },
  { key: "f1", label: { zh: "\u5BA1\u67E5\u7EBF\u7A0B", en: "Review threads" }, hotkey: "1" },
  { key: "f2", label: { zh: "\u6536\u655B\u8D8B\u52BF", en: "Convergence trend" }, hotkey: "2" },
  { key: "f3", label: { zh: "\u53D1\u73B0\u5B9A\u4F4D", en: "Finding locations" }, hotkey: "3" },
  { key: "f4", label: { zh: "\u4FEE\u590D\u4E0E\u56DE\u6EDA", en: "Fixes & rollback" }, hotkey: "4" },
  { key: "f5", label: { zh: "\u65AD\u70B9\u6062\u590D", en: "Checkpoint resume" }, hotkey: "5" },
  { key: "f6", label: { zh: "\u8FD0\u884C\u63A7\u5236\u53F0", en: "Run console" }, hotkey: "6" },
  { key: "f7", label: { zh: "\u51B3\u7B56\u65F6\u95F4\u7EBF", en: "Decision timeline" }, hotkey: "7" },
  // v3.0: Quality Command Center tabs
  { key: "f8", label: { zh: "\u8D28\u91CF\u95E8\u7981", en: "Quality gate" }, hotkey: "8" },
  { key: "f9", label: { zh: "\u7ECF\u9A8C\u94F6\u884C", en: "Experience bank" }, hotkey: "9" },
  { key: "f10", label: { zh: "\u9632\u5FA1\u4E8B\u4EF6", en: "Defense events" }, hotkey: "0" }
];
var OBS_HOTKEY_TABS = {
  1: "f1",
  2: "f2",
  3: "f3",
  4: "f4",
  5: "f5",
  6: "f6",
  7: "f7",
  8: "f8",
  9: "f9",
  0: "f10",
  "-": "live"
};
function obsTabLabel(t2) {
  const label = t2.label[getLang()];
  if (t2.key === "live") return label;
  return `${t2.key.toUpperCase()} ${label}`;
}
function obsHotkeyHint() {
  return getLang() === "en" ? `${String(OBS_TABS.length)} tabs \xB7 keys 1-9/0 switch Fn, - returns to the live feed` : tf(`{a0} \u9875 \xB7 \u6309 1-9/0 \u5207 Fn\u3001- \u56DE\u5B9E\u65F6\u6D41`, { a0: String(OBS_TABS.length) });
}
var OBS_LIVE_META = {
  read: { label: { zh: "\u9605\u8BFB", en: "Read" }, color: "var(--dsw-alias-brand-primary)" },
  fix: { label: { zh: "\u4FEE\u590D", en: "Fix" }, color: "var(--dsw-alias-state-success-primary)" },
  rollback: { label: { zh: "\u56DE\u6EDA", en: "Rollback" }, color: "var(--dsw-alias-state-error-primary)" },
  diff: { label: { zh: "\u5DEE\u5F02", en: "Diff" }, color: "var(--dsw-alias-state-warn-primary)" },
  review: { label: { zh: "\u5BA1\u67E5", en: "Review" }, color: "var(--dsw-alias-brand-primary)" },
  triage: { label: { zh: "\u5206\u6D41", en: "Triage" }, color: "var(--dsw-alias-state-warn-primary)" },
  checkpoint: { label: { zh: "\u65AD\u70B9", en: "Checkpoint" }, color: "var(--dsw-alias-brand-primary)" },
  validate: { label: { zh: "\u6821\u9A8C", en: "Validate" }, color: "var(--dsw-alias-state-success-primary)" },
  log: { label: { zh: "\u8BB0\u5F55", en: "Log" }, color: "var(--dsw-alias-label-secondary)" },
  prune: { label: { zh: "\u6E05\u7406", en: "Prune" }, color: "var(--dsw-alias-state-warn-primary)" },
  info: { label: { zh: "\u4FE1\u606F", en: "Info" }, color: "var(--dsw-alias-label-secondary)" }
};
var OBS_LIVE_FALLBACK_COLOR = "var(--dsw-alias-label-secondary)";
function formatObsLiveTime(ts) {
  if (!ts) return "";
  let date = null;
  const num = Number(ts);
  if (typeof ts === "string" && ts !== "" && !Number.isNaN(num) && /^\d+$/.test(ts)) {
    date = new Date(num);
  } else {
    const d = new Date(ts);
    date = Number.isNaN(d.getTime()) ? null : d;
  }
  if (!date) return String(ts);
  const p = (n) => String(n).padStart(2, "0");
  const h = p(date.getHours());
  const mi = p(date.getMinutes());
  const s = p(date.getSeconds());
  return `${p(date.getDate())}/${p(date.getMonth() + 1)} ${h}:${mi}:${s}`;
}
function latestTranscript(session) {
  if (!session) return null;
  const raw = scanSessionForTranscript(session);
  return raw ? normalizeTranscript(raw) : null;
}
function latestQualityGate(session) {
  if (!session) return null;
  return scanSessionForQualityGate(session);
}
function latestExperienceBank(session) {
  if (!session) return null;
  return scanSessionForExperienceBank(session);
}
function latestDefenseEvents(session) {
  if (!session) return null;
  return scanSessionForDefenseEvents(session);
}
function buildObsFixInstruction(f) {
  return buildFixInstruction(f);
}
function ObservatoryPanel(props) {
  const session = props && props.session ? props.session : null;
  React.useEffect(() => {
    noteSession(session);
  }, [session]);
  const manifest = latestTranscript(session);
  const qualityGate = latestQualityGate(session);
  const experienceBank = latestExperienceBank(session);
  const defenseEvents = latestDefenseEvents(session);
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState("live");
  const [expandedThreads, setExpandedThreads] = React.useState(/* @__PURE__ */ new Set());
  const [threadMode, setThreadMode] = React.useState("auto");
  const [copiedKey, setCopiedKey] = React.useState(null);
  const [copyFailText, setCopyFailText] = React.useState(null);
  const [nudgeText, setNudgeText] = React.useState("");
  const [timelineType, setTimelineType] = React.useState("");
  const [timelineRound, setTimelineRound] = React.useState("");
  const [timelineSearch, setTimelineSearch] = React.useState("");
  const [liveType, setLiveType] = React.useState("");
  const [f3Filter, setF3Filter] = React.useState(
    { severities: [], dimensions: [], search: "" }
  );
  const [expSearch, setExpSearch] = React.useState("");
  const [defenseFilter, setDefenseFilter] = React.useState("");
  const copyTimer = React.useRef(null);
  React.useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  React.useEffect(() => {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc || !open) return;
    const onKeyDown = (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
      const t2 = ev.target;
      if (t2 && (t2.tagName === "INPUT" || t2.tagName === "TEXTAREA" || t2.tagName === "SELECT")) return;
      if (t2 && typeof t2.isContentEditable === "boolean" && t2.isContentEditable) return;
      const rootEl = doc.querySelector('[data-iterate="obs"]');
      if (!rootEl) return;
      const activeEl = doc.activeElement;
      const inPanel = activeEl === rootEl || activeEl !== null && typeof rootEl.contains === "function" && rootEl.contains(activeEl);
      const idle = activeEl === null || activeEl === doc.body;
      if (!inPanel && !idle) return;
      const next = OBS_HOTKEY_TABS[ev.key];
      if (!next) return;
      ev.preventDefault();
      setTab(next);
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [open]);
  const copyInstruction = (key, text) => {
    if (!text) return;
    copyText(text).then((ok) => {
      if (!ok) {
        setCopyFailText(text);
        return;
      }
      setCopiedKey(key);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedKey((cur) => cur === key ? null : cur), 1600);
    });
  };
  const pullInstruction = buildDiskSnapshotInstruction();
  const pullTitle = tf(`\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u9010\u4E2A\u8C03\u7528 {a0} \u5E76\u56DE\u663E\u5B8C\u6574\u7ED3\u679C`, { a0: DISK_SNAPSHOT_SOURCES.map((s) => s.tool).join(" / ") });
  const toggleThread = (key) => {
    setThreadMode("auto");
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const exportObservatory = () => {
    if (!manifest) return;
    const json = serializeObservatoryExport(manifest, manifest.live || [], {
      qualityGate,
      experienceBank,
      defenseEvents,
      report: latestReport(session)
    });
    const filename = `iterate-observatory-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`;
    const flash = () => {
      setCopiedKey("export");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedKey((cur) => cur === "export" ? null : cur), 1600);
    };
    if (downloadTextFile(filename, json)) {
      flash();
      return;
    }
    copyText(json).then((ok) => {
      if (!ok) {
        setCopyFailText(json);
        return;
      }
      flash();
    });
  };
  const setAllThreads = (mode) => {
    setThreadMode(mode);
    setExpandedThreads(/* @__PURE__ */ new Set());
  };
  const isThreadExpanded = (key) => {
    if (threadMode === "all") return true;
    if (threadMode === "none") return false;
    return expandedThreads.has(key);
  };
  if (!manifest) {
    return React.createElement(
      "div",
      { "data-iterate-root": "", "data-iterate": "obs", className: "iterate-obs" },
      React.createElement(
        "div",
        { className: "iterate-obs-head", "data-closed": "" },
        React.createElement("span", { className: "iterate-obs-title" }, t("iterate \u89C2\u6D4B\u53F0")),
        React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`\u6682\u65E0\u8FD0\u884C\u65F6\u89C2\u6D4B\u6570\u636E \xB7 {a0}`, { a0: obsHotkeyHint() })),
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": copiedKey === "pull-snapshot" ? "" : void 0,
          onClick: (e) => {
            e.stopPropagation();
            copyInstruction("pull-snapshot", pullInstruction);
          },
          title: t("\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u78C1\u76D8\u4E0A\u53EF\u80FD\u5DF2\u6709\u5386\u53F2\u4EA7\u7269\uFF0C\u56DE\u663E\u8FDB\u4F1A\u8BDD\u540E\u89C2\u6D4B\u53F0\u5373\u53EF\u586B\u5145")
        }, copiedKey === "pull-snapshot" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167"))
      )
    );
  }
  const live = manifest.active === true;
  const roundMeta = typeof manifest.round === "number" ? typeof manifest.maxRounds === "number" ? `Round ${manifest.round}/${manifest.maxRounds}` : `Round ${manifest.round}` : "";
  const headMeta = [manifest.mode || "", roundMeta, manifest.updatedAt || ""].filter(Boolean).join(" \xB7 ");
  const threadFindingPill = (f, keyBase) => {
    const loc = `${String(f.file || "?")}${typeof f.line === "number" && f.line > 0 ? `:${f.line}` : ""}`;
    return React.createElement(
      "div",
      { key: keyBase, className: "iterate-obs-row" },
      React.createElement("span", { className: "iterate-sev-dot", style: { background: severityColor(f.severity) } }),
      React.createElement("span", {}, severityLabel(f.severity)),
      React.createElement("span", { className: "iterate-obs-file" }, loc),
      React.createElement("span", {}, String(f.dimension || "")),
      React.createElement("span", { className: "iterate-obs-msg" }, String(f.summary || ""))
    );
  };
  const renderThreads = () => {
    const rounds = manifest.rounds || [];
    if (rounds.length === 0) {
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u5BA1\u67E5\u7EBF\u7A0B"));
    }
    return React.createElement(
      "div",
      {},
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { marginBottom: 8, flexWrap: "wrap" } },
        React.createElement("b", {}, t("\u5BA1\u67E5\u7EBF\u7A0B")),
        React.createElement("button", { className: "iterate-btn", onClick: () => setAllThreads("all"), title: t("\u5C55\u5F00\u5168\u90E8\u7EBF\u7A0B") }, t("\u5168\u90E8\u5C55\u5F00")),
        React.createElement("button", { className: "iterate-btn", onClick: () => setAllThreads("none"), title: t("\u6536\u8D77\u5168\u90E8\u7EBF\u7A0B") }, t("\u5168\u90E8\u6536\u8D77")),
        React.createElement(
          "span",
          { className: "iterate-filter-count" },
          tf(`{a0} \xB7 {a1} \u8F6E`, { a0: threadMode === "all" ? t("\u5168\u90E8\u5C55\u5F00") : threadMode === "none" ? t("\u5168\u90E8\u6536\u8D77") : t("\u81EA\u7531\u5207\u6362"), a1: rounds.length })
        )
      ),
      ...rounds.map((r, ri) => {
        const threads = r.threads || [];
        const fCount = threads.reduce((sum, t2) => sum + (t2.findings ? t2.findings.length : 0), 0);
        const threadBlocks = threads.length === 0 ? [React.createElement("div", { key: "none", className: "iterate-obs-empty" }, t("\u672C\u8F6E\u65E0\u7EBF\u7A0B"))] : threads.map((th, ti) => {
          const key = `${ri}-${ti}`;
          const expanded = isThreadExpanded(key);
          const dim = th.dimension || t("\u672A\u547D\u540D\u7EF4\u5EA6");
          const tFindings = th.findings || [];
          const files = th.readFiles || [];
          const msgs = th.messages || [];
          return React.createElement(
            "div",
            { key, className: "iterate-obs-block" },
            React.createElement(
              "div",
              { className: "iterate-obs-block-head", "data-click": "", onClick: () => toggleThread(key), title: expanded ? t("\u6536\u8D77\u7EBF\u7A0B") : t("\u5C55\u5F00\u7EBF\u7A0B") },
              React.createElement("span", {}, expanded ? "\u2212" : "+"),
              React.createElement("b", {}, dim),
              React.createElement("span", { className: "iterate-obs-chip" }, `attempt ${typeof th.attempt === "number" ? th.attempt : "?"}`),
              React.createElement("span", { className: "iterate-obs-chip" }, `${tFindings.length} findings`)
            ),
            expanded ? React.createElement(
              "div",
              { className: "iterate-obs-block-body" },
              React.createElement(
                "div",
                { className: "iterate-obs-bar" },
                React.createElement("b", {}, t("\u53D9\u8FF0")),
                React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`{a0} \u6761`, { a0: msgs.length }))
              ),
              ...msgs.length === 0 ? [React.createElement("div", { key: "msg-none", className: "iterate-obs-empty" }, t("\u65E0\u7EBF\u7D22\u53D9\u8FF0"))] : msgs.map((m, mi) => React.createElement("div", { key: mi, className: "iterate-obs-msg" }, String(m))),
              ...files.length > 0 ? [
                React.createElement(
                  "div",
                  { key: "files-h", className: "iterate-obs-bar", style: { marginTop: 6 } },
                  React.createElement("b", {}, t("\u8BFB\u53D6\u6587\u4EF6"))
                ),
                ...files.map(
                  (f, fi) => React.createElement("div", { key: `f${fi}`, className: "iterate-obs-file" }, String(f))
                )
              ] : [],
              React.createElement(
                "div",
                { className: "iterate-obs-bar", style: { marginTop: 6 } },
                React.createElement("b", {}, t("\u53D1\u73B0"))
              ),
              ...tFindings.length === 0 ? [React.createElement("div", { key: "finding-none", className: "iterate-obs-empty" }, t("\u672C\u7EBF\u7A0B\u65E0\u53D1\u73B0"))] : tFindings.map((f, fi) => threadFindingPill(f, `tf${fi}`))
            ) : null
          );
        });
        return React.createElement(
          "div",
          { key: ri, className: "iterate-obs-block" },
          React.createElement(
            "div",
            { className: "iterate-obs-block-head" },
            React.createElement("b", {}, `Round ${typeof r.round === "number" ? r.round : ri + 1}`),
            React.createElement("span", { className: "iterate-obs-chip" }, tf(`{a0} \u7EBF\u7A0B`, { a0: threads.length })),
            React.createElement("span", { className: "iterate-obs-head-meta" }, `${fCount} findings`)
          ),
          React.createElement("div", { className: "iterate-obs-block-body" }, ...threadBlocks)
        );
      })
    );
  };
  const renderTrend = () => {
    const conv = manifest.convergence || [];
    if (conv.length === 0) {
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u6536\u655B\u6570\u636E"));
    }
    const points = conv.map((n, i) => ({ round: i + 1, count: n }));
    const report = latestReport(session);
    const comparison = buildRoundComparison(report, manifest.validations || []);
    const comparisonTable = comparison.length === 0 ? null : React.createElement(
      "table",
      { className: "iterate-obs-table" },
      React.createElement(
        "thead",
        {},
        React.createElement(
          "tr",
          {},
          React.createElement("th", {}, t("\u8F6E\u6B21")),
          React.createElement("th", {}, t("\u53D1\u73B0")),
          React.createElement("th", {}, t("\u5DF2\u4FEE\u590D")),
          React.createElement("th", {}, t("\u4E25\u91CD\u5EA6\u5206\u5E03")),
          React.createElement("th", {}, t("\u9A8C\u8BC1"))
        )
      ),
      React.createElement(
        "tbody",
        {},
        ...comparison.map((row) => {
          const sevText = Object.entries(row.severities).map(([k, v]) => `${k}:${v}`).join(" \xB7 ");
          const anyFailed = row.validations.some((v) => v.allowed !== true);
          const valText = row.validations.length === 0 ? "\u2014" : tf(`{a0}/{a1} \u901A\u8FC7{a2}`, { a0: row.validations.filter((v) => v.allowed === true).length, a1: row.validations.length, a2: anyFailed ? t("\uFF08\u542B\u5931\u8D25\uFF09") : "" });
          return React.createElement(
            "tr",
            { key: `cmp-${row.round}` },
            React.createElement("td", {}, `Round ${row.round}`),
            React.createElement("td", {}, String(row.findings)),
            React.createElement("td", {}, String(row.fixed)),
            React.createElement("td", {}, sevText || "\u2014"),
            React.createElement("td", {
              style: anyFailed ? { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 } : row.validations.length > 0 ? { color: "var(--dsw-alias-state-success-primary)" } : void 0
            }, valText)
          );
        })
      )
    );
    return React.createElement(
      "div",
      {},
      React.createElement(TrendChart, { points }),
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { marginTop: 6 } },
        tf(`\u5404\u8F6E\u53D1\u73B0\u6570\u91CF\uFF1A{a0}{a1}`, { a0: conv.join(" \u2192 "), a1: typeof manifest.round === "number" ? tf(` \xB7 \u5F53\u524D Round {a0}`, { a0: manifest.round }) : "" })
      ),
      comparisonTable ? React.createElement(
        "div",
        { className: "iterate-obs-block", style: { marginTop: 8 } },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("span", {}, t("\u8DE8\u8F6E\u5BF9\u6BD4\uFF08\u672C\u4F1A\u8BDD\uFF09")),
          React.createElement(
            "span",
            { className: "iterate-obs-head-meta" },
            t("\u8DE8\u4F1A\u8BDD\u5BF9\u6BD4\uFF1A\u672C\u8868\u53EA\u8986\u76D6\u5F53\u524D\u4F1A\u8BDD\uFF1B\u70B9\u300C\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u300D\u8BA9\u6A21\u578B\u56DE\u663E iterate_history\uFF0C\u518D\u7528\u300C\u5BFC\u51FA JSON\u300D\u5E76\u6392\u6BD4\u8F83\u4E24\u6B21\u8FD0\u884C")
          )
        ),
        React.createElement("div", { className: "iterate-obs-block-body" }, comparisonTable)
      ) : null
    );
  };
  const renderFindings = () => {
    const findings = manifest.findings || [];
    if (findings.length === 0) {
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u53D1\u73B0"));
    }
    const opts = buildFilterOptions(findings);
    const { filtered } = filterFindingsWithIndices(findings, f3Filter);
    const filterActive = f3Filter.severities.length > 0 || f3Filter.dimensions.length > 0 || f3Filter.search.trim() !== "";
    const toggleSeverity = (sev) => {
      setF3Filter((prev) => ({
        ...prev,
        severities: prev.severities.includes(sev) ? prev.severities.filter((s) => s !== sev) : [...prev.severities, sev]
      }));
    };
    const filterBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8, flexWrap: "wrap" } },
      React.createElement("b", {}, t("\u53D1\u73B0")),
      ...opts.severities.map(
        (s) => React.createElement("button", {
          key: `sev-${s.value}`,
          className: "iterate-filter-chip",
          "data-active": f3Filter.severities.includes(s.value) ? "" : void 0,
          title: tf(`{a0}\uFF08{a1} \u9879\uFF09`, { a0: s.value, a1: s.count }),
          onClick: () => toggleSeverity(s.value)
        }, `${s.value} ${s.count}`)
      ),
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: f3Filter.dimensions[0] || "",
          "aria-label": t("\u6309\u7EF4\u5EA6\u7B5B\u9009"),
          onChange: (e) => {
            const v = e.target.value;
            setF3Filter((prev) => ({ ...prev, dimensions: v ? [v] : [] }));
          }
        },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u7EF4\u5EA6")),
        ...opts.dimensions.map(
          (d) => React.createElement("option", { key: d.value, value: d.value }, `${d.value} (${d.count})`)
        )
      ),
      React.createElement("input", {
        className: "iterate-filter-search",
        type: "search",
        placeholder: t("\u641C\u7D22\u53D1\u73B0\u2026"),
        "aria-label": t("\u641C\u7D22\u53D1\u73B0"),
        value: f3Filter.search,
        onChange: (e) => setF3Filter((prev) => ({ ...prev, search: e.target.value }))
      }),
      filterActive ? React.createElement("button", {
        className: "iterate-filter-clear",
        onClick: () => setF3Filter({ severities: [], dimensions: [], search: "" }),
        title: t("\u6E05\u9664\u5168\u90E8\u7B5B\u9009")
      }, t("\u6E05\u9664\u7B5B\u9009")) : null,
      React.createElement("span", { className: "iterate-filter-count" }, `${filtered.length}/${findings.length}`)
    );
    const findingBlocks = filtered.map((f, i) => {
      const k = `f3-${i}`;
      const finding = f;
      const loc = `${String(finding.file || "?")}${typeof finding.line === "number" && finding.line > 0 ? `:${finding.line}` : ""}`;
      const entry = {
        file: String(finding.file || ""),
        ...typeof finding.line === "number" && finding.line > 0 ? { line: finding.line } : {},
        dimension: String(finding.dimension || ""),
        reason: String(finding.summary || "")
      };
      const knownInstruction = buildApplyInstruction([entry]);
      const fixInstruction = buildObsFixInstruction(finding);
      return React.createElement(
        "div",
        { key: k, className: "iterate-obs-block" },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("span", { className: "iterate-sev-dot", style: { background: severityColor(finding.severity) } }),
          React.createElement("span", {}, severityLabel(finding.severity)),
          React.createElement("span", { className: "iterate-obs-file" }, loc),
          React.createElement("span", {}, String(finding.dimension || "")),
          finding.acknowledged === true ? React.createElement("span", { className: "iterate-obs-chip" }, t("\u5DF2\u786E\u8BA4")) : null
        ),
        React.createElement(
          "div",
          { className: "iterate-obs-block-body" },
          React.createElement("div", { className: "iterate-obs-msg" }, String(finding.summary || "")),
          React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { marginTop: 8 } },
            React.createElement("button", {
              className: "iterate-btn",
              "data-copied": copiedKey === `${k}-fix` ? "" : void 0,
              onClick: () => copyInstruction(`${k}-fix`, String(finding.suggested_fix || "")),
              title: t("\u590D\u5236\u8BE5 finding \u7684\u5EFA\u8BAE\u4FEE\u590D\u6587\u672C")
            }, copiedKey === `${k}-fix` ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236 suggested_fix")),
            React.createElement("button", {
              className: "iterate-btn",
              "data-copied": copiedKey === `${k}-known` ? "" : void 0,
              onClick: () => copyInstruction(`${k}-known`, knownInstruction),
              title: t("\u590D\u5236 iterate_triage \u6307\u4EE4\u6587\u672C\uFF08\u6807\u8BB0\u4E3A known_intentional\uFF09")
            }, copiedKey === `${k}-known` ? t("\u5DF2\u590D\u5236") : "known_intentional"),
            React.createElement("button", {
              className: "iterate-btn",
              "data-primary": "",
              "data-copied": copiedKey === `${k}-repair` ? "" : void 0,
              onClick: () => copyInstruction(`${k}-repair`, fixInstruction),
              title: t("\u590D\u5236 iterate_fix \u6307\u4EE4\u6587\u672C")
            }, copiedKey === `${k}-repair` ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u4FEE\u590D\u6307\u4EE4"))
          )
        )
      );
    });
    if (filtered.length === 0) {
      return React.createElement(
        "div",
        {},
        filterBar,
        React.createElement("div", { className: "iterate-obs-empty" }, t("\u65E0\u5339\u914D\u7684\u53D1\u73B0"))
      );
    }
    return React.createElement("div", {}, filterBar, ...findingBlocks);
  };
  const renderFixes = () => {
    const fixes = manifest.fixes || [];
    if (fixes.length === 0) {
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u4FEE\u590D\u8BB0\u5F55"));
    }
    return React.createElement("div", {}, ...fixes.map((f, i) => {
      const k = `f4-${i}`;
      const id = String(f.id || `fix#${i + 1}`);
      const rollbackText = buildRollbackInstruction(id);
      const added = typeof f.linesAdded === "number" ? f.linesAdded : 0;
      const removed = typeof f.linesRemoved === "number" ? f.linesRemoved : 0;
      return React.createElement(
        "div",
        { key: k, className: "iterate-obs-block" },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("b", {}, id),
          React.createElement("span", { className: "iterate-obs-file" }, String(f.file || "?")),
          React.createElement("span", { className: "iterate-obs-chip" }, f.success === true ? t("\u6210\u529F") : t("\u5931\u8D25")),
          typeof f.round === "number" ? React.createElement("span", { className: "iterate-obs-head-meta" }, `Round ${f.round}`) : null
        ),
        React.createElement(
          "div",
          { className: "iterate-obs-block-body" },
          React.createElement("div", { className: "iterate-obs-msg" }, String(f.summary || "")),
          React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { marginTop: 8 } },
            React.createElement("span", { className: "iterate-obs-chip" }, `+${added}`),
            React.createElement("span", { className: "iterate-obs-chip" }, `\u2212${removed}`),
            React.createElement("button", {
              className: "iterate-btn",
              "data-danger": "",
              "data-copied": copiedKey === `${k}-rb` ? "" : void 0,
              onClick: () => copyInstruction(`${k}-rb`, rollbackText),
              title: t("\u590D\u5236 iterate_rollback \u6307\u4EE4\u6587\u672C")
            }, copiedKey === `${k}-rb` ? t("\u5DF2\u590D\u5236") : t("\u56DE\u6EDA"))
          )
        )
      );
    }));
  };
  const renderCheckpoint = () => {
    const cp = manifest.checkpoint;
    if (!cp) {
      return React.createElement(
        "div",
        { className: "iterate-obs-empty" },
        diskEmptyStateText(toolCalledInSession(session, "iterate_transcript"), t("\u65AD\u70B9"), getLang())
      );
    }
    const resumeText = buildCheckpointResumeInstruction();
    const clearText = buildCheckpointClearInstruction();
    const item = (label, value) => React.createElement("span", { className: "iterate-obs-chip" }, `${label} ${String(value ?? "?")}`);
    return React.createElement(
      "div",
      { className: "iterate-obs-block" },
      React.createElement(
        "div",
        { className: "iterate-obs-block-head" },
        React.createElement("b", {}, t("\u65AD\u70B9")),
        React.createElement("span", { className: "iterate-obs-head-meta" }, String(cp.updatedAt || ""))
      ),
      React.createElement(
        "div",
        { className: "iterate-obs-block-body" },
        React.createElement(
          "div",
          { className: "iterate-obs-bar", style: { marginBottom: 8 } },
          item("mode", cp.mode || "normal"),
          item("round", cp.round),
          item("maxRounds", cp.maxRounds),
          item("fixed", cp.fixedCount),
          item("resume", cp.resumeCount)
        ),
        React.createElement(
          "div",
          { className: "iterate-obs-bar", style: { marginBottom: 4 } },
          React.createElement("button", {
            className: "iterate-btn",
            "data-primary": "",
            "data-copied": copiedKey === "cp-resume" ? "" : void 0,
            onClick: () => copyInstruction("cp-resume", resumeText),
            title: t("\u590D\u5236 iterate_checkpoint resume \u6307\u4EE4\u6587\u672C\uFF08\u52A0\u8F7D\u65AD\u70B9\u5E76\u8BA1\u6570\u4E00\u6B21\u6062\u590D\uFF09")
          }, copiedKey === "cp-resume" ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u6062\u590D\u6307\u4EE4")),
          React.createElement("button", {
            className: "iterate-btn",
            "data-danger": "",
            "data-copied": copiedKey === "cp-clear" ? "" : void 0,
            onClick: () => copyInstruction("cp-clear", clearText),
            title: t("\u590D\u5236 iterate_checkpoint clear \u6307\u4EE4\u6587\u672C\uFF08\u6E05\u9664\u5F53\u524D\u65AD\u70B9\uFF0C\u4F9B\u91CD\u65B0\u5F00\u59CB\uFF09")
          }, copiedKey === "cp-clear" ? t("\u5DF2\u590D\u5236") : t("\u6E05\u9664\u65AD\u70B9"))
        )
      )
    );
  };
  const renderConsole = () => {
    const approval = manifest.approval || { policy: "ask" };
    const policyLabelMap = { ask: t("\u8BE2\u95EE\u7528\u6237"), deny: t("\u62D2\u7EDD"), allow: t("\u76F4\u63A5\u6267\u884C") };
    const policyLabel = policyLabelMap[String(approval.policy || "ask")] || String(approval.policy || "ask");
    const nudge = manifest.nudge || null;
    const present = Boolean(nudge && nudge.text);
    const activeNudgeText = nudge && nudge.text ? nudge.text : "";
    const nudgeInstruction = tf(`\u8BF7\u8C03\u7528 \`iterate_transcript\` \u5199\u5165 nudge \u6307\u4EE4\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "nudge", text: nudgeText }, null, 2) });
    const activeClearInstruction = tf(`\u8BF7\u8C03\u7528 \`iterate_transcript\` \u6E05\u9664\u5F53\u524D nudge\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "nudge", text: null }, null, 2) });
    const validations = Array.isArray(manifest.validations) ? manifest.validations : [];
    const abortedByValidation = String(manifest.stoppedReason || "") === "aborted_by_validation";
    const validationRows = validations.map((v, i) => {
      const allowed = v.allowed === true;
      const failed = !allowed;
      const highlight = failed && abortedByValidation;
      const exit = typeof v.exitCode === "number" ? `exit ${v.exitCode}` : "exit \u2014";
      return React.createElement(
        "div",
        {
          key: `val-${i}`,
          className: "iterate-obs-row",
          "data-status": allowed ? "pass" : "fail",
          "data-highlight": highlight ? "" : void 0,
          title: v.rejectReason ? String(v.rejectReason) : void 0
        },
        React.createElement("span", { className: "iterate-obs-head-meta" }, `Round ${typeof v.round === "number" ? v.round : "?"}`),
        React.createElement("code", { className: "iterate-obs-mono" }, String(v.command || "")),
        React.createElement(
          "span",
          { className: "iterate-obs-chip", "data-status": allowed ? "pass" : "fail" },
          allowed ? t("\u901A\u8FC7") : t("\u5931\u8D25")
        ),
        React.createElement("span", { className: "iterate-obs-head-meta" }, exit),
        highlight ? React.createElement("span", { className: "iterate-obs-chip", "data-status": "fail" }, t("\u5BFC\u81F4\u4E2D\u6B62")) : null
      );
    });
    const validationsBlock = React.createElement(
      "div",
      { className: "iterate-obs-block", style: { marginTop: 8 } },
      React.createElement(
        "div",
        { className: "iterate-obs-block-head" },
        React.createElement("span", {}, t("\u9A8C\u8BC1\u7ED3\u679C")),
        validations.length === 0 ? React.createElement("span", { className: "iterate-obs-head-meta" }, t("\u672C\u8F6E\u5C1A\u65E0\u9A8C\u8BC1\u8BB0\u5F55")) : React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`{a0} \u6761\u547D\u4EE4`, { a0: validations.length })),
        abortedByValidation ? React.createElement("span", { className: "iterate-obs-badge", "data-status": "fail" }, t("\u56E0\u9A8C\u8BC1\u5931\u8D25\u4E2D\u6B62")) : null
      ),
      React.createElement(
        "div",
        { className: "iterate-obs-block-body" },
        validations.length === 0 ? React.createElement(
          "div",
          { className: "iterate-obs-empty" },
          t("\u5C1A\u672A\u62C9\u53D6\u9A8C\u8BC1\u7ED3\u679C\uFF1A\u6570\u636E\u5728\u78C1\u76D8 transcript \u91CC\uFF0C\u70B9\u300C\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u300D\u590D\u5236\u6307\u4EE4\u53D1\u56DE\u4F1A\u8BDD\u5373\u53EF\u56DE\u586B\u3002")
        ) : React.createElement(React.Fragment, null, ...validationRows)
      )
    );
    return React.createElement(
      "div",
      { className: "iterate-obs-block" },
      React.createElement(
        "div",
        { className: "iterate-obs-block-head" },
        React.createElement("span", {}, t("\u8FD0\u884C\u63A7\u5236\u53F0")),
        React.createElement("span", { className: "iterate-obs-badge", "data-live": live ? "" : void 0 }, runStatusText(live, manifest)),
        React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`\u6279\u51C6\u7B56\u7565\uFF1A{a0}`, { a0: policyLabel }))
      ),
      React.createElement(
        "div",
        { className: "iterate-obs-block-body" },
        present ? React.createElement(
          "div",
          { className: "iterate-obs-bar", style: { marginBottom: 6 } },
          React.createElement("b", {}, t("\u5F53\u524D nudge")),
          React.createElement("span", { className: "iterate-obs-msg" }, activeNudgeText),
          React.createElement("button", {
            className: "iterate-btn",
            "data-copied": copiedKey === "nudge-clear" ? "" : void 0,
            onClick: () => copyInstruction("nudge-clear", activeClearInstruction),
            title: t("\u590D\u5236\u6E05\u9664 nudge \u6307\u4EE4\uFF08\u5199 text:null\uFF09\uFF0C\u5728\u8FD0\u884C\u63A7\u5236\u53F0\u63D0\u793A\u6E05\u9664\u5DF2\u6301\u4E45\u5316\u7684 nudge")
          }, copiedKey === "nudge-clear" ? t("\u5DF2\u590D\u5236\u6E05\u9664\u6307\u4EE4") : t("\u590D\u5236\u6E05\u9664\u6307\u4EE4"))
        ) : null,
        React.createElement("textarea", {
          className: "iterate-obs-input iterate-obs-mono",
          rows: 3,
          placeholder: t("\u8D77\u8349\u4E00\u6761 nudge \u65B9\u5411\u6307\u4EE4\u2026"),
          value: nudgeText,
          "aria-label": t("nudge \u8349\u7A3F"),
          onChange: (e) => setNudgeText(e.target.value)
        }),
        React.createElement(
          "div",
          { className: "iterate-obs-bar", style: { marginTop: 6 } },
          React.createElement("button", {
            className: "iterate-btn",
            "data-primary": "",
            "data-copied": copiedKey === "nudge" ? "" : void 0,
            disabled: !nudgeText,
            onClick: () => copyInstruction("nudge", nudgeInstruction),
            title: t("\u590D\u5236 iterate_transcript nudge \u6307\u4EE4\u6587\u672C")
          }, copiedKey === "nudge" ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236 nudge \u6307\u4EE4"))
        ),
        validationsBlock
      )
    );
  };
  const renderTimeline = () => {
    const entries = manifest.timeline || [];
    if (entries.length === 0) {
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u65F6\u95F4\u7EBF\u6761\u76EE"));
    }
    const types = Array.from(new Set(entries.map((t2) => String(t2.type || "unknown")).filter(Boolean))).sort();
    const rounds = Array.from(
      new Set(entries.map((t2) => typeof t2.round === "number" ? String(t2.round) : "").filter(Boolean))
    ).sort((a, b) => Number(a) - Number(b));
    const filtered = filterTimelineEntries(entries, {
      type: timelineType,
      round: timelineRound,
      search: timelineSearch
    });
    const filterActive = Boolean(timelineType || timelineRound || timelineSearch.trim());
    const clearTimelineFilter = () => {
      setTimelineType("");
      setTimelineRound("");
      setTimelineSearch("");
    };
    const sorted = filtered.slice();
    const rows = sorted.map((t2, i) => {
      const k = `f7-${i}`;
      let dataText = "";
      if (t2.data && typeof t2.data === "object") {
        try {
          dataText = JSON.stringify(t2.data);
        } catch {
          dataText = String(t2.data);
        }
      }
      return React.createElement(
        "div",
        { key: k, className: "iterate-obs-row", style: { flexDirection: "column", alignItems: "flex-start" } },
        React.createElement(
          "div",
          { className: "iterate-obs-bar", style: { width: "100%" } },
          React.createElement("span", { className: "iterate-obs-chip" }, String(t2.type || "?")),
          React.createElement(
            "span",
            { className: "iterate-obs-head-meta" },
            `${typeof t2.round === "number" ? `Round ${t2.round} \xB7 ` : ""}${String(t2.timestamp || "")}`
          )
        ),
        dataText ? React.createElement("div", { className: "iterate-obs-code" }, dataText) : null
      );
    });
    const filterBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8 } },
      React.createElement("b", {}, t("\u65F6\u95F4\u7EBF")),
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: timelineType,
          "aria-label": t("\u6309\u65F6\u95F4\u7EBF\u7C7B\u578B\u7B5B\u9009"),
          onChange: (e) => setTimelineType(e.target.value)
        },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u7C7B\u578B")),
        ...types.map((t2) => React.createElement("option", { key: t2, value: t2 }, t2))
      ),
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: timelineRound,
          "aria-label": t("\u6309\u8F6E\u6B21\u7B5B\u9009"),
          onChange: (e) => setTimelineRound(e.target.value)
        },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u8F6E\u6B21")),
        ...rounds.map((r) => React.createElement("option", { key: r, value: r }, `Round ${r}`))
      ),
      React.createElement("input", {
        className: "iterate-filter-search",
        type: "search",
        placeholder: t("\u641C\u7D22\u65F6\u95F4\u7EBF\u2026"),
        "aria-label": t("\u641C\u7D22\u65F6\u95F4\u7EBF"),
        value: timelineSearch,
        onChange: (e) => setTimelineSearch(e.target.value)
      }),
      filterActive ? React.createElement("button", {
        className: "iterate-filter-clear",
        onClick: clearTimelineFilter,
        title: t("\u6E05\u9664\u5168\u90E8\u7B5B\u9009")
      }, t("\u6E05\u9664")) : null,
      React.createElement("span", { className: "iterate-filter-count" }, `${filtered.length}/${entries.length}`)
    );
    if (rows.length === 0) {
      return React.createElement(
        "div",
        {},
        filterBar,
        React.createElement("div", { className: "iterate-obs-empty" }, t("\u65E0\u5339\u914D\u7684\u65F6\u95F4\u7EBF\u6761\u76EE"))
      );
    }
    return React.createElement("div", {}, filterBar, ...rows);
  };
  const renderQualityGate = () => {
    const gateInstruction = buildQualityGateQueryInstruction();
    const gateClearInstruction = buildQualityGateClearInstruction();
    const gate = qualityGate;
    const dims = gate && gate.dimensions ? gate.dimensions : [];
    const hasGate = gate !== null && Boolean(gate.overallStatus || gate.overallScore != null || dims.length > 0);
    const status = gate && gate.overallStatus ? String(gate.overallStatus) : "pending";
    const statusLabel = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "PENDING";
    const num = (v) => Number(v != null ? v : 0);
    const pulled = toolCalledInSession(session, "iterate_quality_gate");
    const headerBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8 } },
      React.createElement("b", {}, t("\u8D28\u91CF\u95E8\u7981")),
      React.createElement("button", {
        className: "iterate-btn",
        "data-primary": "",
        "data-copied": copiedKey === "qgate" ? "" : void 0,
        onClick: () => copyInstruction("qgate", gateInstruction),
        title: t("\u590D\u5236 iterate_quality_gate \u67E5\u8BE2\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09")
      }, copiedKey === "qgate" ? t("\u5DF2\u590D\u5236") : t("\u67E5\u8BE2\u95E8\u7981")),
      React.createElement("button", {
        className: "iterate-btn",
        "data-danger": "",
        "data-copied": copiedKey === "qgate-clear" ? "" : void 0,
        onClick: () => copyInstruction("qgate-clear", gateClearInstruction),
        title: t("\u590D\u5236 iterate_quality_gate clear \u6307\u4EE4\u6587\u672C\uFF08\u91CD\u7F6E\u9648\u65E7\u7684 FAIL \u8BC1\u4E66\uFF09")
      }, copiedKey === "qgate-clear" ? t("\u5DF2\u590D\u5236") : t("\u6E05\u9664\u95E8\u7981")),
      // Gap #4: the browser cannot read `.iterate/` directly — one click
      // copies the pull instruction that makes the model echo it into the stream.
      React.createElement("button", {
        className: "iterate-btn",
        "data-copied": copiedKey === "disk-snapshot" ? "" : void 0,
        onClick: () => copyInstruction("disk-snapshot", pullInstruction),
        title: t("\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u8BA9\u6A21\u578B\u56DE\u663E .iterate/ \u4E0B\u7684\u95E8\u7981\u3001\u7ECF\u9A8C\u3001\u9632\u5FA1\u4E8B\u4EF6\u4E0E transcript")
      }, copiedKey === "disk-snapshot" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167"))
    );
    if (!hasGate) {
      return React.createElement(
        "div",
        {},
        headerBar,
        React.createElement(
          "div",
          { className: "iterate-obs-block" },
          React.createElement(
            "div",
            { className: "iterate-obs-block-head" },
            React.createElement("span", {}, t("\u8D28\u91CF\u95E8\u7981\u89C6\u56FE")),
            React.createElement("span", { className: "iterate-obs-badge" }, "v3.0")
          ),
          React.createElement(
            "div",
            { className: "iterate-obs-block-body" },
            React.createElement(
              "div",
              { className: "iterate-obs-msg" },
              // Gap #4: distinguish "we pulled it and it is empty" from "we
              // never asked the model to read the disk".
              diskEmptyStateText(pulled, t("\u8D28\u91CF\u95E8\u7981\u8BC1\u4E66"), getLang())
            ),
            React.createElement(
              "div",
              { className: "iterate-obs-msg", style: { marginTop: 6 } },
              t("\u8D28\u91CF\u95E8\u7981\u663E\u793A\u5404\u7EF4\u5EA6\u6536\u655B\u5EA6\u3001\u9A8C\u8BC1\u901A\u8FC7\u7387\u548C\u6574\u4F53 PASS/FAIL \u72B6\u6001\u3002")
            ),
            React.createElement(
              "div",
              { className: "iterate-obs-bar", style: { marginTop: 8 } },
              React.createElement("button", {
                className: "iterate-btn",
                "data-copied": copiedKey === "qgate-instr" ? "" : void 0,
                onClick: () => copyInstruction("qgate-instr", gateInstruction),
                title: t("\u590D\u5236\u67E5\u8BE2\u6307\u4EE4")
              }, copiedKey === "qgate-instr" ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u67E5\u8BE2\u6307\u4EE4")),
              React.createElement("button", {
                className: "iterate-btn",
                "data-copied": copiedKey === "disk-snapshot-2" ? "" : void 0,
                onClick: () => copyInstruction("disk-snapshot-2", pullInstruction),
                title: t("\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4")
              }, copiedKey === "disk-snapshot-2" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167"))
            )
          )
        )
      );
    }
    return React.createElement(
      "div",
      {},
      headerBar,
      React.createElement(
        "div",
        { className: "iterate-obs-block" },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("span", { className: "iterate-gate", "data-status": status }, statusLabel),
          React.createElement(
            "span",
            { className: "iterate-obs-head-meta" },
            tf(`\u6574\u4F53\u8BC4\u5206 {a0} \xB7 \u9A8C\u8BC1 {a1}/{a2} \xB7 \u901A\u8FC7\u7387 {a3}%`, { a0: num(gate && gate.overallScore), a1: num(gate && gate.passedChecks), a2: num(gate && gate.totalChecks), a3: num(gate && gate.verificationPassRate) })
          )
        ),
        React.createElement(
          "div",
          { className: "iterate-obs-block-body" },
          dims.length > 0 ? React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { flexWrap: "wrap", gap: 6 } },
            ...dims.map(
              (d, i) => React.createElement(
                "span",
                { key: `gdim-${i}`, className: "iterate-obs-chip" },
                tf(`{a0} \xB7 \u6536\u655B {a1}% \xB7 \u8BC4\u5206 {a2}`, { a0: String(d.dimension || "?"), a1: num(d.convergenceRate), a2: num(d.score) })
              )
            )
          ) : null,
          React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { flexWrap: "wrap" } },
            ...dims.map((d, i) => {
              const fill = Math.min(100, Math.max(0, num(d.score)));
              return React.createElement(
                "div",
                { key: `gbar-${i}`, className: "iterate-dim-score" },
                React.createElement("span", {}, String(d.dimension || "?")),
                React.createElement(
                  "div",
                  { className: "iterate-dim-score-bar" },
                  React.createElement("div", {
                    className: "iterate-dim-score-fill",
                    "data-status": String(d.status || "warn"),
                    style: { width: `${fill}%` }
                  })
                ),
                React.createElement("span", {}, tf(`\u8BC4\u5206 {a0} \xB7 \u53D1\u73B0 {a1} \xB7 \u5DF2\u4FEE\u590D {a2}`, { a0: num(d.score), a1: num(d.findingsCount), a2: num(d.fixedCount) }))
              );
            })
          ),
          gate && gate.failReason ? React.createElement("div", { className: "iterate-obs-msg", style: { marginTop: 6 } }, tf(`\u5931\u8D25\u539F\u56E0\uFF1A{a0}`, { a0: String(gate.failReason) })) : null
        )
      )
    );
  };
  const renderExperienceBank = () => {
    const expInstruction = expSearch ? tf(`\u8BF7\u8C03\u7528 \`iterate_experience\` \u641C\u7D22\u7ECF\u9A8C\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "search", query: expSearch }, null, 2) }) : buildExperienceListInstruction();
    const expEntries = experienceBank && experienceBank.entries ? experienceBank.entries : [];
    const query = expSearch.trim().toLowerCase();
    const visible = query ? expEntries.filter(
      (e) => [e.pattern, e.description, e.id, e.dimension, e.severity, ...e.tags || []].filter(Boolean).some((t2) => String(t2).toLowerCase().includes(query))
    ) : expEntries;
    const pulled = toolCalledInSession(session, "iterate_experience");
    const resultRows = visible.map((e, i) => {
      const adoptInstruction = tf(`\u8BF7\u8C03\u7528 \`iterate_experience\` \u91C7\u7EB3\u7ECF\u9A8C\u5E76\u5E94\u7528\u5DF2\u9A8C\u8BC1\u4FEE\u6CD5\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "get", id: e.id }, null, 2) });
      return React.createElement(
        "div",
        { key: `exp-${i}`, className: "iterate-obs-block" },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("span", { className: "iterate-obs-chip" }, String(e.dimension || "")),
          React.createElement("span", {}, String(e.pattern || "?")),
          React.createElement("span", { className: "iterate-exp-hit" }, tf(`\u547D\u4E2D {a0} \u6B21`, { a0: e.hitCount ?? 0 }))
        ),
        React.createElement(
          "div",
          { className: "iterate-obs-block-body" },
          React.createElement("div", { className: "iterate-obs-msg" }, String(e.description || "")),
          React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { marginTop: 6 } },
            e.verifiedFix ? React.createElement("button", {
              className: "iterate-btn",
              "data-primary": "",
              "data-copied": copiedKey === `exp-adopt-${i}` ? "" : void 0,
              onClick: () => copyInstruction(`exp-adopt-${i}`, adoptInstruction),
              title: t("\u590D\u5236\u91C7\u7EB3\u6307\u4EE4\uFF08\u67E5\u8BE2\u8BE5\u7ECF\u9A8C\u5E76\u5E94\u7528\u5230\u5F53\u524D\u4E0A\u4E0B\u6587\uFF09")
            }, copiedKey === `exp-adopt-${i}` ? t("\u5DF2\u590D\u5236") : t("\u91C7\u7EB3")) : null
          )
        )
      );
    });
    return React.createElement(
      "div",
      {},
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { marginBottom: 8 } },
        React.createElement("b", {}, t("\u7ECF\u9A8C\u94F6\u884C")),
        React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`\u4F1A\u8BDD\u5185 {a0} \u6761`, { a0: expEntries.length })),
        React.createElement("button", {
          className: "iterate-btn",
          "data-primary": "",
          "data-copied": copiedKey === "exp-list" ? "" : void 0,
          onClick: () => copyInstruction("exp-list", buildExperienceListInstruction()),
          title: t("\u590D\u5236\u5217\u51FA\u7ECF\u9A8C\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09")
        }, copiedKey === "exp-list" ? t("\u5DF2\u590D\u5236") : t("\u5217\u51FA\u7ECF\u9A8C")),
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": copiedKey === "exp-snapshot" ? "" : void 0,
          onClick: () => copyInstruction("exp-snapshot", pullInstruction),
          title: t("\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u628A .iterate/ \u4E0B\u7684\u7ECF\u9A8C\u94F6\u884C\u7B49\u4EA7\u7269\u56DE\u663E\u8FDB\u4F1A\u8BDD")
        }, copiedKey === "exp-snapshot" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167"))
      ),
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { marginBottom: 8 } },
        React.createElement("input", {
          className: "iterate-filter-search",
          type: "search",
          placeholder: t("\u641C\u7D22\u7ECF\u9A8C\u6A21\u5F0F\u2026"),
          "aria-label": t("\u641C\u7D22\u7ECF\u9A8C"),
          value: expSearch,
          onChange: (e) => setExpSearch(e.target.value)
        }),
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": copiedKey === "exp-search" ? "" : void 0,
          disabled: !expSearch,
          onClick: () => copyInstruction("exp-search", expInstruction),
          title: t("\u590D\u5236\u641C\u7D22\u6307\u4EE4")
        }, copiedKey === "exp-search" ? t("\u5DF2\u590D\u5236") : t("\u641C\u7D22"))
      ),
      resultRows.length > 0 ? React.createElement("div", {}, ...resultRows) : expEntries.length > 0 ? React.createElement("div", { className: "iterate-obs-empty" }, t("\u6CA1\u6709\u5339\u914D\u300C") + expSearch + t("\u300D\u7684\u7ECF\u9A8C")) : React.createElement(
        "div",
        {},
        // Gap #4: separate "pulled and empty" from "never pulled".
        React.createElement("div", { className: "iterate-obs-empty" }, diskEmptyStateText(pulled, t("\u7ECF\u9A8C\u94F6\u884C"), getLang())),
        React.createElement("div", { className: "iterate-obs-empty" }, t("\u4E5F\u53EF\u70B9\u300C\u5217\u51FA\u7ECF\u9A8C\u300D\u67E5\u8BE2\u78C1\u76D8\u4E0A\u7684\u5168\u90E8\u5386\u53F2\u7ECF\u9A8C\u3002"))
      )
    );
  };
  const renderDefenseEvents = () => {
    const defenseInstruction = defenseFilter ? tf(`\u8BF7\u8C03\u7528 \`iterate_defense_events\` \u67E5\u8BE2\u9632\u5FA1\u4E8B\u4EF6\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "list", type: defenseFilter || void 0 }, null, 2) }) : buildDefenseEventsListInstruction();
    const typeOptions = [
      { value: "", label: t("\u5168\u90E8\u7C7B\u578B") },
      { value: "precondition_failed", label: t("\u524D\u7F6E\u6821\u9A8C\u5931\u8D25") },
      { value: "rollback", label: t("\u56DE\u6EDA") },
      { value: "invariant_violated", label: t("\u4E0D\u53D8\u91CF\u8FDD\u53CD") },
      { value: "assumption_falsified", label: t("\u5047\u8BBE\u88AB\u8BC1\u4F2A") }
    ];
    const TYPE_LABEL = {
      precondition_failed: t("\u524D\u7F6E\u6821\u9A8C\u5931\u8D25"),
      rollback: t("\u56DE\u6EDA"),
      invariant_violated: t("\u4E0D\u53D8\u91CF\u8FDD\u53CD"),
      assumption_falsified: t("\u5047\u8BBE\u88AB\u8BC1\u4F2A")
    };
    const counts = defenseEvents && defenseEvents.counts || {};
    const allEvents = defenseEvents && defenseEvents.events ? defenseEvents.events : [];
    const totalCount = typeOptions.slice(1).reduce((acc, o) => acc + (counts[o.value] || 0), 0);
    const visibleEvents = defenseFilter ? allEvents.filter((e) => e.type === defenseFilter) : allEvents;
    const headerBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8 } },
      React.createElement("b", {}, t("\u9632\u5FA1\u4E8B\u4EF6")),
      React.createElement("span", { className: "iterate-obs-head-meta" }, tf(`\u4F1A\u8BDD\u5185 {a0} \u6761 / \u7D2F\u8BA1 {a1}`, { a0: allEvents.length, a1: totalCount })),
      React.createElement("button", {
        className: "iterate-btn",
        "data-primary": "",
        "data-copied": copiedKey === "defense-list" ? "" : void 0,
        onClick: () => copyInstruction("defense-list", buildDefenseEventsListInstruction()),
        title: t("\u590D\u5236\u5217\u51FA\u9632\u5FA1\u4E8B\u4EF6\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09")
      }, copiedKey === "defense-list" ? t("\u5DF2\u590D\u5236") : t("\u5217\u51FA\u4E8B\u4EF6")),
      React.createElement("button", {
        className: "iterate-btn",
        "data-copied": copiedKey === "defense-snapshot" ? "" : void 0,
        onClick: () => copyInstruction("defense-snapshot", pullInstruction),
        title: t("\u590D\u5236\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167\u6307\u4EE4\uFF1A\u628A .iterate/ \u4E0B\u7684\u9632\u5FA1\u4E8B\u4EF6\u6D41\u56DE\u663E\u8FDB\u4F1A\u8BDD")
      }, copiedKey === "defense-snapshot" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167")),
      React.createElement("button", {
        className: "iterate-btn",
        "data-copied": copiedKey === "defense-counts" ? "" : void 0,
        onClick: () => copyInstruction("defense-counts", tf(`\u8BF7\u8C03\u7528 \`iterate_defense_events\` \u67E5\u8BE2\u4E8B\u4EF6\u7EDF\u8BA1\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "counts" }, null, 2) })),
        title: t("\u590D\u5236\u7EDF\u8BA1\u6307\u4EE4\uFF08\u542B JSON \u53C2\u6570\uFF09")
      }, copiedKey === "defense-counts" ? t("\u5DF2\u590D\u5236") : t("\u7EDF\u8BA1")),
      React.createElement("button", {
        className: "iterate-btn",
        "data-danger": "",
        "data-copied": copiedKey === "defense-clear" ? "" : void 0,
        onClick: () => copyInstruction("defense-clear", tf(`\u8BF7\u8C03\u7528 \`iterate_defense_events\` \u6E05\u9664\u9632\u5FA1\u4E8B\u4EF6\u6D41\uFF1A

\`\`\`json
{a0}
\`\`\``, { a0: JSON.stringify({ operation: "clear" }, null, 2) })),
        title: t("\u590D\u5236 iterate_defense_events clear \u6307\u4EE4\u6587\u672C\uFF08\u91CD\u7F6E\u9648\u65E7\u4E8B\u4EF6\u6D41\uFF09")
      }, copiedKey === "defense-clear" ? t("\u5DF2\u590D\u5236") : t("\u6E05\u9664\u4E8B\u4EF6"))
    );
    if (allEvents.length === 0 && totalCount === 0) {
      return React.createElement(
        "div",
        {},
        headerBar,
        React.createElement(
          "div",
          { className: "iterate-obs-block" },
          React.createElement(
            "div",
            { className: "iterate-obs-block-head" },
            React.createElement("span", {}, t("\u9632\u5FA1\u4E8B\u4EF6\u6D41")),
            React.createElement("span", { className: "iterate-obs-badge" }, "v3.0")
          ),
          React.createElement(
            "div",
            { className: "iterate-obs-block-body" },
            React.createElement(
              "div",
              { className: "iterate-obs-msg" },
              diskEmptyStateText(toolCalledInSession(session, "iterate_defense_events"), t("\u9632\u5FA1\u4E8B\u4EF6\u6D41"), getLang())
            ),
            React.createElement(
              "div",
              { className: "iterate-obs-msg", style: { marginTop: 6 } },
              t("\u9632\u5FA1\u4E8B\u4EF6\u5305\u62EC\uFF1A\u524D\u7F6E\u6821\u9A8C\u5931\u8D25\u3001\u56DE\u6EDA\u3001\u4E0D\u53D8\u91CF\u8FDD\u53CD\u3001\u5047\u8BBE\u88AB\u8BC1\u4F2A\u3002")
            ),
            React.createElement(
              "div",
              { className: "iterate-obs-bar", style: { marginTop: 8 } },
              React.createElement("button", {
                className: "iterate-btn",
                "data-copied": copiedKey === "defense-instr" ? "" : void 0,
                onClick: () => copyInstruction("defense-instr", defenseInstruction),
                title: t("\u590D\u5236\u67E5\u8BE2\u6307\u4EE4")
              }, copiedKey === "defense-instr" ? t("\u5DF2\u590D\u5236") : t("\u590D\u5236\u67E5\u8BE2\u6307\u4EE4"))
            )
          )
        )
      );
    }
    const filterBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8 } },
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: defenseFilter,
          "aria-label": t("\u6309\u4E8B\u4EF6\u7C7B\u578B\u7B5B\u9009"),
          onChange: (e) => setDefenseFilter(e.target.value)
        },
        ...typeOptions.map((opt) => React.createElement("option", { key: opt.value, value: opt.value }, opt.label))
      ),
      defenseFilter ? React.createElement("button", {
        className: "iterate-filter-clear",
        onClick: () => setDefenseFilter(""),
        title: t("\u6E05\u9664\u7C7B\u578B\u7B5B\u9009")
      }, t("\u6E05\u9664")) : null
    );
    let eventRows = [];
    if (visibleEvents.length > 0) {
      eventRows = visibleEvents.map((e, i) => {
        const type = String(e.type || "unknown");
        const loc = `${String(e.file || "?")}${typeof e.line === "number" && e.line > 0 ? `:${e.line}` : ""}`;
        return React.createElement(
          "div",
          { key: `def-${i}`, className: "iterate-obs-block" },
          React.createElement(
            "div",
            { className: "iterate-obs-block-head" },
            React.createElement("span", { className: "iterate-defense-badge", "data-type": type }, TYPE_LABEL[type] || type),
            typeof e.round === "number" ? React.createElement("span", { className: "iterate-obs-head-meta" }, `Round ${e.round}`) : null,
            React.createElement("span", { className: "iterate-obs-head-meta" }, loc)
          ),
          React.createElement(
            "div",
            { className: "iterate-obs-block-body" },
            React.createElement("div", { className: "iterate-obs-msg" }, String(e.description || "")),
            e.defense ? React.createElement("div", { className: "iterate-obs-msg", style: { marginTop: 4 } }, tf(`\u9632\u7EBF\uFF1A{a0}`, { a0: String(e.defense) })) : null
          )
        );
      });
    }
    return React.createElement(
      "div",
      {},
      headerBar,
      filterBar,
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { flexWrap: "wrap", gap: 6, marginBottom: 8 } },
        ...typeOptions.slice(1).map(
          (opt) => React.createElement(
            "span",
            { key: `cnt-${opt.value}`, className: "iterate-defense-badge", "data-type": opt.value },
            `${opt.label} ${counts[opt.value] || 0}`
          )
        )
      ),
      eventRows.length > 0 ? React.createElement("div", {}, ...eventRows) : React.createElement("div", { className: "iterate-obs-empty" }, t("\u6CA1\u6709\u5339\u914D\u8BE5\u7C7B\u578B\u7684\u9632\u5FA1\u4E8B\u4EF6"))
    );
  };
  const renderLive = () => {
    const liveEntries = manifest.live || [];
    if (liveEntries.length === 0) {
      const hasThreads = (manifest.rounds || []).length > 0;
      const hasFindings = (manifest.findings || []).length > 0;
      if (hasThreads || hasFindings) {
        return React.createElement(
          "div",
          { className: "iterate-obs-empty" },
          React.createElement("div", {}, t("\u5B9E\u65F6\u6D3B\u52A8\u6D41\u4EC5\u5728\u8FD0\u884C\u671F\u95F4\u8BB0\u5F55\uFF0C\u5F53\u524D\u5DF2\u5B8C\u6210\u3002")),
          React.createElement(
            "div",
            { className: "iterate-obs-bar", style: { marginTop: 8 } },
            React.createElement("button", { className: "iterate-btn", onClick: () => setTab("f1") }, t("\u67E5\u770B\u5BA1\u67E5\u7EBF\u7A0B")),
            React.createElement("button", { className: "iterate-btn", onClick: () => setTab("f3") }, t("\u67E5\u770B\u53D1\u73B0"))
          )
        );
      }
      return React.createElement("div", { className: "iterate-obs-empty" }, t("\u6682\u65E0\u5B9E\u65F6\u6D3B\u52A8"));
    }
    const types = Array.from(new Set(liveEntries.map((e) => String(e.type || "unknown")).filter(Boolean))).sort();
    const filtered = filterLiveEntries(liveEntries, liveType);
    const rows = filtered.map((e, i) => {
      const type = String(e.type || "unknown");
      const meta = OBS_LIVE_META[type];
      const typeLabel = meta ? meta.label[getLang()] : String(e.type || "?");
      const typeColor = meta ? meta.color : OBS_LIVE_FALLBACK_COLOR;
      const tool = String(e.tool || "");
      const target = String(e.target || "");
      const time = formatObsLiveTime(String(e.ts || ""));
      return React.createElement(
        "div",
        { key: `live-${i}`, className: "iterate-obs-row" },
        React.createElement("span", { className: "iterate-obs-livebadge", style: { color: typeColor } }, typeLabel),
        tool ? React.createElement("span", { className: "iterate-obs-chip" }, tool) : null,
        React.createElement("span", { className: "iterate-obs-msg" }, target || "\u2014"),
        React.createElement("span", { className: "iterate-obs-head-meta" }, time)
      );
    });
    const filterBar = React.createElement(
      "div",
      { className: "iterate-obs-bar", style: { marginBottom: 8 } },
      React.createElement("b", {}, t("\u5B9E\u65F6\u6D3B\u52A8")),
      React.createElement(
        "select",
        {
          className: "iterate-filter-select",
          value: liveType,
          "aria-label": t("\u6309\u6D3B\u52A8\u7C7B\u578B\u7B5B\u9009"),
          onChange: (e) => setLiveType(e.target.value)
        },
        React.createElement("option", { value: "" }, t("\u5168\u90E8\u6D3B\u52A8")),
        ...types.map((t2) => React.createElement("option", { key: t2, value: t2 }, t2))
      ),
      liveType ? React.createElement("button", {
        className: "iterate-filter-clear",
        onClick: () => setLiveType(""),
        title: t("\u6E05\u9664\u7C7B\u578B\u7B5B\u9009")
      }, t("\u6E05\u9664")) : null,
      React.createElement("span", { className: "iterate-filter-count" }, `${filtered.length}/${liveEntries.length}`)
    );
    if (rows.length === 0) {
      return React.createElement(
        "div",
        {},
        filterBar,
        React.createElement("div", { className: "iterate-obs-empty" }, t("\u65E0\u5339\u914D\u7684\u5B9E\u65F6\u6D3B\u52A8"))
      );
    }
    return React.createElement("div", {}, filterBar, ...rows);
  };
  const renderBody = () => {
    switch (tab) {
      case "live":
        return renderLive();
      case "f1":
        return renderThreads();
      case "f2":
        return renderTrend();
      case "f3":
        return renderFindings();
      case "f4":
        return renderFixes();
      case "f5":
        return renderCheckpoint();
      case "f6":
        return renderConsole();
      case "f7":
        return renderTimeline();
      // v3.0: Quality Command Center tabs
      case "f8":
        return renderQualityGate();
      case "f9":
        return renderExperienceBank();
      case "f10":
        return renderDefenseEvents();
      default:
        return null;
    }
  };
  return React.createElement(
    "div",
    { "data-iterate-root": "", "data-iterate": "obs", className: "iterate-obs" },
    React.createElement(
      "div",
      { className: "iterate-obs-head", "data-closed": open ? void 0 : "", onClick: () => setOpen((v) => !v) },
      React.createElement("span", { className: "iterate-obs-title" }, t("iterate \u89C2\u6D4B\u53F0")),
      React.createElement("span", { className: "iterate-obs-badge", "data-live": live ? "" : void 0 }, runStatusText(live, manifest)),
      React.createElement("span", { className: "iterate-obs-head-meta" }, headMeta || "runtime"),
      // Gap #14: make the tab system discoverable without expanding it.
      React.createElement("span", {
        className: "iterate-obs-head-meta",
        title: obsHotkeyHint()
      }, obsHotkeyHint()),
      React.createElement("button", {
        className: "iterate-btn",
        "data-ghost": "",
        onClick: (e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }
      }, open ? t("\u6536\u8D77") : t("\u5C55\u5F00"))
    ),
    open ? React.createElement(
      "div",
      {},
      copyFailText ? React.createElement(
        "div",
        { className: "iterate-obs-block" },
        React.createElement(
          "div",
          { className: "iterate-obs-block-head" },
          React.createElement("b", {}, t("\u590D\u5236\u672A\u6210\u529F")),
          React.createElement("span", { className: "iterate-obs-head-meta" }, t("\u526A\u8D34\u677F\u5199\u5165\u88AB\u62D2\u7EDD\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u4E0B\u65B9\u6307\u4EE4\u590D\u5236")),
          React.createElement("button", {
            className: "iterate-btn",
            "data-ghost": "",
            "aria-label": t("\u5173\u95ED\u590D\u5236\u5931\u8D25\u63D0\u793A"),
            onClick: () => setCopyFailText(null)
          }, t("\u5173\u95ED"))
        ),
        React.createElement("div", { className: "iterate-obs-code" }, copyFailText)
      ) : null,
      React.createElement(
        "div",
        { className: "iterate-obs-bar", style: { marginBottom: 8, flexWrap: "wrap" } },
        React.createElement(
          "span",
          { className: "iterate-obs-head-meta" },
          `${manifest.mode || "runtime"} \xB7 ${String(manifest.updatedAt || "")}`
        ),
        React.createElement("button", {
          className: "iterate-btn",
          "data-primary": "",
          "data-copied": copiedKey === "export" ? "" : void 0,
          onClick: exportObservatory,
          title: t("\u5C06\u89C2\u6D4B\u53F0\u5168\u90E8\u6570\u636E\u5BFC\u51FA\u4E3A JSON\uFF08\u4F18\u5148\u4E0B\u8F7D\uFF0C\u5931\u8D25\u5219\u590D\u5236\uFF09")
        }, copiedKey === "export" ? t("\u5DF2\u5BFC\u51FA") : t("\u5BFC\u51FA JSON")),
        // Gap #4: `.iterate/` artifacts are unreachable from the browser;
        // this copies the one instruction that makes the model echo them
        // into the session stream (which is what every panel scans).
        React.createElement("button", {
          className: "iterate-btn",
          "data-copied": copiedKey === "pull-snapshot" ? "" : void 0,
          onClick: () => copyInstruction("pull-snapshot", pullInstruction),
          title: pullTitle
        }, copiedKey === "pull-snapshot" ? t("\u5DF2\u590D\u5236") : t("\u62C9\u53D6\u78C1\u76D8\u5FEB\u7167"))
      ),
      React.createElement(
        "div",
        { className: "iterate-obs-tabs", role: "tablist", "aria-label": t("\u89C2\u6D4B\u53F0\u9875\u7B7E\uFF08\u5FEB\u6377\u952E 1-9 / 0 / -\uFF09") },
        ...OBS_TABS.map(
          (t2) => React.createElement("button", {
            key: t2.key,
            className: "iterate-obs-tab",
            role: "tab",
            "aria-selected": tab === t2.key,
            "data-active": tab === t2.key ? "" : void 0,
            onClick: () => setTab(t2.key),
            title: t2.hotkey ? tf(`{a0}\uFF08\u6309 {a1} \u5207\u6362\uFF09`, { a0: obsTabLabel(t2), a1: t2.hotkey }) : tf(`{a0}\uFF08\u6309 - \u5207\u6362\uFF09`, { a0: obsTabLabel(t2) })
          }, obsTabLabel(t2))
        )
      ),
      React.createElement("div", { className: "iterate-obs-body" }, renderBody())
    ) : null
  );
}
function selectTurnTail(owner) {
  if (!owner) return null;
  if (findReportInObject(owner.turn, void 0, 24) || scanSessionForReport(owner.turn)) return { matched: true };
  if (scanSessionForRunSummary(owner.turn)) return { matched: true };
  return null;
}
var LangDashboard = withLang(ConvergenceDashboard);
var LangObservatory = withLang(ObservatoryPanel);
var LangTurnTail = withLang(TurnTailEntry);
var LangProgress = withLang(ProgressCapsule);
var LangSettings = withLang(SettingsPanel);
function apply(ctx) {
  slotsSvc = readSlots(ctx);
  themeSvc = readTheme(ctx);
  storage2 = createStorage();
  configureLangStorage(storage2);
  setLang(
    detectLang(storage2.get(LANG_STORAGE_KEY), typeof navigator !== "undefined" ? navigator.language : ""),
    false
  );
  const savedTheme = storage2.get(THEME_STORAGE_KEY);
  themeEnabled = savedTheme === null ? true : savedTheme === "1";
  if (themeEnabled) applyThemeSkin();
  if (typeof document !== "undefined" && document.createElement && document.head) {
    if (!document.head.querySelector('style[data-iterate-lock="1"]')) {
      const style = document.createElement("style");
      style.dataset.iterateLock = "1";
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
        (props) => React.createElement(LangDashboard, props)
      )
    );
    slotsSvc.inject(
      "conversation.input.dock",
      () => slotsSvc?.register(
        { name: "conversation.input.dock", id: "iterate-observatory", order: 91 },
        (props) => React.createElement(LangObservatory, props)
      )
    );
    slotsSvc.inject(
      "conversation.chat.turnTail",
      () => slotsSvc?.register(
        { name: "conversation.chat.turnTail", id: "iterate-turn-tail", select: selectTurnTail },
        (props) => React.createElement(LangTurnTail, props)
      )
    );
    slotsSvc.inject(
      "shell.overlay",
      () => slotsSvc?.register(
        { name: "shell.overlay", id: "iterate-progress", order: 0 },
        (props) => React.createElement(LangProgress, props)
      )
    );
    slotsSvc.inject(
      "settings.section",
      () => slotsSvc?.register(
        { name: "settings.section", id: "iterate-settings", order: 30, label: () => "iterate" },
        (props) => React.createElement(LangSettings, props)
      )
    );
  }
  registerThemeListener(ctx);
}
return module.exports; } });

