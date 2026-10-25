/**
 * src/tools/prune.ts — runtime artifact cleanup for the iterate loop.
 *
 *   iterate_prune — inspect or remove stale runtime artifacts (.iterate/).
 *                   Defaults to dry-run (report-only); set `dryRun: false` to
 *                   actually delete.
 *
 * Artifacts managed:
 *   - Stale checkpoint files (checkpoint.json).
 *   - Fix backups left over from old rounds (backups whose fix-id no longer
 *     appears in the registry).
 *   - Empty fix rounds (rounds with 0 records).
 *   - Stray temp files left behind by a crashed atomic write (see
 *     `isPrunableTemp` for the recognized naming conventions).
 *   - Experience bank entries beyond `MAX_EXPERIENCE_ENTRIES` (newest kept) —
 *     the bank grows across sessions with no natural bound; a sweep caps it.
 *   - Defense events older than `retainDays` (stale iteration streams that
 *     were never cleared).
 *
 * Artifacts NOT managed (deliberately):
 *   - The decision ledger (`.iterate/decision-log.jsonl`). It is a hash CHAIN since the
 *     kernel flip: every entry's `prevEntryHash` is the sha256 of the previous line's
 *     bytes, so dropping or renumbering one line invalidates every later one. Prune
 *     therefore never rewrites it — `pruneDecisionLog` reports what a cutoff WOULD have
 *     removed and names the two legal moves instead. The renumbering rewrite that used to
 *     live here is deleted, not hidden behind a flag.
 *
 * Security model:
 *   - Only operates under the resolved project `.iterate/` directory.
 *   - dryRun=true by default — the caller must explicitly opt into deletion.
 *   - Each non-dry-run appends ONE aggregate summary entry to the decision
 *     log (counts per artifact class) — not one log line per deleted file.
 */
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRootForExec } from "../config-loader.js";
import { writeJsonAtomic } from "../atomic-fs.js";
import { withProjectLock } from "../file-lock.js";
import { readDecisionEntries, appendDecisionEntry, decisionLogContestedLine } from "./decision-log.js";
import { readRegistry, recomputeRoundCounts } from "./fix.js";
import { readExperienceBank, writeExperienceBank } from "./experience-store.js";
import { readDefenseEvents, writeDefenseEvents } from "./defense-store.js";
import { iterateDir, fixesDir, checkpointPath, fixRegistryPath } from "../paths.js";
/** Retention window for the age-based artifacts (checkpoints, defense events). */
const DEFAULT_RETAIN_DAYS = 30;
const MIN_RETAIN_DAYS = 1;
const MAX_RETAIN_DAYS = 365;
/**
 * Upper bound on experience-bank entries retained by a prune sweep. The bank
 * accumulates curated knowledge across sessions and each entry is small, so a
 * generous cap drops only the oldest tail of a pathologically large bank
 * (never recent learning).
 */
export const MAX_EXPERIENCE_ENTRIES = 2000;
/** Clamp retainDays to a sane range. */
export function clampRetainDays(days) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
        return DEFAULT_RETAIN_DAYS;
    }
    return Math.min(Math.max(days, MIN_RETAIN_DAYS), MAX_RETAIN_DAYS);
}
/** Build the cutoff timestamp for a given retainDays. */
export function cutoffTimestamp(retainDays) {
    const d = new Date();
    d.setDate(d.getDate() - retainDays);
    return d.toISOString();
}
/**
 * Whether a file name inside `.iterate/` is a prunable leftover temp file.
 *
 * Recognized conventions (all written to the SAME directory as their target,
 * so they can never be confused with real state files):
 *   - `.<name>.tmp-<pid>-<rand>` — current atomic-fs.ts temp prefix;
 *   - `.tmp-<pid>-<rand>`        — legacy temp prefix (older plugin builds);
 *   - `<name>.tmp`               — legacy transcript.ts / live.ts temp suffix.
 *
 * Pure and exported for unit tests. A live writer's temp file is only visible
 * to it (unique name), so deleting any match is always safe.
 */
