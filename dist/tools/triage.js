import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import yaml from 'js-yaml';
import { resolveProjectRoot } from "../config-loader.js";
const CONFIG_FILE = 'iterate.config.yaml';
/** Personalization key that holds the known-intentional list. */
const PERSONALIZATION_KEY = 'personalization';
const KNOWN_INTENTIONAL_KEY = 'known_intentional';
/** Max entries per single `apply` call. */
const MAX_ENTRIES = 500;
/** Whole-file marker line (matches review.ts filterKnownIntentional semantics). */
const WHOLE_FILE_LINE = 0;
// ─── Pure helpers (exported for unit tests) ─────────────────────────────────
/**
 * Normalize a caller-supplied `line` value.
 * Returns a positive integer, or `undefined` when the value is absent,
 * non-numeric, or non-positive (which is the "whole file" semantics).
 *
 * @param {unknown} line
 * @returns {number | undefined}
 */
export function normalizeEntryLine(line) {
    if (typeof line !== 'number' || !Number.isInteger(line))
        return undefined;
    if (line <= 0)
        return undefined;
    return line;
}
/**
 * Validate an array of triage entries. Each entry must be an object with
 * non-empty string `file` / `dimension` / `reason`, and an optional positive
 * integer `line`.
 *
 * @param {unknown} entries
 * @returns {string[]} Validation error messages (empty when valid).
 */
export function validateTriageEntries(entries) {
    const errors = [];
    if (!Array.isArray(entries)) {
        errors.push('entries must be an array');
        return errors;
    }
    if (entries.length > MAX_ENTRIES) {
        errors.push(`entries must not exceed ${MAX_ENTRIES} items (got ${entries.length})`);
        return errors;
    }
    for (let i = 0; i < entries.length; i++) {
        const prefix = `entries[${i}]`;
        const e = entries[i];
        if (!e || typeof e !== 'object') {
            errors.push(`${prefix} must be an object`);
            continue;
        }
        const entry = e;
        if (typeof entry.file !== 'string' || entry.file.trim().length === 0) {
            errors.push(`${prefix}.file must be a non-empty string`);
        }
        if (typeof entry.dimension !== 'string' || entry.dimension.trim().length === 0) {
            errors.push(`${prefix}.dimension must be a non-empty string`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
            errors.push(`${prefix}.reason must be a non-empty string`);
        }
        if (entry.line !== undefined && normalizeEntryLine(entry.line) === undefined) {
            errors.push(`${prefix}.line must be a positive integer when present`);
        }
    }
    return errors;
}
/**
 * Build the dedupe key for a known-intentional entry.
 * Semantics mirror review.ts filterKnownIntentional: a whole-file entry
 * (`line` 0/undefined) is distinct from a line-specific one.
 *
 * @param {KnownIntentional} entry
 * @returns {string}
 */
export function entryKey(entry) {
    const line = normalizeEntryLine(entry.line) ?? WHOLE_FILE_LINE;
    return `${entry.file}|${entry.dimension}|${line}`;
}
/**
 * Merge incoming entries into the existing known-intentional list.
 * Existing entries are never mutated; incoming entries whose key already
 * exists are skipped. Returns the merged list plus add/skip counts.
 *
 * @param {KnownIntentional[]} existing
 * @param {KnownIntentional[]} incoming
 * @returns {{ merged: KnownIntentional[], added: number, skipped: number }}
 */
export function mergeKnownIntentional(existing, incoming) {
    const seen = new Set();
    const merged = [];
    for (const entry of existing) {
        const key = entryKey(entry);
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(entry);
        }
    }
    let added = 0;
    let skipped = 0;
    for (const entry of incoming) {
        const key = entryKey(entry);
        if (seen.has(key)) {
            skipped++;
            continue;
        }
        seen.add(key);
        merged.push(entry);
        added++;
    }
    return { merged, added, skipped };
}
/**
 * Build a NEW config object with `personalization.known_intentional` set to
 * the merged entries. All other top-level fields are preserved unchanged.
 * Returns a deep-enough copy so the caller can serialize it safely.
 *
 * @param {Record<string, unknown>} config
 * @param {KnownIntentional[]} entries
 * @returns {Record<string, unknown>}
 */
