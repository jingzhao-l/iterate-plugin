import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { writeTextAtomic, writeTextAtomicAsync } from '../src/atomic-fs.ts'

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