export function isPrunableTemp(name) {
    if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..')
        return false;
    if (name.startsWith('.tmp-'))
        return true;
    if (name.endsWith('.tmp'))
        return true;
    // .<basename>.tmp-<pid>-<rand>: starts with a dot and contains ".tmp-" after it.
    return name.startsWith('.') && name.includes('.tmp-');
}
/**
 * Bound the experience bank to its newest `cap` entries (by timestamp; ties
 * keep their original order via stable sort). Returns the trimmed bank plus
 * how many entries would be dropped. Never mutates the input bank.
 */
export function sweepExperienceBank(bank, cap) {
    const size = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : MAX_EXPERIENCE_ENTRIES;
    const total = bank.entries.length;
    if (total <= size)
        return { bank, removed: 0 };
    // Keep by POSITION, not by id: a Set of kept ids lets duplicate ids (a
    // hand-edited or double-written bank) defeat the cap — every original entry
    // sharing a kept id would survive, so `removed` stayed 0 and the cap never
    // applied. Rank positions newest-first (ties fall back to the original index
    // so equal timestamps keep insertion order, as before), keep the first `size`
    // positions, then re-emit the survivors in insertion order.
    const ranked = bank.entries.map((_, i) => i);
    ranked.sort((a, b) => {
        const ta = bank.entries[a]?.timestamp ?? '';
        const tb = bank.entries[b]?.timestamp ?? '';
        return tb.localeCompare(ta) || a - b;
    });
    const keep = new Set(ranked.slice(0, size));
    const ordered = bank.entries.filter((_, i) => keep.has(i));
    return {
        bank: { ...bank, entries: ordered, lastUpdated: new Date().toISOString() },
        removed: total - ordered.length,
    };
}
/**
 * Drop defense events older than `cutoff` from the stream using an ISO
 * timestamp comparison, recomputing the counts so they can never drift from
 * the surviving events. Never mutates the input stream.
 */
export function sweepDefenseEvents(stream, cutoff) {
    const kept = stream.events.filter((e) => e.timestamp >= cutoff);
    if (kept.length === stream.events.length)
        return { stream, removed: 0 };
    return {
        stream: {
            events: kept,
            lastUpdated: new Date().toISOString(),
            counts: computeDefenseCounts(kept),
        },
        removed: stream.events.length - kept.length,
    };
}
/** Recompute per-type defense counts from a list of events. */
function computeDefenseCounts(events) {
    const counts = {
        precondition_failed: 0,
        rollback: 0,
        invariant_violated: 0,
        assumption_falsified: 0,
    };
    for (const e of events) {
        if (e.type in counts)
            counts[e.type]++;
    }
    return counts;
}
/**
 * Inspect the runtime state and report what would be pruned.
 * Pure (no deletions). Returns a structured report.
 */
