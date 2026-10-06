/**
 * src/tools/experience-bank.ts — experience bank query tool.
 *
 *   iterate_experience — browse, search, query, and add project experience entries.
 *
 * Experiences are accumulated across sessions and stored in .iterate/experience.json.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRootForExec } from "../config-loader.js";
import { withProjectLock } from "../file-lock.js";
import { readExperienceBank, writeExperienceBank, searchExperienceEntries, upsertExperience, removeExperience, isValidExperienceId, MAX_EXPERIENCE_ID_LENGTH } from "./experience-store.js";
import { resultHeadline } from "./present.js";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
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
/** Validate a caller-supplied experience entry object. Returns error strings. */
function validateExperienceInput(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return ['entry must be a JSON object'];
    }
    const e = raw;
    const errors = [];
    if (typeof e.pattern !== 'string' || !e.pattern.trim())
        errors.push('.pattern is required');
    if (typeof e.dimension !== 'string' || !e.dimension.trim())
        errors.push('.dimension is required');
    if (typeof e.description !== 'string' || !e.description.trim())
        errors.push('.description is required');
    if (typeof e.verifiedFix !== 'string' || !e.verifiedFix.trim())
        errors.push('.verifiedFix is required');
    if (typeof e.findingSummary !== 'string' || !e.findingSummary.trim())
        errors.push('.findingSummary is required');
    const severity = e.severity;
    if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low') {
        errors.push('.severity must be one of critical, high, medium, low');
    }
    if (!Array.isArray(e.files) || !e.files.every((f) => typeof f === 'string' && f.length > 0)) {
        errors.push('.files must be an array of non-empty strings');
    }
    if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) {
        errors.push('.tags must be an array of strings');
    }
    return errors;
}
/** Normalize a validated raw entry into the store input shape. */
function normalizeExperienceInput(raw) {
    return {
        ...(typeof raw.id === 'string' && raw.id.length > 0 ? { id: raw.id } : {}),
        pattern: raw.pattern,
        description: raw.description,
        verifiedFix: raw.verifiedFix,
        dimension: raw.dimension,
        findingSummary: raw.findingSummary,
        severity: raw.severity,
        files: raw.files,
        tags: raw.tags,
    };
}
/**
 * Register the `iterate_experience` tool.
 * Queries the experience bank for historical fixes and patterns.
 */
