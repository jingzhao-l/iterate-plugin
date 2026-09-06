/**
 * src/transcript.ts — runtime-observatory transcript builder.
 *
 * Pure, deterministic, memory-bounded accumulator that turns normalized
 * iteration events into a serializable {@link TranscriptManifest} the client
 * renders. This is the data backbone for the observatory UI layer:
 *   - F1  — per-reviewer sub-agent message streams (threads per round/dimension).
 *   - F2  — per-round convergence series.
 *   - F3  — full finding list with file/line location for jump + triage.
 *   - F4  — applied-fix records (for diff + rollback).
 *   - F5  — checkpoint summary (resume).
 *   - F6  — nudge channel (steer the next round).
 *   - F7  — append-only decision timeline.
 *
 * It performs NO I/O and NEVER touches the filesystem — persistence lives in
 * the `iterate_transcript` tool. Inputs are defensively normalized so a
 * malformed event can never crash dedupe/sort or leak non-JSON state.
 *
 * Growth is bounded per field (threads/round capped, messages per thread
 * capped, timeline capped) so a very long run cannot blow up memory or the
 * client payload; the newest events win when a cap is hit.
 */
/** Manifest schema version (bump on incompatible shape change). */
export const TRANSCRIPT_VERSION = 1;
/** Max threads recorded per round (extra dimensions/retries beyond this drop). */
const MAX_THREADS_PER_ROUND = 12;
/** Max narration messages kept per thread (newest wins). */
const MAX_MESSAGES_PER_THREAD = 40;
/** Max findings kept per thread. */
const MAX_FINDINGS_PER_THREAD = 100;
/** Max global findings kept in the manifest. */
const MAX_FINDINGS_TOTAL = 2000;
/** Max timeline entries kept (newest wins). */
const MAX_TIMELINE = 500;
/** Max applied-fix records kept (newest wins; bounded so a long run cannot
 *  grow the manifest payload without limit). */
const MAX_FIXES = 200;
/** Thresholds applied when reducing a string list under a cap. */
function clampStringList(source, cap) {
    const out = [];
    for (const item of source) {
        if (typeof item !== 'string')
            continue;
        const trimmed = item.trim();
        if (!trimmed)
            continue;
        out.push(trimmed);
        if (out.length >= cap)
            break;
    }
    return out;
}
/** Normalize a single finding, dropping malformed entries. */
function normalizeFinding(input) {
    if (!input || typeof input !== 'object')
        return null;
    const f = input;
    const dimension = typeof f.dimension === 'string' ? f.dimension : '';
    const file = typeof f.file === 'string' ? f.file : '';
    const summary = typeof f.summary === 'string' ? f.summary : '';
    if (!dimension || !file || !summary)
        return null;
    const sev = f.severity;
    const severity = sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low'
        ? sev
        : 'low';
    const line = typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : 0;
    return {
        dimension,
        file,
        line,
        severity,
        summary,
        failure_scenario: typeof f.failure_scenario === 'string' ? f.failure_scenario : undefined,
        suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : undefined,
        is_atomic: typeof f.is_atomic === 'boolean' ? f.is_atomic : undefined,
        acknowledged: typeof f.acknowledged === 'boolean' ? f.acknowledged : undefined,
    };
}
/** Merge a report snapshot's findings/readFiles into a thread by dimension. */
function mergeReportIntoThread(thread, findings, readFiles) {
    for (const raw of findings) {
        const f = normalizeFinding(raw);
        if (f)
            thread.findings.push(raw);
    }
    for (const r of readFiles ?? []) {
        if (typeof r === 'string')
            thread.readFiles.push(r);
    }
}
/**
 * The transcript builder. Create one per project run, feed normalized events,
 * then call {@link serialize}. Safe to call from any thread sequentially.
 */
