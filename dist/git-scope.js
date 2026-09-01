/**
 * src/git-scope.ts — resolve the `changed-only` review scope for the iterate
 * workflow.
 *
 * When `iterate.config.yaml` sets `review.scope: changed-only`, reviewers must
 * only examine files that changed against `git.target_branch`. This module
 * resolves that file set deterministically:
 *
 *   1. run `git diff --name-only <target_branch> --` in the project root
 *      (working-tree diff vs the target branch — captures both staged and
 *      unstaged changes, which is what an iterate round produces);
 *   2. keep only entries that resolve to an existing file under the project
 *      root (path-traversal-safe — a hostile diff line must never leak a path
 *      outside the root);
 *   3. when the configured scope is `changed-only` but ZERO files changed, the
 *      plan auto-falls back to `full` (mirrors SKILL.md: "无改动文件时自动
 *      fallback 为 full").
 *
 * The pure math (`parseChangedFiles`, `filterExistingFiles`, `decideScope`) is
 * separated from the process call (`runGit`) so it is unit-testable without a
 * git repo.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Parse `git diff --name-only -z` stdout into a list of relative paths.
 * Pure. NUL-delimited mode is machine-safe (handles any filename); when no
 * NUL is present (callers that did not pass -z) fall back to newline-split
 * with C-style quote/escape unescaping for core.quotePath output.
 */
/**
 * Decode the quoted body of a git core.quotePath output line into the real
 * filename bytes, then interpret them as UTF-8.
 *
 * Single-pass and escape-atomic: each `\` consumes exactly one escape (\" \\
 * \t \n or a 3-digit octal for a raw byte), so a literal `\\303` in a filename
 * (escaped backslash + literal "303") is decoded as the byte `\` followed by
 * ASCII "303" rather than as the single byte 0xC3. Ordinary characters in the
 * quoted body are ASCII (git always octal-escapes non-ASCII bytes), so they map
 * 1:1 to bytes.
 */
function decodeQuotedPath(content) {
    const bytes = [];
    let i = 0;
    while (i < content.length) {
        const ch = content[i];
        if (ch !== '\\') {
            bytes.push(ch.charCodeAt(0));
            i++;
            continue;
        }
        const next = content[i + 1];
        if (next === '"') {
            bytes.push(0x22);
            i += 2;
        }
        else if (next === '\\') {
            bytes.push(0x5c);
            i += 2;
        }
        else if (next === 't') {
            bytes.push(0x09);
            i += 2;
        }
        else if (next === 'n') {
            bytes.push(0x0a);
            i += 2;
        }
        else if (next !== undefined && next >= '0' && next <= '7') {
            const oct = content.slice(i + 1, i + 4);
            if (oct.length === 3 && /^[0-7]{3}$/.test(oct)) {
                bytes.push(parseInt(oct, 8));
                i += 4;
            }
            else {
                // Malformed octal — keep the backslash literally.
                bytes.push(0x5c);
                i++;
            }
        }
        else {
            // Unknown escape — keep the backslash literally.
            bytes.push(0x5c);
            i++;
        }
    }
    return Buffer.from(bytes).toString('utf-8');
}
export function parseChangedFiles(stdout) {
    if (stdout.includes('\0')) {
        return stdout.split('\0').map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return stdout
        .split('\n')
        .map((line) => {
        const trimmed = line.trim();
        // git core.quotePath wraps paths with special characters in "..."; the
        // content uses C-style escapes (\" \\ \t \n) and \ooo octal escapes for
        // non-ASCII bytes (which are raw UTF-8 BYTES, not Latin-1 code points).
        const quoted = trimmed.match(/^"(.*)"$/);
        if (!quoted)
            return trimmed;
        return decodeQuotedPath(quoted[1]);
    })
        .filter((line) => line.length > 0);
}
/**
 * Keep only entries that resolve to an existing regular file under `root`.
 * Traversal-safe: rejects absolute paths and any relative path that would
 * escape `root` via `..` (resolved against the root before stat).
 */
export function filterExistingFiles(root, files) {
    const out = [];
    for (const rel of files) {
        if (rel.startsWith('/') || rel.includes('\0'))
            continue;
        const candidate = join(root, rel);
        if (!candidate.startsWith(root + '/') && candidate !== root)
            continue;
        try {
            if (existsSync(candidate) && statSync(candidate).isFile())
                out.push(rel);
        }
        catch {
            // Unreadable entry (e.g. a broken symlink) is not a valid review target.
            continue;
        }
    }
    return out;
}
/**
 * Decide the effective scope from the changed-file set.
 * changed-only + zero files → fall back to full (SKILL.md auto-fallback).
 * Pure and deterministic.
 */
export function decideScope(changedFiles) {
    const hasChanges = changedFiles.length > 0;
    return {
        scope: hasChanges ? 'changed-only' : 'full',
        fallbackToFull: !hasChanges,
    };
}
/**
 * Run a git command in `cwd` and return stdout/stderr/exit code.
 * Uses execFile (no shell), so a model-controlled branch name can never be
 * interpreted as shell syntax.
 */
export function runGit(args, cwd) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PAGER: 'cat' } }, (error, stdout, stderr) => {
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ ok: exitCode === 0, stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
        });
    });
}
/**
 * Resolve the changed-file set for a project.
 * Any git failure (not a repo, missing target branch, etc.) degrades to a
 * `full`-scope result with `error` set — the reviewer must never crash the
 * plan because git is unavailable.
 */
export async function resolveChangedFiles(root, targetBranch) {
    // Option-injection guard: a branch name starting with '-' would be parsed by
    // git as an option (e.g. --output=...), not a ref. Reject it outright.
    if (typeof targetBranch !== 'string' || targetBranch.trim() === '' || targetBranch.startsWith('-')) {
        return {
            scope: 'full',
            changedFiles: [],
            fallbackToFull: true,
            error: `invalid target branch "${String(targetBranch)}"`,
        };
    }
    // -z: NUL-delimited names — machine-safe for any filename (spaces, quotes,
    // non-ASCII), and never confused with option-like content.
    const { ok, stdout, stderr } = await runGit(['diff', '--name-only', '-z', targetBranch, '--'], root);
    if (!ok) {
        const reason = stderr.trim() || `git diff --name-only -z ${targetBranch} failed`;
        return { scope: 'full', changedFiles: [], fallbackToFull: true, error: reason };
    }
    const existing = filterExistingFiles(root, parseChangedFiles(stdout));
    const decided = decideScope(existing);
    return { scope: decided.scope, changedFiles: existing, fallbackToFull: decided.fallbackToFull };
}