export function registerExperienceBankTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_experience',
        // Result card (#12): each operation renders a self-describing first line
        // ("Found 3 experience(s)…", "Recorded new experience: exp-…") — reuse it
        // as the card title. Pure: rendered result only; failures decline.
        presentResult: (_args, result) => {
            const title = resultHeadline(result);
            return title ? { card: 'generic', title } : undefined;
        },
        // List/search/get never write; `add` upserts the bank and `remove`
        // rewrites it → only the read shapes may join a parallel dispatch group.
        isConcurrencySafe: (args) => {
            const op = args.operation;
            return op !== 'add' && op !== 'remove';
        },
        description: 'Query or extend the experience bank: browse/search historical fixes and patterns, ' +
            'or record a new verified fix (operation:"add"). ' +
            'List/search/get return matching entries with hit counts, verified fixes, and related context. ' +
            '"add" upserts an experience entry into .iterate/experience.json — a repeat of the same ' +
            'pattern+dimension increments its hit count instead of duplicating it. ' +
            '"remove" deletes an entry by id (useful for pruning stale or incorrect experiences). ' +
            'Use it to remember fixes that worked so future rounds apply them first.',
        parameters: {
            operation: {
                type: 'string',
                description: 'Operation: list (browse all), search (by query), get (by id), add (add a new experience), remove (delete by id). Default: list.',
                enum: ['list', 'search', 'get', 'add', 'remove'],
            },
            query: {
                type: 'string',
                description: 'Search query (for search operation). Matches against pattern, description, files, tags.',
            },
            dimension: {
                type: 'string',
                description: 'Filter by dimension (e.g., correctness, security, performance).',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by tags (AND logic).',
            },
            id: {
                type: 'string',
                description: 'Experience ID (required for get and remove). For `add`, name the entry via `entry.id` ' +
                    '— a top-level `id` is not read on add.',
            },
            entry: {
                type: 'json',
                description: 'Experience entry object (required for add). Fields: id (optional), pattern, dimension, description, ' +
                    'verifiedFix, findingSummary, severity (critical|high|medium|low), files (string[]), tags (string[]).',
            },
            limit: {
                type: 'integer',
                description: `Max entries to return (default: ${DEFAULT_LIMIT}, cap: ${MAX_LIMIT}).`,
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
                    entries: { type: 'json' },
                    entry: { type: 'json' },
                    totalHits: { type: 'integer' },
                    added: { type: 'boolean' },
                    errors: { type: 'json' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                if (!value.ok)
                    return [{ type: 'text', text: `experience query failed: ${value.error}` }];
                if (value.operation === 'add' && value.entry) {
                    const entry = value.entry;
                    return [{ type: 'text', text: [
                                value.added
                                    ? `Recorded new experience: ${entry.id}`
                                    : `Experience already known (hit ${entry.hitCount}): ${entry.id}`,
                                `Pattern: ${entry.pattern}`,
                                `Dimension: ${entry.dimension}`,
                                `Description: ${entry.description}`,
                                `Fix: ${entry.verifiedFix}`,
                                `Files: ${Array.isArray(entry.files) ? entry.files.join(', ') : ''}`,
                                `Tags: ${Array.isArray(entry.tags) ? entry.tags.join(', ') : ''}`,
                            ].join('\n') }];
                }
                if (value.operation === 'remove') {
                    return [{ type: 'text', text: `Removed experience entry. Bank now holds ${value.count ?? 0} entries (${value.totalHits ?? 0} cumulative hits).` }];
                }
                if (value.operation === 'get' && value.entry) {
                    const entry = value.entry;
                    return [{ type: 'text', text: [
                                `Experience: ${entry.id}`,
                                `Pattern: ${entry.pattern}`,
                                `Description: ${entry.description}`,
                                `Fix: ${entry.verifiedFix}`,
                                `Files: ${Array.isArray(entry.files) ? entry.files.join(', ') : ''}`,
                                `Hits: ${entry.hitCount}`,
                                `Tags: ${Array.isArray(entry.tags) ? entry.tags.join(', ') : ''}`,
                            ].join('\n') }];
                }
                const entries = value.entries ?? [];
                const lines = [
                    `Found ${value.count} experience(s) (total hits: ${value.totalHits})`,
                    '',
                    ...entries.map((e) => `[${e.id}] ${e.pattern} (hits: ${e.hitCount}) - ${e.description}`),
                ];
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok)
                return { ok: false, kind: 'experience', error: resolved.reason };
            const projectRoot = resolved.root;
            const operation = typeof args.operation === 'string' ? args.operation : 'list';
            const limit = clampLimit(args.limit);
            if (operation === 'add') {
                const raw = args.entry;
                const errors = validateExperienceInput(raw);
                if (errors.length > 0) {
                    return {
                        ok: false,
                        kind: 'experience',
                        operation: 'add',
                        errors: errors,
                        error: `Invalid experience entry: ${errors.join('; ')}`,
                    };
                }
                // Serialize the read→modify→write cycle: two processes adding to the
                // same bank concurrently would otherwise lose one of the entries
                // (exactly the race the shared advisory lock exists for; fail-open
                // on lock timeout is built into the helper).
                return withProjectLock(projectRoot, 'experience-bank', () => {
                    const bank = readExperienceBank(projectRoot);
                    const input = normalizeExperienceInput(raw);
                    // A caller-supplied id may only NAME a new entry — reject ids that
                    // would not survive contact with disk/output (oversized or
                    // control-byte). An id that matches an EXISTING entry is an update
                    // and keeps working unchanged.
                    if (input.id !== undefined &&
                        !bank.entries.some((e) => e.id === input.id) &&
                        !isValidExperienceId(input.id)) {
                        return {
                            ok: false,
                            kind: 'experience',
                            operation: 'add',
                            error: `entry.id must be a printable string of at most ${MAX_EXPERIENCE_ID_LENGTH} characters ` +
                                '(non-empty, no control characters) when it does not match an existing entry',
                        };
                    }
                    const { bank: next, added, entryId } = upsertExperience(bank, input);
                    const write = writeExperienceBank(projectRoot, next);
                    if (!write.ok) {
                        return { ok: false, kind: 'experience', operation: 'add', error: write.error };
                    }
                    const entry = next.entries.find((e) => e.id === entryId);
                    return {
                        ok: true,
                        kind: 'experience',
                        operation: 'add',
                        added,
                        count: next.entries.length,
                        entry: entry,
                        totalHits: next.totalHits,
                    };
                });
            }
            if (operation === 'remove') {
                const id = typeof args.id === 'string' && args.id ? args.id : '';
                if (!id) {
                    return {
                        ok: false,
                        kind: 'experience',
                        operation: 'remove',
                        error: 'id is required for remove',
                    };
                }
                // Same read→modify→write hazard as `add` — hold the shared lock for
                // the whole cycle so a concurrent remove cannot resurrect a deleted
                // entry.
                return withProjectLock(projectRoot, 'experience-bank', () => {
                    const bank = readExperienceBank(projectRoot);
                    const { bank: next, removed } = removeExperience(bank, id);
                    if (!removed) {
                        return {
                            ok: false,
                            kind: 'experience',
                            operation: 'remove',
                            error: `Experience not found: ${id}`,
                        };
                    }
                    const write = writeExperienceBank(projectRoot, next);
                    if (!write.ok) {
                        return { ok: false, kind: 'experience', operation: 'remove', error: write.error };
                    }
                    return {
                        ok: true,
                        kind: 'experience',
                        operation: 'remove',
                        count: next.entries.length,
                        totalHits: next.totalHits,
                    };
                });
            }
            // `get`/`search` require their argument: silently falling through to
            // `list` would answer a get with a DIFFERENT operation's payload
            // (ok:true + entries) — mirror the `remove` contract and error instead.
            if (operation === 'get') {
                const id = typeof args.id === 'string' && args.id ? args.id : '';
                if (!id) {
                    return {
                        ok: false,
                        kind: 'experience',
                        operation: 'get',
                        error: 'id is required for get',
                    };
                }
                const bank = readExperienceBank(projectRoot);
                const entry = bank.entries.find((e) => e.id === id);
                if (!entry) {
                    return { ok: false, kind: 'experience', operation: 'get', error: `Experience not found: ${id}` };
                }
                return {
                    ok: true,
                    kind: 'experience',
                    operation: 'get',
                    count: 1,
                    entry: entry,
                    totalHits: bank.totalHits ?? 0,
                };
            }
            if (operation === 'search') {
                const query = typeof args.query === 'string' && args.query ? args.query : '';
                if (!query) {
                    return {
                        ok: false,
                        kind: 'experience',
                        operation: 'search',
                        error: 'query is required for search',
                    };
                }
                const bank = readExperienceBank(projectRoot);
                const entries = searchExperienceEntries(bank.entries, query, {
                    dimension: typeof args.dimension === 'string' ? args.dimension : undefined,
                    tags: Array.isArray(args.tags) ? args.tags : undefined,
                }).slice(0, limit);
                return {
                    ok: true,
                    kind: 'experience',
                    operation: 'search',
                    count: entries.length,
                    entries: entries,
                    totalHits: bank.totalHits ?? 0,
                };
            }
            // Default: list with optional filters
            const bank = readExperienceBank(projectRoot);
            let entries = bank.entries;
            if (typeof args.dimension === 'string' && args.dimension) {
                entries = entries.filter((e) => e.dimension === args.dimension);
            }
            if (Array.isArray(args.tags) && args.tags.length > 0) {
                entries = entries.filter((e) => args.tags.every((t) => Array.isArray(e.tags) && e.tags.includes(t)));
            }
            return {
                ok: true,
                kind: 'experience',
                operation: 'list',
                count: Math.min(entries.length, limit),
                entries: entries.slice(0, limit),
                totalHits: bank.totalHits ?? 0,
            };
        },
    }));
}