export function buildConfigWithKnownIntentional(config, entries) {
    const next = { ...config };
    const personalization = next[PERSONALIZATION_KEY] && typeof next[PERSONALIZATION_KEY] === 'object'
        ? { ...next[PERSONALIZATION_KEY] }
        : {};
    personalization[KNOWN_INTENTIONAL_KEY] = entries;
    next[PERSONALIZATION_KEY] = personalization;
    return next;
}
/** Read the raw known-intentional list from a config object (may be absent). */
export function readKnownIntentional(config) {
    const personalization = config[PERSONALIZATION_KEY];
    if (!personalization || typeof personalization !== 'object')
        return [];
    const known = personalization[KNOWN_INTENTIONAL_KEY];
    if (!Array.isArray(known))
        return [];
    return known.filter((e) => !!e &&
        typeof e === 'object' &&
        typeof e.file === 'string');
}
/** Build a filesystem-safe backup suffix from the current time. */
export function backupSuffix(now = new Date()) {
    return now.toISOString().replace(/[:.]/g, '-');
}
// ─── File I/O ───────────────────────────────────────────────────────────────
/** Load the raw config object (empty when the file is missing). */
function readConfigFile(configPath) {
    if (!existsSync(configPath))
        return {};
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(content);
    if (!parsed || typeof parsed !== 'object') {
        // A config that exists but is not a YAML mapping must NOT be silently
        // treated as empty: writing over it would destroy user data. Callers
        // surface this as an error and refuse to write.
        throw new Error('existing iterate.config.yaml is not a valid YAML mapping');
    }
    return parsed;
}
/** Apply the triage entries: backup, merge, write, rollback on failure. */
function applyEntries(projectRoot, incoming) {
    const configPath = join(projectRoot, CONFIG_FILE);
    let config;
    try {
        config = readConfigFile(configPath);
    }
    catch (err) {
        // The file exists but is malformed — refuse to overwrite user data.
        return { ok: false, error: `Failed to read config: ${String(err)}` };
    }
    const existing = readKnownIntentional(config);
    const { merged, added, skipped } = mergeKnownIntentional(existing, incoming);
    const nextConfig = buildConfigWithKnownIntentional(config, merged);
    const hadFile = existsSync(configPath);
    const backupPath = hadFile ? `${configPath}.bak-${backupSuffix()}` : null;
    if (backupPath) {
        try {
            copyFileSync(configPath, backupPath);
        }
        catch (err) {
            return {
                ok: false,
                error: `Failed to create backup: ${String(err)}`,
            };
        }
    }
    const yamlText = yaml.dump(nextConfig, { noRefs: true });
    try {
        writeFileSync(configPath, yamlText, 'utf-8');
    }
    catch (err) {
        // Rollback: restore the backup (or delete the file we just created).
        try {
            if (backupPath)
                copyFileSync(backupPath, configPath);
            else if (existsSync(configPath))
                writeFileSync(configPath, '', 'utf-8');
        }
        catch {
            // Rollback failure is reported, not swallowed silently.
        }
        return {
            ok: false,
            error: `Failed to write config: ${String(err)}`,
        };
    }
    return { ok: true, added, skipped, count: merged.length, configPath, backupPath };
}
/**
 * Register the `iterate_triage` tool.
 *
 * Completes the findings-triage closed loop: the client triage panel marks
 * findings as "known intentional" (a), and this tool writes those entries
 * into `iterate.config.yaml` under `personalization.known_intentional` so the
 * next review round filters them out (review.ts filterKnownIntentional).
 *
 * Operations:
 *  - `apply`: merge validated entries into the config (dedupe by
 *             file|dimension|line), with an automatic timestamped backup and
 *             rollback if the write fails.
 *  - `list`:  read back the current known_intentional entries.
 */
export function registerTriageTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_triage',
        description: 'Manage `personalization.known_intentional` entries in iterate.config.yaml. ' +
            'Use `apply` to write back triage verdicts (entries where the reviewer said "known intentional") so ' +
            'future review rounds filter them out. Entries are deduped by file|dimension|line and the config is ' +
            'backed up before writing. Use `list` to read the current entries. ' +
            'The client browser cannot write files, so this tool is the write-back channel for the triage panel.',
        parameters: {
            operation: {
                type: 'string',
                required: true,
                description: '"apply" to merge entries into the config, "list" to read them back.',
                enum: ['apply', 'list'],
            },
            entries: {
                type: 'json',
                description: 'For `apply`: array of known-intentional entries, e.g. ' +
                    '[{"file":"src/a.ts","line":42,"dimension":"security","reason":"..."}]. ' +
                    'Each entry needs non-empty string file/dimension/reason; line is an optional positive integer ' +
                    '(omitted = whole file).',
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
                    operation: { type: 'string', required: true },
                    added: { type: 'integer' },
                    skipped: { type: 'integer' },
                    count: { type: 'integer' },
                    path: { type: 'string' },
                    backupPath: { type: 'string' },
                    entries: { type: 'json' },
                    errors: { type: 'array', items: { type: 'string' } },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(args) {
            const resolved = resolveProjectRoot(args.path);
            if (!resolved.ok) {
                return { operation: args.operation, error: resolved.reason };
            }
            const projectRoot = resolved.root;
            const configPath = join(projectRoot, CONFIG_FILE);
            if (args.operation === 'list') {
                let config;
                try {
                    config = readConfigFile(configPath);
                }
                catch (err) {
                    return { operation: 'list', error: `Failed to read config: ${String(err)}` };
                }
                const entries = readKnownIntentional(config);
                return {
                    operation: 'list',
                    count: entries.length,
                    path: configPath,
                    entries: entries,
                };
            }
            if (args.operation === 'apply') {
                const validation = validateTriageEntries(args.entries);
                if (validation.length > 0) {
                    return { operation: 'apply', errors: validation, error: 'Invalid entries.' };
                }
                const incoming = args.entries.map((e) => {
                    const raw = e;
                    return {
                        file: String(raw.file),
                        ...(normalizeEntryLine(raw.line) !== undefined
                            ? { line: normalizeEntryLine(raw.line) }
                            : {}),
                        dimension: String(raw.dimension),
                        reason: String(raw.reason),
                    };
                });
                const result = applyEntries(projectRoot, incoming);
                if (!result.ok) {
                    return { operation: 'apply', error: result.error };
                }
                return {
                    operation: 'apply',
                    added: result.added,
                    skipped: result.skipped,
                    count: result.count,
                    path: result.configPath,
                    backupPath: result.backupPath ?? undefined,
                };
            }
            return {
                operation: args.operation,
                error: 'Unknown operation. Use "apply" or "list".',
            };
        },
    }));
}
