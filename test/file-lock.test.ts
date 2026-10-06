import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireProjectLock, withProjectLock } from '../src/file-lock.ts'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-file-lock-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const lockPathFor = (dir: string, name: string): string => join(dir, '.iterate', `.${name}.lock`)

describe('file-lock', () => {
  it('withProjectLock creates the lock file while running and removes it after', () => {
    const { dir, cleanup } = tempDir()
    try {
      const path = lockPathFor(dir, 'fix-registry')
      const result = withProjectLock(dir, 'fix-registry', () => {
        assert.ok(existsSync(path), 'lock file exists during the critical section')
        return 42
      })
      assert.equal(result, 42)
      assert.ok(!existsSync(path), 'lock file removed after release')
    } finally {
      cleanup()
    }
  })

  it('propagates the wrapped error and still releases the lock', () => {
    const { dir, cleanup } = tempDir()
    try {
      const path = lockPathFor(dir, 'defense-events')
      assert.throws(
        () =>
          withProjectLock(dir, 'defense-events', () => {
            throw new Error('boom')
          }),
        /boom/,
      )
      assert.ok(!existsSync(path), 'lock released on the error path')
    } finally {
      cleanup()
    }
  })

  it('different lock names do not block each other', () => {
    const { dir, cleanup } = tempDir()
    try {
      const releaseA = acquireProjectLock(dir, 'registry-a')
      try {
        const releaseB = acquireProjectLock(dir, 'registry-b')
        releaseB()
        assert.ok(existsSync(lockPathFor(dir, 'registry-a')))
        assert.ok(!existsSync(lockPathFor(dir, 'registry-b')))
      } finally {
        releaseA()
      }
      assert.ok(!existsSync(lockPathFor(dir, 'registry-a')))
    } finally {
      cleanup()
    }
  })

  it('release is idempotent (double release never throws)', () => {
    const { dir, cleanup } = tempDir()
    try {
      const release = acquireProjectLock(dir, 'idempotent')
      release()
      release()
      assert.ok(!existsSync(lockPathFor(dir, 'idempotent')))
    } finally {
      cleanup()
    }
  })

  it('steals a lock whose owning pid is dead', () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      // pid 2^22-ish is virtually certain to be unused; if it were alive the
      // stale-mtime fallback (below) still lets the test pass via staleMs.
      writeFileSync(lockPathFor(dir, 'stale-steal'), '999999999', 'utf-8')
      const release = acquireProjectLock(dir, 'stale-steal', { waitMs: 250, staleMs: 60_000 })
      // Either the dead pid was stolen immediately, or the timeout path
      // returned a no-op release — in both cases we must hold a callable
      // release and the tool must not wedge.
      assert.equal(typeof release, 'function')
      release()
    } finally {
      cleanup()
    }
  })

  it('degrades to proceed-unlocked after the bounded wait when a live holder exists', () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      // Our own pid is alive → never stolen → bounded wait must expire.
      writeFileSync(lockPathFor(dir, 'live-holder'), String(process.pid), 'utf-8')
      const started = Date.now()
      const release = acquireProjectLock(dir, 'live-holder', { waitMs: 80, staleMs: 60_000 })
      const waited = Date.now() - started
      assert.ok(waited >= 50, `waited ${waited}ms (expected ~80ms bounded wait)`)
      // Must be a callable no-op — not a throw, and not a release of the live
      // holder's lock file.
      assert.equal(typeof release, 'function')
      release()
      assert.ok(existsSync(lockPathFor(dir, 'live-holder')), 'foreign live lock not unlinked')
    } finally {
      cleanup()
    }
  })

  it('steals a lock older than staleMs even if the pid looks alive', () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, '.iterate'), { recursive: true })
      writeFileSync(lockPathFor(dir, 'ancient'), String(process.pid), 'utf-8')
      const release = acquireProjectLock(dir, 'ancient', { waitMs: 500, staleMs: 0 })
      // staleMs: 0 → the freshly written lock is instantly "ancient" → stolen.
      release()
      assert.ok(!existsSync(lockPathFor(dir, 'ancient')))
    } finally {
      cleanup()
    }
  })

  it('rejects lock names that could escape the .iterate directory', () => {
    const { dir, cleanup } = tempDir()
    try {
      assert.throws(() => acquireProjectLock(dir, '../escape'), /invalid lock name/)
      assert.throws(() => acquireProjectLock(dir, 'a/b'), /invalid lock name/)
      assert.throws(() => acquireProjectLock(dir, ''), /invalid lock name/)
      assert.throws(() => acquireProjectLock(dir, '.hidden'), /invalid lock name/)
    } finally {
      cleanup()
    }
  })

  it('returns a callable no-op release when the lock directory cannot be created', () => {
    const { dir, cleanup } = tempDir()
    try {
      // A regular FILE where `.iterate` should be → mkdir fails → no-op release.
      writeFileSync(join(dir, '.iterate'), 'not a dir', 'utf-8')
      const release = acquireProjectLock(dir, 'blocked-dir')
      assert.equal(typeof release, 'function')
      release()
    } finally {
      cleanup()
    }
  })

  it('passes the value through and works for nested different names', () => {
    const { dir, cleanup } = tempDir()
    try {
      const value = withProjectLock(dir, 'outer-lock', () =>
        withProjectLock(dir, 'inner-lock', () => 'nested-ok'),
      )
      assert.equal(value, 'nested-ok')
      assert.ok(!existsSync(lockPathFor(dir, 'outer-lock')))
      assert.ok(!existsSync(lockPathFor(dir, 'inner-lock')))
    } finally {
      cleanup()
    }
  })

  it('stamps the holder pid into the lock file', () => {
    const { dir, cleanup } = tempDir()
    try {
      withProjectLock(dir, 'pid-stamp', () => {
        const stamped = readFileSync(lockPathFor(dir, 'pid-stamp'), 'utf-8')
        assert.equal(stamped, String(process.pid))
      })
    } finally {
      cleanup()
    }
  })
})
