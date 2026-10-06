/**
 * src/tools/defense-events.ts — defense event stream query & record tool.
 *
 *   iterate_defense_events — browse/search defense events from the current
 *                            iteration, or record a new one.
 *
 * Defense events include: precondition failures, rollbacks, invariant violations,
 * and assumption falsifications. Read operations give visibility into defensive
 * actions; "record" persists a new event to .iterate/defense-events.json.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRootForExec, loadEffectiveConfig } from "../config-loader.js";
import { withProjectLock } from "../file-lock.js";
import { readDefenseEvents, writeDefenseEvents, addDefenseEvent, clearDefenseEvents } from "./defense-store.js";
import { renderedText } from "./present.js";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EVENT_TYPES = [
    'precondition_failed',
    'rollback',
    'invariant_violated',
    'assumption_falsified',
];
/**
 * Clamp a caller-supplied limit to a sane range.
 * Anything that is not a positive integer falls back to the default — the
 * parameter schema already rejects non-integers, but hand-constructed args
 * (and future internal callers) still land here. Pure — exported for unit tests.
 */
export function clampLimit(limit) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
        return DEFAULT_LIMIT;
    }
    return Math.min(limit, MAX_LIMIT);
}
/** Bilingual, config-driven human-readable labels for defense event types. */
const EVENT_TYPE_LABELS = {
    precondition_failed: { zh: '前置校验失败', en: 'precondition failed' },
    rollback: { zh: '回滚', en: 'rollback' },
    invariant_violated: { zh: '不变量违反', en: 'invariant violated' },
    assumption_falsified: { zh: '假设被证伪', en: 'assumption falsified' },
};
/** Label for a defense event type in the requested language (fallback: English). */
function labelFor(type, language) {
    const labels = EVENT_TYPE_LABELS[type];
    return labels ? labels[language] : type;
}
/** Validate arguments for the record operation. */
function validateRecordInput(args) {
    const errors = [];
    if (typeof args.type !== 'string' || !EVENT_TYPES.includes(args.type)) {
        errors.push(`type must be one of: ${EVENT_TYPES.join(', ')}`);
    }
    if (typeof args.round !== 'number' || !Number.isInteger(args.round) || args.round < 1) {
        errors.push('round must be a positive integer');
    }
    if (typeof args.description !== 'string' || !args.description.trim()) {
        errors.push('description is required');
    }
    if (typeof args.defense !== 'string' || !args.defense.trim()) {
        errors.push('defense is required');
    }
    if (typeof args.outcome !== 'string' || !args.outcome.trim()) {
        errors.push('outcome is required');
    }
    // Positions are 1-BASED. `line: 0` is not usable here even though the
    // evidence/review layer treats 0 as "whole file": the renderer prints the
    // position only for a truthy line (`file + ':' + line`), so a stored 0 would
    // come back as a bare file path with no indication of what it meant — and
    // the client-side normalizer already degrades 0 to null ("not a usable
    // position"). Reject it at the door instead of persisting a silent 0.
    if (args.line !== undefined && (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < 1)) {
        errors.push('line must be a positive integer (>= 1) when present');
    }
    const severity = args.severity;
    if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low') {
        errors.push('severity must be one of critical, high, medium, low');
    }
    return errors;
}
/**
 * Register the `iterate_defense_events` tool.
 * Queries defense events from the current iteration.
 */
