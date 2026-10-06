import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { writeTextAtomic, writeTextAtomicAsync, writeJsonAtomic } from '../src/atomic-fs.ts'

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-atomic-fs-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Any temp file live under `dir` (the `.tmp-<pid>-<rand>` convention). */
function tempsIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.tmp-'))
}

describe('writeTextAtomic', () => {
  it('writes then renames cleanly with no temp left behind', () => {
    const { dir, cleanup } = tempDir()
    try {
      writeTextAtomic(join(dir, 'out.json'), '{"a":1}')
      assert.deepEqual(readdirSync(dir).sort(), ['out.json'])
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('throws on a write failure and leaves no temp litter', () => {
    const { dir, cleanup } = tempDir()
    try {
      // Parent directory does not exist → the underlying write fails with
      // ENOENT; the temp (had one been created) must be removed before the
      // error propagates and no stray temp may survive either way.
      assert.throws(() => writeTextAtomic(join(dir, 'missing', 'out.json'), 'x'))
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('throws on a rename failure (target is a directory) and cleans the temp', () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, 'target-dir'))
      // The temp write succeeds, then rename onto a directory fails — the
      // leftover temp must be removed, never littered.
      assert.throws(() => writeTextAtomic(join(dir, 'target-dir'), 'x'))
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('writeTextAtomicAsync', () => {
  it('throws on a write failure and leaves no temp litter (async)', async () => {
    const { dir, cleanup } = tempDir()
    try {
      await assert.rejects(() => writeTextAtomicAsync(join(dir, 'missing', 'out.json'), 'x'))
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('throws on a rename failure and cleans the temp (async)', async () => {
    const { dir, cleanup } = tempDir()
    try {
      mkdirSync(join(dir, 'target-dir'))
      await assert.rejects(() => writeTextAtomicAsync(join(dir, 'target-dir'), 'x'))
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('writeJsonAtomic', () => {
  it('writes a parseable 2-space-indented JSON file with no temp litter', () => {
    const { dir, cleanup } = tempDir()
    try {
      const value = { a: 1, nested: { list: [null, true, 'x'], n: 1.5 } }
      const file = join(dir, 'state.json')
      writeJsonAtomic(file, value)
      const raw = readFileSync(file, 'utf-8')
      assert.deepEqual(JSON.parse(raw), value)
      assert.ok(raw.includes('\n  "a": 1'), 'expected 2-space indentation, got: ' + raw)
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('overwrites an existing file atomically (previous content never survives)', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'state.json')
      writeJsonAtomic(file, { v: 'old' })
      writeJsonAtomic(file, { v: 'new', n: 42 })
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { v: string; n: number }
      assert.equal(parsed.v, 'new')
      assert.equal(parsed.n, 42)
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('mode preservation across the rename swap', () => {
  it('keeps an executable (0755) target executable', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'run.sh')
      writeFileSync(file, '#!/bin/sh\n')
      chmodSync(file, 0o755)
      writeTextAtomic(file, '#!/bin/sh\necho hi\n')
      // rename REPLACES the inode — without pinning the temp's mode the new
      // inode would be created with the umask default (0644), silently
      // stripping the executable bit from a real source file.
      assert.equal(statSync(file).mode & 0o777, 0o755)
      assert.equal(readFileSync(file, 'utf-8'), '#!/bin/sh\necho hi\n')
    } finally {
      cleanup()
    }
  })

  it('keeps a secret (0600) target private — never widens to the umask default', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'secret.key')
      writeFileSync(file, 'old-secret')
      chmodSync(file, 0o600)
      writeTextAtomic(file, 'new-secret')
      // Permission WIDENING (0600 → 0644) would leak the secret's content to
      // every local user; the rewrite must preserve 0600 exactly.
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(readFileSync(file, 'utf-8'), 'new-secret')
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('creates a brand-new file with the plain default mode (0o666 & ~umask)', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'fresh.json')
      writeTextAtomic(file, '{}')
      // No existing target → no mode to inherit; the file must behave like a
      // plain writeFileSync (umask applies), not like a chmod'd artifact.
      assert.equal(statSync(file).mode & 0o777, 0o666 & ~process.umask())
    } finally {
      cleanup()
    }
  })

  it('preserves the mode in the async variant too', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'secret.key')
      writeFileSync(file, 'old')
      chmodSync(file, 0o600)
      await writeTextAtomicAsync(file, 'new')
      assert.equal(statSync(file).mode & 0o777, 0o600)
      const exe = join(dir, 'run.sh')
      writeFileSync(exe, 'x')
      chmodSync(exe, 0o755)
      await writeTextAtomicAsync(exe, 'y')
      assert.equal(statSync(exe).mode & 0o777, 0o755)
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('symlinked targets', () => {
  it('replaces the REAL file through a symlink and keeps the link a link', () => {
    const { dir, cleanup } = tempDir()
    try {
      const real = join(dir, 'real.ts')
      const link = join(dir, 'link.ts')
      writeFileSync(real, 'original')
      symlinkSync(real, link)
      writeTextAtomic(link, 'patched')
      // The link must survive (rename would swap it for a regular file) …
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readlinkSync(link), real)
      // … and the fix must actually reach the linked-to file.
      assert.equal(readFileSync(real, 'utf-8'), 'patched')
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('follows a relative symlink to its target', () => {
    const { dir, cleanup } = tempDir()
    try {
      const real = join(dir, 'real.ts')
      const link = join(dir, 'rel.ts')
      writeFileSync(real, 'a')
      symlinkSync('real.ts', link)
      writeTextAtomic(link, 'b')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readFileSync(real, 'utf-8'), 'b')
    } finally {
      cleanup()
    }
  })

  it('falls back to writing the path itself when the link cannot be resolved (dangling)', () => {
    const { dir, cleanup } = tempDir()
    try {
      const link = join(dir, 'dangling.ts')
      symlinkSync(join(dir, 'never-existed.ts'), link)
      // realpath fails on a dangling link → documented fallback: write the
      // path itself (the link is replaced by a regular file), never throw.
      writeTextAtomic(link, 'content')
      assert.equal(lstatSync(link).isSymbolicLink(), false)
      assert.equal(readFileSync(link, 'utf-8'), 'content')
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('resolves symlinks in the async variant as well', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const real = join(dir, 'real.ts')
      const link = join(dir, 'link.ts')
      writeFileSync(real, 'original')
      symlinkSync(real, link)
      await writeTextAtomicAsync(link, 'patched')
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readFileSync(real, 'utf-8'), 'patched')
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('fsync path (functional equivalence)', () => {
  it('sync: data lands byte-for-byte after write → fsync → rename', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'durable.json')
      const payload = JSON.stringify({ lines: Array.from({ length: 500 }, (_, i) => `line ${i} end`) })
      writeTextAtomic(file, payload)
      assert.equal(readFileSync(file, 'utf-8'), payload)
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })

  it('async: data lands byte-for-byte after write → fsync → rename', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'durable.json')
      const payload = JSON.stringify({ lines: Array.from({ length: 500 }, (_, i) => `line ${i} end`) })
      await writeTextAtomicAsync(file, payload)
      assert.equal(readFileSync(file, 'utf-8'), payload)
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})

describe('temp naming', () => {
  it('builds the temp name from the basename of a nested path', () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'sub.json')
      writeTextAtomic(file, '{"a":1}')
      assert.deepEqual(readdirSync(dir), ['sub.json'])
      // A trailing-separator input is where `basename()` and a hand-rolled
      // `split('/').pop()` diverge: it must still fail cleanly (the rename
      // target names a file as a directory) without littering a misnamed temp.
      assert.throws(() => writeTextAtomic(join(dir, 'sub.json') + '/', 'x'))
      assert.deepEqual(tempsIn(dir), [])
    } finally {
      cleanup()
    }
  })
})