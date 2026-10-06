/**
 * src/config-write.ts — shared helpers for safely WRITING iterate.config.yaml.
 *
 * Used by the `iterate_config` write operation. Provides:
 *   - validateConfigUpdates : validate a caller-supplied partial update
 *   - applyConfigUpdates    : merge a partial update into the current config
 *   - writeConfigFile       : backup + write + rollback on failure
 *
 * The security posture mirrors the triage tool: never overwrite a malformed
 * config, always back up before writing, roll back on failure.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { writeTextAtomic } from "./atomic-fs.js";
import { MAX_ATOMIC_MAX_LINES, MAX_MAX_ADJACENT_METHODS, MAX_MAX_ROUNDS, MAX_SCOPE_CHUNK_SIZE, SUPPORTED_CONFIG_KEYS, } from "./config-loader.js";
export { MAX_ATOMIC_MAX_LINES, MAX_MAX_ADJACENT_METHODS, MAX_MAX_ROUNDS, MAX_SCOPE_CHUNK_SIZE, };
/** Config file name (must match config-loader). */
export const CONFIG_FILE = 'iterate.config.yaml';
/**
 * Monotonic collision guard for {@link configBackupSuffix}: two writes in the
 * SAME millisecond used to build the identical `config.bak-<iso>` path, so the
 * second backup overwrote the first and one snapshot was silently lost.
 * Only ever moves forward (a clock stepping backwards also counts as a
 * collision), so every suffix issued by this process is unique.
 */
let lastSuffixMs = -1;
let suffixSequence = 0;
/**
 * Backup suffix helper (filesystem-safe timestamp + monotonic disambiguator).
 * The ISO timestamp is kept verbatim when the millisecond is fresh (existing
 * `config.bak-…` names sort chronologically); repeats within the same
 * millisecond get `-1`, `-2`, … appended so the backup path never collides.
 */
export function configBackupSuffix(now = new Date()) {
    const ms = now.getTime();
    if (ms > lastSuffixMs) {
        lastSuffixMs = ms;
        suffixSequence = 0;
    }
    else {
        suffixSequence += 1;
    }
    const base = now.toISOString().replace(/[:.]/g, '-');
    return suffixSequence === 0 ? base : `${base}-${suffixSequence}`;
}
/** Keep at most this many timestamped config backups (older ones are removed). */
export const MAX_CONFIG_BACKUPS = 5;
/**
 * Top-level keys `iterate_config` accepts in `updates`.
 *
 * The write path MERGES updates into the file, so an unrecognized key used to
 * be persisted verbatim: a typo (`maxRounds`) or a hallucinated field
 * (`task_modes`) silently became part of the project's config, survived every
 * later read, and was never consumed by anything. Rejecting unknown keys turns
 * that silent no-op into a structured error the model can correct.
 *
 * Defined once in config-loader (shared with `validateConfig`) and re-exported
 * here under its write-path name.
 */
export const SUPPORTED_UPDATE_KEYS = SUPPORTED_CONFIG_KEYS;
/**
 * Bound the timestamped config backups: after a fresh one is written, delete
 * every older `config.bak-*` file beyond the newest `keep`. Best-effort — a
 * filesystem failure here must never fail the write that just succeeded.
 * @returns the absolute paths of the backups that were removed.
 */
export function pruneOldConfigBackups(configPath, keep = MAX_CONFIG_BACKUPS) {
    const removed = [];
    try {
        const dir = dirname(configPath);
        const prefix = `${basename(configPath)}.bak-`;
        const matches = existsSync(dir)
            ? readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()
            : [];
        const doomed = matches.slice(0, Math.max(0, matches.length - keep));
        for (const f of doomed) {
            rmSync(join(dir, f), { force: true });
            removed.push(join(dir, f));
        }
    }
    catch {
        // Best-effort cleanup — never surface a cleanup failure.
    }
    return removed;
}
/**
 * Validate a partial config update.
 * Returns an array of error strings (empty when the update is valid).
 */
