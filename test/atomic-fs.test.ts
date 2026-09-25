import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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