export function inspectPrune(projectRoot, retainDays) {
    const cutoff = cutoffTimestamp(retainDays);
    // 1. Decision-log entries older than retainDays — REPORTED, never removed: the ledger
    // is a hash chain (see `pruneDecisionLog`). `contestedLogLine` is the one ledger
    // condition a human has to settle, so the dry-run preview surfaces it.
    const entries = readDecisionEntries(projectRoot);
    const oldLogEntries = entries.filter((e) => e.timestamp < cutoff).length;
    const contestedLogLine = decisionLogContestedLine(projectRoot);
    // 2. Checkpoint presence. A checkpoint is only STALE once it is older than
    // retainDays — a fresh checkpoint means a run was interrupted recently and
    // may still be resumed, so `hasCheckpoint` is kept as pure existence while
    // `checkpointStale` decides whether a prune actually deletes it.
    const hasCheckpoint = existsSync(checkpointPath(projectRoot));
    let checkpointStale = false;
    if (hasCheckpoint) {
        try {
            const st = statSync(checkpointPath(projectRoot));
            if (st && st.mtimeMs < Date.parse(cutoff))
                checkpointStale = true;
        }
        catch {
            checkpointStale = true; // unreadable mtime — treat as garbage / deletable
        }
    }
    // 3. Stale fix backups: .bak files whose fix-id prefix is not in the registry.
    //
    // `readRegistry` returns an EMPTY registry for BOTH "file absent" and "file
    // present but corrupt" — and for the corrupt case an empty active-id set
    // would classify EVERY backup stale, so a single dryRun:false prune would
    // delete the entire rollback safety net. Read the registry file directly to
    // distinguish the two: absent ⇒ backups are orphaned (stale, delete as
    // before); present-but-unreadable ⇒ set `registryError`, classify nothing,
    // and let `executePrune`/the render surface the refusal.
    const registryFile = fixRegistryPath(projectRoot);
    let registryError = null;
    if (existsSync(registryFile)) {
        try {
            const parsed = JSON.parse(readFileSync(registryFile, 'utf-8'));
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rounds)) {
                registryError = `refusing to delete fix backups: fix registry is present but unreadable (invalid shape): ${registryFile}`;
            }
        }
        catch (err) {
            registryError = `refusing to delete fix backups: fix registry is present but unreadable: ${String(err)} (${registryFile})`;
        }
    }
    const registry = readRegistry(projectRoot);
    const activeIds = new Set();
    for (const r of registry.rounds) {
        for (const rec of r.records) {
            activeIds.add(rec.id);
        }
    }
    const staleBackups = [];
    const fixDir = fixesDir(projectRoot);
    // existsSync does not prove readability — a permissions failure must degrade
    // to "nothing listable" (report skipped) instead of throwing out of execute.
    let fixEntries = [];
    try {
        if (existsSync(fixDir))
            fixEntries = readdirSync(fixDir);
    }
    catch {
        fixEntries = [];
    }
    if (registryError === null) {
        for (const entry of fixEntries) {
            if (!entry.endsWith('.bak'))
                continue;
            // Extract the fix-id prefix (up to the first underscore after the id).
            // e.g. "fix-abc123_2026-08-17T00-00-00-000Z.bak" → "fix-abc123"
            const match = entry.match(/^(fix-[a-z0-9]+)_/);
            const id = match?.[1];
            if (id && !activeIds.has(id)) {
                staleBackups.push(entry);
            }
        }
    }
    // 4. Empty rounds (rounds with 0 records).
    const emptyRounds = registry.rounds
        .filter((r) => r.records.length === 0)
        .map((r) => r.round);
    // 5. Stray atomic-write temp files left behind by a crashed writer. The
    // unique prefix makes them recognizable and safe to delete — no live writer
    // ever reads another writer's temp file. A permissions failure listing the
    // dir degrades to "none found" (report-only) rather than throwing.
    let iterateEntries = [];
    try {
        iterateEntries = existsSync(iterateDir(projectRoot)) ? readdirSync(iterateDir(projectRoot)) : [];
    }
    catch {
        iterateEntries = [];
    }
    const staleTemps = iterateEntries.filter((f) => isPrunableTemp(f)).sort();
    // 6. Experience-bank oversize (entries beyond the entry cap). The bank grows
    // across sessions with no natural bound — a sweep reports the tail that a
    // prune would drop (newest `MAX_EXPERIENCE_ENTRIES` preserved).
    const bank = readExperienceBank(projectRoot);
    const sweptBank = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES);
    // 7. Defense events older than retainDays (a previous iteration's stream
    // that was never cleared).
    const defenseStream = readDefenseEvents(projectRoot);
    const sweptDefense = sweepDefenseEvents(defenseStream, cutoff);
    return {
        oldLogEntries,
        contestedLogLine,
        hasCheckpoint,
        checkpointStale,
        staleBackups,
        staleTemps,
        emptyRounds,
        totalLogEntries: entries.length,
        registryRounds: registry.rounds.length,
        registryError,
        totalExperiences: bank.entries.length,
        experienceOversize: sweptBank.removed,
        totalDefenseEvents: defenseStream.events.length,
        staleDefenseEvents: sweptDefense.removed,
    };
}
/**
 * Actually prune the runtime artifacts (only called when dryRun=false).
 * Returns a detailed report of what was deleted.
 */