export function validateConfigUpdates(updates) {
    const errors = [];
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return ['updates must be a JSON object'];
    }
    // Unknown top-level keys are refused rather than merged into the file
    // (see SUPPORTED_UPDATE_KEYS for why a typo used to persist forever).
    for (const key of Object.keys(updates)) {
        if (!SUPPORTED_UPDATE_KEYS.includes(key)) {
            errors.push(`updates.${key} is not a supported config key (supported: ${SUPPORTED_UPDATE_KEYS.join(', ')})`);
        }
    }
    if ('goal' in updates && typeof updates.goal !== 'string') {
        errors.push('updates.goal must be a string');
    }
    if ('language' in updates && updates.language !== 'zh' && updates.language !== 'en') {
        errors.push('updates.language must be "zh" or "en"');
    }
    if ('dimensions' in updates) {
        // `.some` on an EMPTY array is false, so `dimensions: []` used to validate
        // clean and then replace the whole dimension list with "review nothing".
        if (!Array.isArray(updates.dimensions) ||
            updates.dimensions.length === 0 ||
            updates.dimensions.some((d) => typeof d !== 'string' || d.trim().length === 0)) {
            errors.push('updates.dimensions must be a non-empty array of non-empty strings');
        }
    }
    if ('max_rounds' in updates) {
        if (typeof updates.max_rounds !== 'number' || !Number.isInteger(updates.max_rounds) ||
            updates.max_rounds < 1 || updates.max_rounds > MAX_MAX_ROUNDS) {
            errors.push(`updates.max_rounds must be an integer between 1 and ${MAX_MAX_ROUNDS}`);
        }
    }
    if ('reasoning_effort' in updates) {
        if (updates.reasoning_effort !== undefined &&
            updates.reasoning_effort !== 'low' &&
            updates.reasoning_effort !== 'medium' &&
            updates.reasoning_effort !== 'high') {
            errors.push('updates.reasoning_effort must be "low", "medium", or "high"');
        }
    }
    if ('reviewer' in updates) {
        const rv = updates.reviewer;
        if (!rv || typeof rv !== 'object' || Array.isArray(rv)) {
            errors.push('updates.reviewer must be an object');
        }
        else {
            for (const boolKey of ['output_schema_validation', 'evidence_validation', 'coverage_validation']) {
                if (rv[boolKey] !== undefined && typeof rv[boolKey] !== 'boolean') {
                    errors.push(`updates.reviewer.${boolKey} must be a boolean`);
                }
            }
            if (rv.scope_chunk_size !== undefined &&
                (typeof rv.scope_chunk_size !== 'number' || !Number.isInteger(rv.scope_chunk_size) ||
                    rv.scope_chunk_size < 1 || rv.scope_chunk_size > MAX_SCOPE_CHUNK_SIZE)) {
                errors.push(`updates.reviewer.scope_chunk_size must be an integer between 1 and ${MAX_SCOPE_CHUNK_SIZE}`);
            }
        }
    }
    if ('review' in updates) {
        const r = updates.review;
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
            errors.push('updates.review must be an object');
        }
        else if (r.scope !== undefined && r.scope !== 'full' && r.scope !== 'changed-only') {
            errors.push('updates.review.scope must be "full" or "changed-only"');
        }
    }
    if ('atomic' in updates) {
        const a = updates.atomic;
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
            errors.push('updates.atomic must be an object');
        }
        else {
            if (a.max_lines !== undefined && (typeof a.max_lines !== 'number' || !Number.isInteger(a.max_lines) || a.max_lines < 1 || a.max_lines > MAX_ATOMIC_MAX_LINES)) {
                errors.push(`updates.atomic.max_lines must be an integer between 1 and ${MAX_ATOMIC_MAX_LINES}`);
            }
            if (a.max_adjacent_methods !== undefined && (typeof a.max_adjacent_methods !== 'number' || a.max_adjacent_methods < 0 || a.max_adjacent_methods > MAX_MAX_ADJACENT_METHODS)) {
                errors.push(`updates.atomic.max_adjacent_methods must be a number between 0 and ${MAX_MAX_ADJACENT_METHODS}`);
            }
        }
    }
    if ('git' in updates) {
        const g = updates.git;
        if (!g || typeof g !== 'object' || Array.isArray(g)) {
            errors.push('updates.git must be an object');
        }
        else {
            if (g.target_branch !== undefined && typeof g.target_branch !== 'string') {
                errors.push('updates.git.target_branch must be a string');
            }
            for (const boolKey of ['use_worktree', 'push_per_round', 'auto_merge']) {
                if (g[boolKey] !== undefined && typeof g[boolKey] !== 'boolean') {
                    errors.push(`updates.git.${boolKey} must be a boolean`);
                }
            }
        }
    }
    if ('validation' in updates) {
        const v = updates.validation;
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            errors.push('updates.validation must be an object');
        }
        else {
            if ('command_whitelist' in v && v.command_whitelist !== undefined) {
                if (!Array.isArray(v.command_whitelist) || !v.command_whitelist.every((x) => typeof x === 'string')) {
                    errors.push('updates.validation.command_whitelist must be an array of strings');
                }
            }
            // `typeof [] === 'object'` let `commands: ["npm t"]` validate clean, and
            // `flattenCommands` drops every non-object entry — the allow-list would
            // read as configured while matching NOTHING. Require the real shape:
            // a mapping of module → string[] (string keys, string-array values).
            if ('commands' in v && v.commands !== undefined) {
                const c = v.commands;
                const shapeOk = typeof c === 'object' &&
                    c !== null &&
                    !Array.isArray(c) &&
                    Object.entries(c).every(([, value]) => Array.isArray(value) && value.every((x) => typeof x === 'string'));
                if (!shapeOk) {
                    errors.push('updates.validation.commands must be a mapping of module → string[] (not an array)');
                }
            }
        }
    }
    if ('observatory' in updates) {
        const o = updates.observatory;
        if (!o || typeof o !== 'object' || Array.isArray(o)) {
            errors.push('updates.observatory must be an object');
        }
        else {
            if (o.capture !== undefined && typeof o.capture !== 'boolean') {
                errors.push('updates.observatory.capture must be a boolean');
            }
            // The approval policy is the AUTHORITATIVE human-consent seam for
            // destructive iterate tools (session-hooks.ts reads it at call time).
            // Letting the model flip it to `allow` via a config write would bypass
            // the gate entirely, so model-driven approval changes are refused
            // fail-closed — the value can only be set by editing the config file
            // directly (a human action the approval seam can trust).
            if ('approval' in o) {
                errors.push('updates.observatory.approval cannot be changed through iterate_config — ' +
                    'edit iterate.config.yaml directly (the approval gate is human-controlled)');
            }
        }
    }
    if ('personalization' in updates &&
        (!updates.personalization || typeof updates.personalization !== 'object' || Array.isArray(updates.personalization))) {
        errors.push('updates.personalization must be an object');
    }
    if ('onboarding' in updates &&
        (!updates.onboarding || typeof updates.onboarding !== 'object' || Array.isArray(updates.onboarding))) {
        errors.push('updates.onboarding must be an object');
    }
    return errors;
}
/** Recursively merge `updates` over `base` (arrays replaced wholesale). */
export function applyConfigUpdates(base, updates) {
    const out = { ...base };
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined)
            continue;
        // Prototype-pollution guard (mirrors config-loader.mergeConfig): a
        // caller-supplied `__proto__`/`constructor`/`prototype` key must never be
        // plain-assigned — on a plain object `out['__proto__'] = value` would set
        // the object's prototype instead of an own property.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
            continue;
        const baseValue = out[key];
        if (baseValue &&
            typeof baseValue === 'object' &&
            !Array.isArray(baseValue) &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value)) {
            out[key] = applyConfigUpdates(baseValue, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Read the raw config object from disk (empty object when missing).
 * Throws when the file exists but cannot be parsed as a YAML mapping
 * (never overwrite a malformed config).
 */
export function readRawConfig(configPath) {
    if (!existsSync(configPath))
        return {};
    const content = readFileSync(configPath, 'utf-8');
    let parsed;
    try {
        parsed = yaml.load(content);
    }
    catch {
        throw new Error('existing iterate.config.yaml is not a valid YAML mapping');
    }
    // A YAML sequence root (array) must not masquerade as a config object —
    // `typeof [] === 'object'`, so the presence check alone would accept a
    // config file that is actually a list. Writing over it would destroy data.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('existing iterate.config.yaml is not a valid YAML mapping');
    }
    return parsed;
}
/**
 * Write a config object to disk with backup + rollback.
 * Returns `{ ok: true, backupPath }` or `{ ok: false, error }`.
 */
export function writeConfigFile(projectRoot, config) {
    const configPath = join(projectRoot, CONFIG_FILE);
    const hadFile = existsSync(configPath);
    const backupPath = hadFile ? `${configPath}.bak-${configBackupSuffix()}` : null;
    if (backupPath) {
        try {
            copyFileSync(configPath, backupPath);
        }
        catch (err) {
            return { ok: false, error: `failed to create backup: ${String(err)}` };
        }
    }
    try {
        writeTextAtomic(configPath, yaml.dump(config, { noRefs: true }));
    }
    catch (err) {
        let rollbackError = '';
        try {
            if (backupPath)
                copyFileSync(backupPath, configPath);
            else if (existsSync(configPath))
                rmSync(configPath, { force: true });
        }
        catch (rbErr) {
            rollbackError = `; rollback also failed: ${String(rbErr)}`;
        }
        return { ok: false, error: `failed to write config: ${String(err)}${rollbackError}` };
    }
    // Success: bound the accumulation of timestamped backups so a long-lived
    // project never collects an unbounded pile of config snapshots.
    if (backupPath)
        pruneOldConfigBackups(configPath);
    return { ok: true, backupPath };
}
