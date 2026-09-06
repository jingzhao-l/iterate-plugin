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
import { readDefenseEvents, writeDefenseEvents, addDefenseEvent } from "./defense-store.js";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EVENT_TYPES = [
    'precondition_failed',
    'rollback',
    'invariant_violated',
    'assumption_falsified',
];
/** Clamp a caller-supplied limit to a sane range. */
function clampLimit(limit) {
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
    if (args.line !== undefined && (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < 0)) {
        errors.push('line must be a non-negative integer when present');
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
        description: 'Query or record defense events: precondition failures, rollbacks, invariant violations, ' +
            'and assumption falsifications. ' +
            'List/counts return events with descriptions, outcomes, and summary counts; ' +
            '"record" persists a new event to .iterate/defense-events.json. ' +
            'Use it to review defensive actions taken, or to log one when a defense fires.',
        parameters: {
            operation: {
                type: 'string',
                description: 'Operation: list (browse all), counts (summary by type), record (log a new event). Default: list.',
                enum: ['list', 'counts', 'record'],
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
                description: 'Optional line number context (record).',
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
                    count: { type: 'integer' },
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
                    `Defense Events (${value.count} total):`,
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
            const configLang = loadEffectiveConfig(projectRoot).config.language;
            const language = args.language === 'zh' || args.language === 'en' ? args.language : configLang;
            const operation = typeof args.operation === 'string' ? args.operation : 'list';
            const limit = clampLimit(args.limit);
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
                count: Math.min(events.length, limit),
                events: events.slice(0, limit),
            };
        },
    }));
}