/**
 * What a cutoff WOULD have removed from the decision ledger — and why nothing is removed.
 *
 * THE RENUMBERING REWRITE IS GONE, NOT HIDDEN BEHIND A FLAG. It used to filter the log to
 * the entries younger than `cutoff` and rewrite the whole file (temp + atomic rename, a
 * bounded retry loop, the cross-process lock). Against the kernel's hash chain that is not
 * a destructive-but-honest trim, it is forgery: entry i+1's `prevEntryHash` is the sha256
 * of entry i's BYTES, so dropping line 3 makes every later line's recorded link wrong —
 * and re-emitting the survivors with renumbered `sequence` and recomputed hashes produces
 * a chain that verifies while proving nothing, because it now claims "these decisions were
 * contiguous" about a file somebody deleted the middle of.
 *
 * So prune reads, reports, and touches nothing. The two legal moves belong to the ledger
 * itself and both are named in the remedy:
 *
 *   1. keep appending — an all-legacy log migrates onto the chain on its next write
 *      (verified before the swap, the original kept beside it at mode 0600) and a healthy
 *      chain simply grows; a line is bounded by PAYLOAD_MAX_CANONICAL_LENGTH, not by age;
 *   2. settle a CONTESTED ledger by CHOOSING archive-and-restart
 *      (`iterate_decision_log({operation:"archive"})` / `archiveContestedDecisionLog`),
 *      which renames the file to `…contested-<stamp>.jsonl` at mode 0600 and lets the next
 *      append start a fresh chain. It refuses a healthy or an all-legacy ledger, so it can
 *      never become a way to erase continuity by accident.
 *
 * `cutoff` stays in the signature because the REPORT needs it: `retained` is exactly the
 * number of lines the old code would have deleted, which is what a human weighs when
 * deciding whether a ledger is worth settling.
 */
export function pruneDecisionLog(projectRoot, cutoff) {
    const entries = readDecisionEntries(projectRoot);
    const retained = entries.filter((e) => e.timestamp < cutoff).length;
    const contestedLine = decisionLogContestedLine(projectRoot);
    return {
        deleted: 0,
        retained,
        contestedLine,
        code: 'ITERATE_E_DECISION_LOG_IMMUTABLE',
        error: `the decision ledger is a hash chain: ${retained} ` +
            `entr${retained === 1 ? 'y' : 'ies'} older than ${cutoff} are RETAINED, not rewritten`,
        remedy: 'a chain cannot be trimmed in place — every later line links to the bytes of the line before it, ' +
            'so deleting or renumbering one forges the rest. Two legal moves: (1) keep appending: an all-legacy ' +
            'ledger migrates onto the chain on its next write and a healthy one just grows; (2) if an append ' +
            'reports ITERATE_E_DECISION_LOG_INTERLEAVED, a human settles it with archive-and-restart — ' +
            'iterate_decision_log({operation:"archive"}) moves the contested ledger aside losslessly (mode 0600) ' +
            'and the next append starts a clean chain. Prune never deletes a ledger line.',
    };
}
/**
 * Actually prune the runtime artifacts (only called when dryRun=false).
 * Returns a detailed report of what was deleted.
 */
/**
 * Execute the prune: apply every cleanable item reported by `inspectPrune`.
 * Every step is individually hedged so a single disk failure degrades to a
 * reported error rather than aborting the whole cleanup.
 */
