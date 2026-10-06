/**
 * src/atomic-fs.ts — crash-safe file writes for all plugin state.
 *
 * Every JSON/YAML artifact the plugin persists (.iterate/*.json,
 * iterate.config.yaml) is written through here: content goes to a
 * uniquely-named temp file in the SAME directory as the target (rename is
 * only atomic within one filesystem), is fsynced to plating, then is
 * `renameSync`ed over the destination, followed by a best-effort directory
 * fsync so the rename itself is durable. A crash mid-write can therefore
 * leave a stale temp file behind, but never a truncated / half-written state
 * file — readers (which all tolerate missing/corrupt files) see either the
 * previous or the new content, never a mixture.
 *
 * Two properties travel with the rename (which REPLACES the target inode):
 *   - permissions: the temp is given the existing target's mode before the
 *     swap, so rewriting a 0755 script stays 0755 and a 0600 secret never
 *     widens to the umask default (0644).
 *   - symlinks: when the target is a symlink, the atomic replace runs on the
 *     link's REAL target instead — a fix written through a linked source file
 *     must reach the real file, and the link must survive as a link.
 */
import { basename, dirname, join } from 'node:path';
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeSync, } from 'node:fs';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
/** Best-effort unlink of a leftover temp file (never throws). */
function cleanupTemp(tmp) {
    try {
        rmSync(tmp, { force: true });
    }
    catch {
        /* ignore — temp files follow the prunable `.tmp-<pid>-<rand>` convention */
    }
}
/** Best-effort async unlink of a leftover temp file (never throws). */
async function cleanupTempAsync(tmp) {
    try {
        await rm(tmp, { force: true });
    }
    catch {
        /* ignore — temp files follow the prunable `.tmp-<pid>-<rand>` convention */
    }
}
/**
 * Unique temp file path for `filePath`, in the same directory, following the
 * prunable `.<basename>.tmp-<pid>-<random>` convention (see prune.ts
 * `isPrunableTemp`). The pid+random suffix makes concurrent writers safe.
 * `basename` from node:path handles the platform separator (a hand-rolled
 * `split('/')` breaks on Windows paths).
 */
function tempPathFor(filePath) {
    return join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
}
/**
 * Resolve the path the atomic replace must actually run on. A symlinked
 * target is resolved to its real path: `renameSync(tmp, link)` would swap the
 * LINK for a regular file and the linked-to file would silently keep its old
 * content (a fix that never reaches the real source). When lstat/realpath
 * cannot resolve (missing target, dangling or unreadable link), fall back to
 * writing `filePath` itself — the pre-symlink-aware behavior.
 */
function resolveAtomicTarget(filePath) {
    try {
        if (lstatSync(filePath).isSymbolicLink())
            return realpathSync(filePath);
    }
    catch {
        // Missing target or unresolvable link — write `filePath` itself.
    }
    return filePath;
}
/** Async variant of {@link resolveAtomicTarget}. */
async function resolveAtomicTargetAsync(filePath) {
    try {
        if ((await lstat(filePath)).isSymbolicLink())
            return await realpath(filePath);
    }
    catch {
        // Missing target or unresolvable link — write `filePath` itself.
    }
    return filePath;
}
/**
 * The permission bits to give the temp file: the existing target's mode (so
 * the rename-over swap preserves it), or `null` for a brand-new file — then
 * the default open mode (0o666 & ~umask) applies, exactly like a plain
 * `writeFileSync` of a new file.
 */
function existingMode(target) {
    try {
        return statSync(target).mode & 0o777;
    }
    catch {
        return null;
    }
}
/** Async variant of {@link existingMode}. */
async function existingModeAsync(target) {
    try {
        return (await stat(target)).mode & 0o777;
    }
    catch {
        return null;
    }
}
/**
 * Best-effort fsync of the directory holding the final file, so the rename
 * itself survives a crash. Unsupported on some platforms/filesystems — the
 * data is already durable (fsynced on the temp), this only covers the
 * directory entry, so failure is ignored by design.
 */
function fsyncDirBestEffort(dir) {
    try {
        const fd = openSync(dir, 'r');
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        // Directory fsync is unavailable (Windows, some FUSE mounts) — durability
        // of the content does not depend on it.
    }
}
/** Async variant of {@link fsyncDirBestEffort}. */
async function fsyncDirBestEffortAsync(dir) {
    let dh;
    try {
        dh = await open(dir, 'r');
        await dh.sync();
    }
    catch {
        // Directory fsync is unavailable — see fsyncDirBestEffort.
    }
    finally {
        if (dh) {
            await dh.close().catch(() => { });
        }
    }
}
/**
 * Write `data` to `filePath` atomically (temp file + fsync + rename, same dir).
 * Temp files follow the `<name>.tmp-<pid>-<random>` convention also used by
 * prune.ts / checkpoint.ts so they are recognizable and prunable. The existing
 * target's mode is preserved across the swap and symlinked targets are
 * resolved first (see the header).
 * Throws on failure (callers own error reporting — they map failures to
 * structured tool results).
 */
export function writeTextAtomic(filePath, data) {
    const target = resolveAtomicTarget(filePath);
    const tmp = tempPathFor(target);
    const mode = existingMode(target);
    try {
        // fd-based write so the mode can be pinned and the CONTENT fsynced before
        // the rename — a crash after rename but before the data hit the disk would
        // otherwise leave a zero-length / torn state file.
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, data, null, 'utf-8');
            if (mode !== null)
                fchmodSync(fd, mode);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch (err) {
        // The write itself failed (disk full, permission, …): the temp file may
        // already be partially written, so remove it before propagating — a
        // failed write must never litter the directory either.
        cleanupTemp(tmp);
        throw err;
    }
    try {
        renameSync(tmp, target);
    }
    catch (err) {
        // Best-effort temp cleanup so a failed rename never litters the directory.
        cleanupTemp(tmp);
        throw err;
    }
    fsyncDirBestEffort(dirname(target));
}
/** Async variant of {@link writeTextAtomic} (same temp naming convention). */
export async function writeTextAtomicAsync(filePath, data) {
    const target = await resolveAtomicTargetAsync(filePath);
    const tmp = tempPathFor(target);
    const mode = await existingModeAsync(target);
    try {
        // fd-based write: pin the target's mode and fsync the content before the
        // rename (mirrors the sync variant — see writeTextAtomic).
        const fh = await open(tmp, 'w');
        try {
            await fh.writeFile(data, 'utf-8');
            if (mode !== null)
                await fh.chmod(mode);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
    }
    catch (err) {
        // The write itself failed (disk full, permission, …): the temp file may
        // already be partially written, so remove it before propagating — a
        // failed write must never litter the directory either.
        await cleanupTempAsync(tmp);
        throw err;
    }
    try {
        await rename(tmp, target);
    }
    catch (err) {
        // Best-effort temp cleanup so a failed rename never litters the directory.
        await cleanupTempAsync(tmp);
        throw err;
    }
    await fsyncDirBestEffortAsync(dirname(target));
}
/** JSON.stringify (2-space indent) + atomic write in one call. */
export function writeJsonAtomic(filePath, value) {
    writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}