export class ReviewTranscriptBuilder {
    project;
    mode;
    taskMode;
    approval;
    goal = '';
    phases = [];
    round = 0;
    maxRounds = 0;
    active = true;
    rounds = [];
    convergence = [];
    globalFindings = [];
    fixes = [];
    checkpoint = null;
    timeline = [];
    nudge = null;
    updatedAt;
    constructor(input) {
        this.project = input.project || '';
        this.mode =
            input.mode === 'dry-run' || input.mode === 'normal' ? input.mode : null;
        // v3.0: task_mode indicator. An explicit valid value wins; otherwise a
        // run that exercises the review loop (any mode) defaults to "iterate".
        this.taskMode =
            input.taskMode === 'code' || input.taskMode === 'iterate'
                ? input.taskMode
                : input.mode !== null && input.mode !== undefined
                    ? 'iterate'
                    : null;
        this.approval =
            input.approval === 'ask' || input.approval === 'deny' || input.approval === 'allow'
                ? input.approval
                : 'ask';
        this.goal = typeof input.goal === 'string' ? input.goal : '';
        this.maxRounds =
            typeof input.maxRounds === 'number' && Number.isFinite(input.maxRounds) && input.maxRounds >= 0
                ? Math.floor(input.maxRounds)
                : 0;
        this.updatedAt = input.now ? input.now() : new Date().toISOString();
    }
    // ─── Run lifecycle ──────────────────────────────────────────────────────
    /** Mark the run started (clears the transcript for a fresh session). */
    begin(goal, maxRounds) {
        if (typeof goal === 'string' && goal)
            this.goal = goal;
        if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds >= 0) {
            this.maxRounds = Math.floor(maxRounds);
        }
        this.active = true;
        this.touch();
    }
    /** Record a workflow phase name (plan / review / fix / validate / report …). */
    phase(name) {
        const n = typeof name === 'string' ? name.trim() : '';
        if (!n)
            return;
        if (this.phases[this.phases.length - 1] !== n)
            this.phases.push(n);
        this.touch();
    }
    /** End the run (stops the "active" pulsing in the UI). */
    finish() {
        this.active = false;
        this.touch();
    }
    /** Open a review round, capturing the current round index. */
    roundStart(round, maxRounds) {
        const r = typeof round === 'number' && Number.isFinite(round) ? Math.floor(round) : 1;
        this.round = r > 0 ? r : 1;
        if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds >= 0) {
            this.maxRounds = Math.floor(maxRounds);
        }
        while (this.rounds.length < this.round) {
            this.rounds.push({ round: this.rounds.length + 1, threads: [] });
        }
        this.touch();
    }
    // ─── Reviewer threads (F1) ──────────────────────────────────────────────
    /** Start a reviewer sub-agent's thread for the current round. */
    reviewerStart(dimension, attempt = 1) {
        const dim = typeof dimension === 'string' ? dimension.trim() : 'review';
        const att = typeof attempt === 'number' && Number.isFinite(attempt) ? Math.floor(attempt) : 1;
        this.roundStart(this.round);
        const live = this.rounds[this.round - 1];
        if (live && this.threadCount(live) < MAX_THREADS_PER_ROUND) {
            live.threads.push({
                dimension: dim || 'review',
                attempt: att > 0 ? att : 1,
                messages: [],
                readFiles: [],
                findings: [],
            });
        }
        this.touch();
    }
    /** Append narration (assistant text) to the current reviewer thread. */
    reviewerMessage(text) {
        if (typeof text !== 'string' || !text.trim())
            return;
        const thread = this.currentThread();
        if (!thread)
            return;
        thread.messages.push(text);
        if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
            thread.messages.splice(0, thread.messages.length - MAX_MESSAGES_PER_THREAD);
        }
        this.touch();
    }
    /** Record files the current reviewer opened (read_file). */
    reviewerRead(files) {
        const thread = this.currentThread();
        if (!thread)
            return;
        for (const f of files ?? []) {
            if (typeof f === 'string')
                thread.readFiles.push(f);
        }
        this.touch();
    }
    /** Record findings the current reviewer produced (both raw and normalized). */
    reviewerFindings(findings) {
        const thread = this.currentThread();
        if (!thread)
            return;
        if (Array.isArray(findings)) {
            for (const raw of findings) {
                const f = normalizeFinding(raw);
                if (f) {
                    thread.findings.push(raw);
                    this.globalFindings.push(f);
                }
            }
        }
        this.reevaluateGlobal();
        this.touch();
    }
    /** Merge a round-level report snapshot (findings + readFiles) into a thread. */
    reviewerSnapshot(dimension, findings, readFiles) {
        this.reviewerStart(dimension);
        const thread = this.currentThread();
        if (!thread)
            return;
        mergeReportIntoThread(thread, findings, readFiles);
        for (const raw of findings) {
            const f = normalizeFinding(raw);
            if (f)
                this.globalFindings.push(f);
        }
        this.reevaluateGlobal();
        this.touch();
    }
    // ─── Convergence (F2) ───────────────────────────────────────────────────
    /** Record a round's new-finding count for the convergence series. */
    snapshotConvergence(round, newCount) {
        const r = typeof round === 'number' && Number.isFinite(round) ? Math.floor(round) : 1;
        const n = typeof newCount === 'number' && Number.isFinite(newCount) ? newCount : 0;
        while (this.convergence.length < r)
            this.convergence.push(-1);
        this.convergence[r - 1] = Math.floor(n);
        this.touch();
    }
    // ─── Fixes (F4) ─────────────────────────────────────────────────────────
    /** Record an applied atomic fix. */
    fix(record) {
        if (!record || typeof record !== 'object')
            return;
        const id = typeof record.id === 'string' ? record.id : '';
        const file = typeof record.file === 'string' ? record.file : '';
        if (!id || !file)
            return;
        this.fixes.push({
            id,
            timestamp: typeof record.timestamp === 'string' ? record.timestamp : isoNow(),
            round: typeof record.round === 'number' ? record.round : this.round,
            file,
            summary: typeof record.summary === 'string' ? record.summary : '',
            linesAdded: typeof record.linesAdded === 'number' ? Math.floor(record.linesAdded) : 0,
            linesRemoved: typeof record.linesRemoved === 'number' ? Math.floor(record.linesRemoved) : 0,
            success: record.success !== false,
        });
        if (this.fixes.length > MAX_FIXES) {
            this.fixes.splice(0, this.fixes.length - MAX_FIXES);
        }
        this.touch();
    }
    /** Flag a fix as rolled back (kept in the list so the UI shows the reversal). */
    markFixRolledBack(id) {
        for (const f of this.fixes) {
            if (f.id === id)
                f.success = false;
        }
        this.touch();
    }
    // ─── Checkpoint (F5) ────────────────────────────────────────────────────
    /** Record the current checkpoint summary (null clears it). */
    recordCheckpoint(state) {
        if (!state || typeof state !== 'object') {
            this.checkpoint = null;
            this.touch();
            return;
        }
        this.checkpoint = {
            mode: state.mode === 'dry-run' || state.mode === 'normal' ? state.mode : 'normal',
            round: typeof state.round === 'number' ? state.round : 0,
            maxRounds: typeof state.maxRounds === 'number' ? state.maxRounds : 0,
            fixedCount: typeof state.fixedCount === 'number' ? state.fixedCount : 0,
            resumeCount: typeof state.resumeCount === 'number' ? state.resumeCount : 0,
            updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : isoNow(),
        };
        this.touch();
    }
    // ─── Decision timeline (F7) ─────────────────────────────────────────────
    /** Append one decision-log entry to the timeline (newest wins under the cap). */
    decision(entry) {
        if (!entry || typeof entry !== 'object')
            return;
        const type = typeof entry.type === 'string' ? entry.type : 'decision';
        this.timeline.push({
            timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : isoNow(),
            round: typeof entry.round === 'number' ? entry.round : this.round,
            type,
            data: entry.data && typeof entry.data === 'object'
                ? entry.data
                : {},
        });
        if (this.timeline.length > MAX_TIMELINE) {
            this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
        }
        this.touch();
    }
    // ─── Nudge (F6) ─────────────────────────────────────────────────────────
    /** Write steering text for the next round (null clears it). */
    setNudge(text) {
        if (typeof text === 'string' && text.trim()) {
            this.nudge = { timestamp: isoNow(), text: text.trim() };
        }
        else {
            this.nudge = null;
        }
        this.touch();
    }
    // ─── Serialization ──────────────────────────────────────────────────────
    /** Produce the current serializable manifest. */
    serialize() {
        const rounds = this.rounds.map((r, idx) => ({
            round: r.round,
            threads: r.threads.map((t) => ({
                dimension: t.dimension,
                attempt: t.attempt,
                messages: clampStringList(t.messages, MAX_MESSAGES_PER_THREAD),
                readFiles: dedupePaths(t.readFiles),
                findings: t.findings
                    .map((x) => normalizeFinding(x))
                    .filter((x) => x !== null),
            })),
        }));
        return {
            version: TRANSCRIPT_VERSION,
            project: this.project,
            updatedAt: this.updatedAt,
            active: this.active,
            mode: this.mode,
            taskMode: this.taskMode,
            goal: this.goal,
            phases: this.phases,
            round: this.round,
            maxRounds: this.maxRounds,
            rounds,
            convergence: this.convergence,
            findings: this.globalFindings.length > MAX_FINDINGS_TOTAL
                ? this.globalFindings.slice(0, MAX_FINDINGS_TOTAL)
                : this.globalFindings,
            fixes: this.fixes,
            checkpoint: this.checkpoint,
            timeline: this.timeline,
            nudge: this.nudge,
            approval: {
                active: this.approval !== 'allow',
                policy: this.approval,
            },
        };
    }
    // ─── Internals ──────────────────────────────────────────────────────────
    /** Bump the manifest's updatedAt to reflect a fresh mutation. */
    touch() {
        this.updatedAt = isoNow();
    }
    /** Current round's most recent thread, if any. */
    currentThread() {
        const live = this.rounds[this.round - 1];
        if (!live)
            return null;
        const thread = live.threads[live.threads.length - 1];
        return thread ?? null;
    }
    /** Count threads already recorded for a round. */
    threadCount(live) {
        return live.threads.length;
    }
    /** Recompute the global finding list from per-thread findings (dedup). */
    reevaluateGlobal() {
        // Rebuild from threads to derive a deterministic global list.
        this.globalFindings.length = 0;
        const seen = new Set();
        for (const r of this.rounds) {
            for (const t of r.threads) {
                for (const raw of t.findings) {
                    const f = normalizeFinding(raw);
                    if (!f)
                        continue;
                    const key = `${f.file}\u0000${f.line ?? 0}\u0000${f.dimension}\u0000${f.summary}`;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    this.globalFindings.push(f);
                    if (this.globalFindings.length >= MAX_FINDINGS_TOTAL)
                        return;
                }
            }
        }
    }
}
/** Dedupe + bound an ordered string list of file paths. */
function dedupePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        if (typeof p !== 'string' || !p.trim())
            continue;
        const k = p.trim();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(k);
    }
    return out;
}
/** ISO timestamp helper (kept injectable in tests via the builder's now). */
function isoNow() {
    return new Date().toISOString();
}
