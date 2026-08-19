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
 * Parse `git diff --name-only` stdout into a list of relative paths.
 * Pure: strips blank lines, trims whitespace, drops quotes (git can quote
 * paths with special characters).
 */
export function parseChangedFiles(stdout) {
    return stdout
        .split('\n')
        .map((line) => line.trim().replace(/^"|"$/g, ''))
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
    const { ok, stdout, stderr } = await runGit(['diff', '--name-only', targetBranch, '--'], root);
    if (!ok) {
        const reason = stderr.trim() || `git diff --name-only ${targetBranch} failed`;
        return { scope: 'full', changedFiles: [], fallbackToFull: true, error: reason };
    }
    const existing = filterExistingFiles(root, parseChangedFiles(stdout));
    const decided = decideScope(existing);
    return { scope: decided.scope, changedFiles: existing, fallbackToFull: decided.fallbackToFull };
}
