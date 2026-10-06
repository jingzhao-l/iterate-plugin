/**
 * src/file-lock.ts — generic cross-process advisory lock for `.iterate/` state.
 *
 * Several plugin writers mutate small JSON/JSONL state files with a
 * read-modify-write cycle (fix registry, decision log, defense events,
 * experience bank). `writeJsonAtomic` only makes a SINGLE write atomic — two
 * plugin processes racing on the same project can still lose an update between
 * their read and their write. The decision log already guards itself with a
 * purpose-built mutex (see `tools/decision-log.ts`); this module generalizes
 * that exact pattern so every other writer can serialize the same way.
 *
 * Semantics (identical to the decision-log lock, deliberately):
 *   - exclusive create (`openSync(..., 'wx')`) with the holder pid stamped in;
 *   - a lock whose owner process is gone, or whose mtime is ancient, is
 *     stolen (unlink + retry);
 *   - bounded wait — on timeout the lock degrades to "proceed unlocked"
 *     (returns a callable no-op release) instead of wedging the tool call;
 *   - the returned release is always callable, idempotent, and never throws.
 *
 * Best-effort by design: an advisory lock that cannot be taken must never turn
 * a working tool into a failed one; the worst case is the pre-existing
 * (unlocked) behavior.
 *
 * In-process callers get synchronous mutual exclusion through the same API —
 * tools run on one thread, so acquiring twice in one process would self-deadlock;
 * `withProjectLock` is therefore NOT reentrant and must not be nested for the
 * same (projectRoot, name).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

const LOCK_DIR = '.iterate'
const DEFAULT_WAIT_MS = 5000
const DEFAULT_STALE_MS = 10000
const POLL_MS = 25

/** Tunables for tests (short waits) and callers wanting a different budget. */
export interface LockOptions {
  /** Max time to wait for a live holder before proceeding unlocked. */
  waitMs?: number
  /** Age after which an existing lock file is considered abandoned. */
  staleMs?: number
}

/** True when a pid refers to a live process (or we lack permission to tell). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Synchronous sleep (Atomics.wait is a reliable sleep in Node). */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

/**
 * Validate a lock name into a safe file-name fragment.
 * Throws on anything that could escape `.iterate/` (path separators, dots).
 */
function lockFileName(name: string): string {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`invalid lock name: ${JSON.stringify(name)}`)
  }
  return `.${name}.lock`
}

/**
 * Acquire an advisory lock named `name` inside `<projectRoot>/.iterate/`.
 *
 * Returns a release function: always callable, idempotent, never throws.
 * A no-op (but callable) release is returned when the lock directory cannot be
 * created or the wait times out — callers then proceed unlocked, which is the
 * historical best-effort behavior, rather than failing the operation.
 */
export function acquireProjectLock(
  projectRoot: string,
  name: string,
  options: LockOptions = {},
): () => void {
  const waitMs = Number.isFinite(options.waitMs) && (options.waitMs ?? 0) >= 0
    ? (options.waitMs as number)
    : DEFAULT_WAIT_MS
  const staleMs = Number.isFinite(options.staleMs) && (options.staleMs ?? 0) >= 0
    ? (options.staleMs as number)
    : DEFAULT_STALE_MS

  const dir = join(projectRoot, LOCK_DIR)
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return () => {}
    }
  }
  const lockPath = join(dir, lockFileName(name))
  const start = Date.now()
  for (;;) {
    let fd: number | null = null
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {}
      // Lock exists — steal it when the owner is gone or the lock is ancient.
      let stale = false
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) stale = true
        else {
          const pid = Number(readFileSync(lockPath, 'utf-8'))
          if (!processAlive(pid)) stale = true
        }
      } catch {
        stale = true // unreadable/vanishing lock → retry as stale
      }
      if (stale) {
        try {
          unlinkSync(lockPath)
        } catch {
          // another holder stole it first — retry immediately
        }
        continue
      }
      if (Date.now() - start > waitMs) return () => {}
      sleepSync(POLL_MS)
      continue
    }
    // Owned the lock: stamp the holder pid, then release once on return.
    try {
      writeSync(fd, String(process.pid))
    } catch {
      // pid stamp is advisory
    }
    try {
      closeSync(fd)
    } catch {
      // best-effort
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        unlinkSync(lockPath)
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Run `fn` while holding the advisory lock named `name`.
 * The release is guaranteed via `finally`; `fn`'s value or error propagates
 * unchanged. Not reentrant for the same (projectRoot, name) — see header.
 */
export function withProjectLock<T>(
  projectRoot: string,
  name: string,
  fn: () => T,
  options: LockOptions = {},
): T {
  const release = acquireProjectLock(projectRoot, name, options)
  try {
    return fn()
  } finally {
    release()
  }
}