export function executePrune(projectRoot, retainDays, report) {
    const cutoff = cutoffTimestamp(retainDays);
    const ledger = pruneDecisionLog(projectRoot, cutoff);
    const result = {
        // Always 0: a ledger line is never deleted by prune. The field stays because the
        // prune summary (and the audit entry it logs) has always carried it.
        deletedLogEntries: 0,
        retainedLogEntries: ledger.retained,
        decisionLog: { code: ledger.code, error: ledger.error, remedy: ledger.remedy },
        deletedCheckpoint: false,
        deletedBackups: [],
        deletedTemps: [],
        trimmedEmptyRounds: 0,
        deletedExperiences: 0,
        deletedDefenseEvents: 0,
        errors: [],
    };
    // 1. The decision ledger is READ-ONLY here: nothing is deleted, nothing is rewritten
    // (see `pruneDecisionLog`). The refusal is always reported; a CONTESTED ledger is
    // additionally escalated into `errors`, because that is a broken state only a human can
    // settle — archive-and-restart is offered, never taken.
    if (ledger.contestedLine !== null) {
        result.errors.push(`line ${ledger.contestedLine} of the decision ledger is a legacy record appended after the chain ` +
            `began (ITERATE_E_DECISION_LOG_INTERLEAVED). ${ledger.remedy}`);
    }
    // 2. Remove checkpoint — ONLY when it is actually stale (older than
    // retainDays). A fresh checkpoint is a live resume point for a recently
    // interrupted run; pruning it would silently destroy the ability to resume.
    if (report.checkpointStale) {
        try {
            rmSync(checkpointPath(projectRoot), { force: true });
            result.deletedCheckpoint = true;
        }
        catch (err) {
            result.errors.push(`failed to remove checkpoint: ${String(err)}`);
        }
    }
    // 3. Delete stale backups — REFUSED outright when the registry is present
    // but unreadable: without a readable active-id set every backup would have
    // classified stale, and one dryRun:false prune would wipe the whole rollback
    // safety net. Surface the refusal as a structured error instead.
    if (report.registryError) {
        result.errors.push(report.registryError);
    }
    else {
        for (const bak of report.staleBackups) {
            try {
                unlinkSync(join(fixesDir(projectRoot), bak));
                result.deletedBackups.push(bak);
            }
            catch (err) {
                result.errors.push(`failed to delete backup ${bak}: ${String(err)}`);
            }
        }
    }
    // 4. Trim empty rounds from the registry (locked read-modify-write: the
    // registry read and rewrite must not interleave with another process's
    // fix/rollback or the update is lost — see src/file-lock.ts).
    if (report.emptyRounds.length > 0) {
        try {
            withProjectLock(projectRoot, 'fix-registry', () => {
                let registry = readRegistry(projectRoot);
                const emptyRoundNos = new Set(report.emptyRounds);
                // Drop whole empty rounds (records.length === 0) instead of only
                // removing their records — an empty round has no records to remove, so
                // the old loop was a no-op that still reported trimmedEmptyRounds.
                registry = {
                    ...registry,
                    rounds: registry.rounds.filter((r) => !emptyRoundNos.has(r.round) || (r.records?.length ?? 0) > 0),
                };
                registry = recomputeRoundCounts(registry);
                writeJsonAtomic(fixRegistryPath(projectRoot), registry);
            });
            result.trimmedEmptyRounds = report.emptyRounds.length;
        }
        catch (err) {
            result.errors.push(`failed to trim empty rounds: ${String(err)}`);
        }
    }
    // 5. Remove stray atomic-write temp files.
    for (const tmp of report.staleTemps) {
        try {
            rmSync(join(iterateDir(projectRoot), tmp), { force: true });
            result.deletedTemps.push(tmp);
        }
        catch (err) {
            result.errors.push(`failed to delete temp file ${tmp}: ${String(err)}`);
        }
    }
    // 6. Trim the experience bank to its entry cap (newest wins).
    if (report.experienceOversize > 0) {
        try {
            const bank = readExperienceBank(projectRoot);
            const { bank: swept, removed } = sweepExperienceBank(bank, MAX_EXPERIENCE_ENTRIES);
            if (removed > 0) {
                writeExperienceBank(projectRoot, swept);
                result.deletedExperiences = removed;
            }
        }
        catch (err) {
            result.errors.push(`failed to trim experience bank: ${String(err)}`);
        }
    }
    // 7. Drop defense events older than retainDays (recounted on write).
    if (report.staleDefenseEvents > 0) {
        try {
            const stream = readDefenseEvents(projectRoot);
            const { stream: swept, removed } = sweepDefenseEvents(stream, cutoff);
            if (removed > 0) {
                writeDefenseEvents(projectRoot, swept);
                result.deletedDefenseEvents = removed;
            }
        }
        catch (err) {
            result.errors.push(`failed to sweep defense events: ${String(err)}`);
        }
    }
    return result;
}
/**
 * Register the `iterate_prune` tool.
 * Defaults to dry-run: inspects the runtime state and reports what would be
 * cleaned up. Pass `dryRun: false` to actually delete.
 */