export function registerDefenseEventsTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_defense_events',
        // Result card (#12): the `counts` render is a column of per-type lines —
        // fold it into one headline ("Defense events: 3 recorded (rollback: 2)").
        // Only `counts` gets a card; other operations keep the default view.
        // Pure: parsed from the rendered text; an unreadable shape declines.
        presentResult: (args, result) => {
            const a = args;
            if (a.operation !== 'counts')
                return undefined;
            const text = renderedText(result);
            if (!text)
                return undefined;
            const lines = text.split('\n');
            const totalLine = lines.find((l) => l.trim().startsWith('Total:'));
            const totalMatch = totalLine ? /Total:\s*(\d+)/.exec(totalLine) : null;
            const total = totalMatch ? Number(totalMatch[1]) : NaN;
            if (!Number.isFinite(total))
                return undefined;
            // Per-type rows ("  rollback: 2"), localized labels included; the zero
            // rows are dropped so the headline only names types that actually fired.
            const detail = lines
                .filter((l) => /^\s{2,}\S.*:\s*\d+\s*$/.test(l))
                .map((l) => l.trim())
                .filter((l) => !l.startsWith('Total:') && !/:\s*0\s*$/.test(l));
            return {
                card: 'generic',
                title: `Defense events: ${total} recorded` + (detail.length > 0 ? ` (${detail.join(', ')})` : ''),
            };
        },
        // List/counts never write; `record` persists an event and `clear` removes
        // the persisted stream, so only the read shapes may join a parallel
        // dispatch group.
        isConcurrencySafe: (args) => {
            const op = args.operation;
            return op !== 'record' && op !== 'clear';
        },
        description: 'Query, record, or clear defense events: precondition failures, rollbacks, invariant violations, ' +
            'and assumption falsifications. ' +
            'List/counts return events with descriptions, outcomes, and summary counts; ' +
            '"record" persists a new event to .iterate/defense-events.json; ' +
            '"clear" resets the persisted event stream (use it to start a fresh iteration without stale ' +
            'defense data). ' +
            'Use it to review defensive actions taken, or to log one when a defense fires.',
        parameters: {
            operation: {
                type: 'string',
                description: 'Operation: list (browse all), counts (summary by type), record (log a new event), clear (reset the stream). Default: list.',
                enum: ['list', 'counts', 'record', 'clear'],
            },
            type: {
                type: 'string',
                description: 'Event type (filter for list; required for record): precondition_failed, rollback, invariant_violated, assumption_falsified.',
            },
            round: {
                type: 'integer',
                description: 'Round number (filter for list; required for record).',
            },
            severity: {
                type: 'string',
                description: 'Severity (filter for list; required for record): critical, high, medium, low.',
            },
            description: {
                type: 'string',
                description: 'What was being checked (required for record).',
            },
            defense: {
                type: 'string',
                description: 'The defense that was triggered (required for record).',
            },
            outcome: {
                type: 'string',
                description: 'Outcome: what was protected against (required for record).',
            },
            file: {
                type: 'string',
                description: 'Optional file/location context (record).',
            },
            line: {
                type: 'integer',
                description: 'Optional line number context (record): a 1-based line number (>= 1).',
            },
            language: {
                type: 'string',
                description: 'Label language for readable output: en (default) or zh. Falls back to the project config language.',
                enum: ['en', 'zh'],
            },
            limit: {
                type: 'integer',
                description: `Max events to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}).`,
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
                    operation: { type: 'string' },
                    count: { type: 'integer', description: 'list: number of events actually returned (after limit truncation).' },
                    total: { type: 'integer', description: 'list: total number of matching events before the limit was applied.' },
                    counted: { type: 'boolean', description: 'clear only: true when a persisted stream was removed.' },
                    events: { type: 'json' },
                    counts: { type: 'json' },
                    event: { type: 'json' },
                    language: { type: 'string' },
                    errors: { type: 'json' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.ok)
                    return [{ type: 'text', text: `defense events query failed: ${value.error}` }];
                const language = value.language === 'zh' ? 'zh' : 'en';
                if (value.operation === 'clear') {
                    // Fresh stream: counts are all zero and the event list is empty.
                    return [{ type: 'text', text: [
                                value.counted === true
                                    ? 'Defense event stream cleared — a fresh iteration starts with an empty stream.'
                                    : 'No persisted defense event stream to clear.',
                                'Defense Event Summary:',
                                ...EVENT_TYPES.map((type) => `  ${labelFor(type, language)}: 0`),
                            ].join('\n') }];
                }
                if (value.operation === 'counts' && value.counts) {
                    const counts = value.counts;
                    const lines = [
                        'Defense Event Summary:',
                        ...EVENT_TYPES.map((type) => `  ${labelFor(type, language)}: ${counts[type] ?? 0}`),
                        `  Total: ${EVENT_TYPES.reduce((sum, type) => sum + (counts[type] ?? 0), 0)}`,
                    ];
                    return [{ type: 'text', text: lines.join('\n') }];
                }
                if (value.operation === 'record' && value.event) {
                    const e = value.event;
                    return [{ type: 'text', text: [
                                `Recorded defense event: ${e.id}`,
                                `  Round ${e.round} - ${labelFor(e.type, language)} (${e.severity})`,
                                `  Check: ${e.description}`,
                                `  Defense: ${e.defense}`,
                                `  Outcome: ${e.outcome}`,
                                e.file ? `  File: ${e.file}${e.line ? `:${e.line}` : ''}` : '',
                            ].filter(Boolean).join('\n') }];
                }
                const events = value.events ?? [];
                if (events.length === 0) {
                    return [{ type: 'text', text: 'No defense events recorded.' }];
                }
                const lines = [
                    // `total` is the UNTRUNCATED match count; `count` is what survived
                    // the limit. Printing only one number (the old `count` as "total")
                    // hid the real stream size from the reader.
                    `Defense Events (showing ${value.count} of ${value.total}):`,
                    '',
                    ...events.map((e) => {
                        const typeLabel = labelFor(e.type, language);
                        return `[${e.id}] Round ${e.round} - ${typeLabel}\n  ${e.description}\n  Outcome: ${e.outcome}`;
                    }),
                ];
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { ok: false, kind: 'defense_events', error: resolved.reason };
            const projectRoot = resolved.root;
            // A hand-edited `language` value outside zh/en must not leak out of the
            // declared 'zh' | 'en' enum (labelFor would return undefined for it) —
            // normalize any non-'zh' config value to 'en'.
            const rawConfigLang = loadEffectiveConfig(projectRoot).config.language;
            const configLang = rawConfigLang === 'zh' ? 'zh' : 'en';
            const language = args.language === 'zh' || args.language === 'en' ? args.language : configLang;
            const operation = typeof args.operation === 'string' ? args.operation : 'list';
            const limit = clampLimit(args.limit);
            if (operation === 'clear') {
                // Reset the persisted event stream so a fresh iteration does not carry
                // stale defensive data (mirrors iterate_quality_gate clear / clearQualityGate).
                // Same lock as `record`: clear is a read-modify-write against the same
                // file, so an unlocked clear racing a locked record could resurrect
                // the just-cleared events (the record's write lands after the rm).
                const result = withProjectLock(projectRoot, 'defense-events', () => clearDefenseEvents(projectRoot));
                if (!result.ok) {
                    return { ok: false, kind: 'defense_events', operation: 'clear', error: result.error };
                }
                const empty = readDefenseEvents(projectRoot);
                return {
                    ok: true,
                    kind: 'defense_events',
                    operation: 'clear',
                    counted: result.existed,
                    language,
                    counts: empty.counts,
                    events: empty.events,
                };
            }
            if (operation === 'record') {
                const errors = validateRecordInput(args);
                if (errors.length > 0) {
                    return {
                        ok: false,
                        kind: 'defense_events',
                        operation: 'record',
                        errors: errors,
                        error: `Invalid defense event: ${errors.join('; ')}`,
                    };
                }
                // The read→modify→write below is the exact cross-process race the
                // decision log documents: two plugin processes reading the same
                // stream concurrently each append their own event and the second
                // write silently drops the first. Serialize the whole cycle with the
                // shared advisory lock (fail-open on timeout is built into the
                // helper — worst case is the pre-existing unlocked behavior).
                return withProjectLock(projectRoot, 'defense-events', () => {
                    const stream = readDefenseEvents(projectRoot);
                    const next = addDefenseEvent(stream, {
                        round: args.round,
                        type: args.type,
                        description: args.description,
                        defense: args.defense,
                        outcome: args.outcome,
                        severity: args.severity,
                        ...(typeof args.file === 'string' && args.file.length > 0 ? { file: args.file } : {}),
                        ...(typeof args.line === 'number' ? { line: args.line } : {}),
                    });
                    const write = writeDefenseEvents(projectRoot, next);
                    if (!write.ok) {
                        return { ok: false, kind: 'defense_events', operation: 'record', error: write.error };
                    }
                    const event = next.events[next.events.length - 1];
                    return {
                        ok: true,
                        kind: 'defense_events',
                        operation: 'record',
                        language,
                        event: event,
                        counts: next.counts,
                    };
                });
            }
            const stream = readDefenseEvents(projectRoot);
            if (operation === 'counts') {
                return {
                    ok: true,
                    kind: 'defense_events',
                    operation: 'counts',
                    language,
                    counts: stream.counts,
                };
            }
            // Filter events
            let events = stream.events;
            if (typeof args.type === 'string' && args.type) {
                events = events.filter((e) => e.type === args.type);
            }
            if (typeof args.round === 'number') {
                events = events.filter((e) => e.round === args.round);
            }
            if (typeof args.severity === 'string' && args.severity) {
                events = events.filter((e) => e.severity === args.severity);
            }
            // Sort by timestamp descending (newest first)
            events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            return {
                ok: true,
                kind: 'defense_events',
                operation: 'list',
                language,
                // `count` = events actually returned (limit-truncated);
                // `total` = every event matching the filters, before truncation.
                count: Math.min(events.length, limit),
                total: events.length,
                events: events.slice(0, limit),
            };
        },
    }));
}
