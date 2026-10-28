/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root, explicit extra directories, and platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { SandboxExecutionPolicy } from './index.ts';
/** An explicit directory grant cannot be enforced without changing the caller's selected path. */
export declare class SandboxInvalidRootError extends HarnessError {
    constructor(path: string, detail: string);
}
/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export declare function canonicalPath(path: string): string;
/**
 * The workspace-owned writable roots — the policy's workspace root plus its
 * explicit extra directories, as a canonical, deduplicated allow-list. Both
 * the workspace and every extra root must be granted together by every
 * backend; this is the one derivation of that set, kept separate from the
 * platform temp policy each backend documents for itself (Seatbelt and the fs
 * fence use {@link writableRoots}; bwrap and Landlock add their own temp
 * grants).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical workspace-owned roots; empty under `read-only`.
 * @throws {SandboxInvalidRootError} An extra root is missing, is not a directory, or uses a symlink.
 */
export declare function workspaceWritableRoots(policy: SandboxExecutionPolicy): string[];
/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, its explicit extra
 * directories, the host `/tmp`, and the per-user platform temp dir
 * (`os.tmpdir()` — the real temp area for mkstemp-family tools; omitting it
 * would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export declare function writableRoots(policy: SandboxExecutionPolicy): string[];
//# sourceMappingURL=roots.d.ts.map