export function registerPruneTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_prune',
        // Pending-call card (#12): say up front whether this sweep is the default
        // report-only preview or a REAL deletion — that distinction is prune's
        // entire safety model, so it must be visible before the call runs. Pure:
        // derived from args only.
        presentCall: (args) => {
            const a = args;
            const deleting = a.dryRun === false;
            return {
                card: 'generic',
                title: deleting
                    ? 'Prune stale .iterate/ artifacts (delete)'
                    : 'Prune preview (dry run — nothing deleted)',
                kind: deleting ? 'delete' : 'read',
            };
        },
        description: 'Inspect or clean up old iterate runtime artifacts (.iterate/). ' +
            'Defaults to dry-run (report-only, no deletion). Pass `dryRun: false` to actually prune. ' +
            'Manages: stale checkpoints, orphaned fix backups, empty fix rounds, ' +
            'stray temp files left by crashed atomic writes, experience-bank entries beyond the entry cap, ' +
            'and stale defense events. ' +
            'The decision ledger is NEVER trimmed: it is a hash chain, so a removed or renumbered line ' +
            'would invalidate every later one. Prune reports how many lines a cutoff would have removed ' +
            'and names the two legal moves (keep appending / human-chosen archive-and-restart). ' +
            'A non-dry-run appends ONE aggregate summary entry (counts per artifact class) to the decision log.',
        parameters: {
            dryRun: {
                type: 'boolean',
                description: 'When true (default), only report what would be pruned without deleting anything.',
            },
            retainDays: {
                type: 'integer',
                description: `Keep entries newer than this many days (default: ${DEFAULT_RETAIN_DAYS}, range: ${MIN_RETAIN_DAYS}-${MAX_RETAIN_DAYS}).`,
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
                    dryRun: { type: 'boolean', required: true },
                    retainDays: { type: 'integer' },
                    report: { type: 'json' },
                    result: { type: 'json' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.ok)
                    return [{ type: 'text', text: `prune failed: ${value.error}` }];
                const report = value.report;
                const result = value.result;
                if (value.dryRun) {
                    const registryError = report?.registryError;
                    const lines = [
                        `[dry-run] prune report (retainDays=${value.retainDays}):`,
                        `  Decision-log entries older than retainDays: ${report?.oldLogEntries ?? '?'} (of ${report?.totalLogEntries ?? '?'}) — RETAINED, a hash chain is never trimmed`,
                        report?.contestedLogLine
                            ? `  CONTESTED ledger: line ${report.contestedLogLine} is a legacy record after the chain — settle it with iterate_decision_log({operation:"archive"})`
                            : '  Ledger continuity: no interleaved legacy records',
                        `  Checkpoint to delete: ${report?.checkpointStale ? 'yes (stale)' : report?.hasCheckpoint ? 'no (fresh — resume point, kept)' : 'none'}`,
                        registryError
                            ? `  Stale backups to delete: none — ${registryError}`
                            : `  Stale backups to delete: ${report?.staleBackups?.length ?? 0}`,
                        `  Stray temp files to delete: ${report?.staleTemps?.length ?? 0}`,
                        `  Empty rounds to trim: ${report?.emptyRounds?.length ?? 0}`,
                        `  Experience entries to drop (over ${report?.totalExperiences ?? '?'} cap): ${report?.experienceOversize ?? 0} of ${report?.totalExperiences ?? '?'}`,
                        `  Stale defense events to remove: ${report?.staleDefenseEvents ?? 0} (of ${report?.totalDefenseEvents ?? '?'})`,
                        '',
                        'Pass dryRun:false to execute the prune.',
                    ];
                    return [{ type: 'text', text: lines.join('\n') }];
                }
                const lines = [
                    `Prune complete (retainDays=${value.retainDays}):`,
                    `  Decision-log lines deleted: ${result?.deletedLogEntries ?? 0} — ${result?.retainedLogEntries ?? 0} older than the cutoff RETAINED (${result?.decisionLog?.code ?? 'hash chain'}: never renumbered).`,
                    `  Checkpoint deleted: ${result?.deletedCheckpoint ? 'yes' : 'no'}`,
                    `  Deleted ${result?.deletedBackups?.length ?? 0} stale backups.`,
                    `  Deleted ${result?.deletedTemps?.length ?? 0} stray temp files.`,
                    `  Trimmed ${result?.trimmedEmptyRounds ?? 0} empty rounds.`,
                    `  Trimmed ${result?.deletedExperiences ?? 0} experience entries (over the entry cap).`,
                    `  Removed ${result?.deletedDefenseEvents ?? 0} stale defense events.`,
                ];
                const errs = result?.errors ?? [];
                if (errs.length > 0) {
                    lines.push('', '  Warnings:');
                    for (const e of errs)
                        lines.push(`    - ${e}`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { ok: false, dryRun: true, error: resolved.reason };
            const projectRoot = resolved.root;
            const retainDays = clampRetainDays(args.retainDays);
            const dryRun = args.dryRun !== false;
            const report = inspectPrune(projectRoot, retainDays);
            if (dryRun) {
                return {
                    ok: true,
                    dryRun: true,
                    retainDays,
                    report: report,
                };
            }
            const result = executePrune(projectRoot, retainDays, report);
            // Log the prune to the decision log. The mutations already happened, so
            // a failed log append is reported via `errors` — a silent audit miss
            // (F2) must never pretend every deletion was recorded.
            const logRes = appendDecisionEntry(projectRoot, {
                timestamp: new Date().toISOString(),
                round: 0,
                type: 'decision',
                data: {
                    action: 'prune',
                    retainDays,
                    deletedLogEntries: result.deletedLogEntries,
                    retainedLogEntries: result.retainedLogEntries,
                    // The ledger itself was not touched; record WHY, so an audit reader can tell
                    // "prune deleted nothing" apart from "prune was refused by an immutable chain".
                    decisionLogRefusal: result.decisionLog.code,
                    deletedCheckpoint: result.deletedCheckpoint,
                    deletedBackups: result.deletedBackups.length,
                    trimmedEmptyRounds: result.trimmedEmptyRounds,
                    deletedExperiences: result.deletedExperiences,
                    deletedDefenseEvents: result.deletedDefenseEvents,
                },
            });
            if (logRes.error)
                result.errors.push(logRes.error);
            return {
                ok: true,
                dryRun: false,
                retainDays,
                report: report,
                result: result,
            };
        },
    }));
}
