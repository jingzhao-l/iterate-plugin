/**
 * src/atomic-fs.ts — crash-safe file writes for all plugin state.
 *
 * Every JSON/YAML artifact the plugin persists (.iterate/*.json,
 * iterate.config.yaml) is written through here: content goes to a
 * uniquely-named temp file in the SAME directory as the target (rename is
 * only atomic within one filesystem), then is `renameSync`ed over the
 * destination. A crash mid-write can therefore leave a stale temp file
 * behind, but never a truncated / half-written state file — readers
 * (which all tolerate missing/corrupt files) see either the previous or
 * the new content, never a mixture.
 */

import { dirname, join } from 'node:path'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'

/** Best-effort unlink of a leftover temp file (never throws). */
function cleanupTemp(tmp: string): void {
  try {
    rmSync(tmp, { force: true })
  } catch {
    /* ignore — temp files follow the prunable `.tmp-<pid>-<rand>` convention */
  }
}

/** Best-effort async unlink of a leftover temp file (never throws). */
async function cleanupTempAsync(tmp: string): Promise<void> {
  try {
    await rm(tmp, { force: true })
  } catch {
    /* ignore — temp files follow the prunable `.tmp-<pid>-<rand>` convention */
  }
}

/**
 * Unique temp file path for `filePath`, in the same directory, following the
 * prunable `.<basename>.tmp-<pid>-<random>` convention (see prune.ts
 * `isPrunableTemp`). The pid+random suffix makes concurrent writers safe.
 */
function tempPathFor(filePath: string): string {
  return join(
    dirname(filePath),
    `.${filePath.split('/').pop() ?? 'file'}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )
}

/**
 * Write `data` to `filePath` atomically (temp file + rename, same dir).
 * Temp files follow the `<name>.tmp-<pid>-<random>` convention also used by
 * prune.ts / checkpoint.ts so they are recognizable and prunable.
 * Throws on failure (callers own error reporting — they map failures to
 * structured tool results).
 */
export function writeTextAtomic(filePath: string, data: string): void {
  const tmp = tempPathFor(filePath)
  writeFileSync(tmp, data, 'utf-8')
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    // Best-effort temp cleanup so a failed write never litters the directory.
    cleanupTemp(tmp)
    throw err
  }
}

/** Async variant of {@link writeTextAtomic} (same temp naming convention). */
export async function writeTextAtomicAsync(filePath: string, data: string): Promise<void> {
  const tmp = tempPathFor(filePath)
  await writeFile(tmp, data, 'utf-8')
  try {
    await rename(tmp, filePath)
  } catch (err) {
    // Best-effort temp cleanup so a failed write never litters the directory.
    await cleanupTempAsync(tmp)
    throw err
  }
}

/** JSON.stringify (2-space indent) + atomic write in one call. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, JSON.stringify(value, null, 2))
}
