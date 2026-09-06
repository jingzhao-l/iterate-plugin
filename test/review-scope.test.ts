import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COVERAGE_TARGET,
  DEFAULT_SCOPE_CHUNK_SIZE,
  chunkFiles,
  collectScopeFiles,
  computeCoverage,
  coverageToDict,
} from '../src/review-scope.ts'

describe('chunkFiles', () => {
  it('yields no chunks for empty input', () => {
    assert.deepEqual(chunkFiles([]), [])
  })

  it('returns a single batch under the chunk size', () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/a${i}.py`)
    const chunks = chunkFiles(files, 10)
    assert.equal(chunks.length, 1)
    assert.deepEqual(chunks[0], [...files].sort())
  })

  it('splits at the exact chunk size', () => {
    const files = Array.from({ length: 6 }, (_, i) => `f${i}.py`)
    const chunks = chunkFiles(files, 3)
    assert.deepEqual(chunks, [
      ['f0.py', 'f1.py', 'f2.py'],
      ['f3.py', 'f4.py', 'f5.py'],
    ])
  })

  it('keeps directory runs together', () => {
    const files = ['src/x.py', 'src/y.py', 'tests/x_test.py', 'tests/y_test.py']
    const chunks = chunkFiles(files, 2)
    assert.deepEqual(chunks, [
      ['src/x.py', 'src/y.py'],
      ['tests/x_test.py', 'tests/y_test.py'],
    ])
  })

  it('returns the last partial chunk', () => {
    const chunks = chunkFiles(Array.from({ length: 5 }, (_, i) => `f${i}.py`), 3)
    assert.equal(chunks.length, 2)
    assert.deepEqual(chunks[1], ['f3.py', 'f4.py'])
  })

  it('uses the default chunk size when omitted', () => {
    const files = Array.from({ length: DEFAULT_SCOPE_CHUNK_SIZE + 1 }, (_, i) => `f${i}.py`)
    const chunks = chunkFiles(files)
    assert.equal(chunks.length, 2)
  })

  it('falls back to the default chunk size for non-positive values', () => {
    const files = Array.from({ length: DEFAULT_SCOPE_CHUNK_SIZE + 1 }, (_, i) => `f${i}.py`)
    for (const bad of [0, -1, undefined]) {
      const chunks = chunkFiles(files, bad)
      assert.equal(chunks.length, 2)
    }
  })
})

describe('computeCoverage', () => {
  it('treats an empty assigned set as fully covered', () => {
    const out = computeCoverage([], null)
    assert.equal(out.ratio, 1)
    assert.deepEqual(out.uncovered, [])
  })

  it('is fully covered when every assigned file is read', () => {
    const assigned = ['src/a.py', 'src/b.py']
    const out = computeCoverage(assigned, assigned)
    assert.equal(out.ratio, 1)
    assert.deepEqual(out.covered, assigned)
    assert.deepEqual(out.uncovered, [])
  })

  it('lists uncovered files on partial coverage', () => {
    const assigned = ['src/a.py', 'src/b.py', 'src/c.py']
    const out = computeCoverage(assigned, ['src/a.py'])
    assert.deepEqual(out.covered, ['src/a.py'])
    assert.deepEqual(out.uncovered, ['src/b.py', 'src/c.py'])
    assert.equal(out.ratio, Math.round((1 / 3) * 1000) / 1000)
  })

  it('normalizes slashes and dot-segments when matching paths', () => {
    const assigned = ['src/sub/file.py']
    const out = computeCoverage(assigned, ['./src/./sub/../sub/file.py'])
    assert.equal(out.ratio, 1)
    assert.deepEqual(out.uncovered, [])
  })

  it('covers nothing when no read files are supplied', () => {
    const assigned = ['src/a.py', 'src/b.py']
    const out = computeCoverage(assigned, null)
    assert.equal(out.ratio, 0)
    assert.deepEqual(out.uncovered, assigned)
  })

  it('ignores non-string read entries', () => {
    const out = computeCoverage(
      ['src/a.py'],
      ['src/a.py', undefined, 42] as unknown as string[],
    )
    assert.equal(out.ratio, 1)
  })

  it('serializes the met flag via coverageToDict', () => {
    const out = computeCoverage(['src/a.py'], ['src/a.py'])
    const d = coverageToDict(out)
    assert.equal(d.ratio, 1)
    assert.equal(d.met, d.ratio >= COVERAGE_TARGET)
    assert.equal(d.met, true)
  })
})

describe('collectScopeFiles', () => {
  function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'iterate-scope-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.py'), 'x')
    writeFileSync(join(root, 'src', 'b.ts'), 'x')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'bundle.js'), 'x')
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x')
    writeFileSync(join(root, 'README.md'), 'x')
    writeFileSync(join(root, 'root.ts'), 'x')
    mkdirSync(join(root, 'src', 'nested'))
    writeFileSync(join(root, 'src', 'nested', 'c.go'), 'x')
    return root
  }

  it('includes source files and excludes ignored dirs on a full walk', () => {
    const root = makeTree()
    const files = collectScopeFiles(root, { scope: 'full' })
    assert.deepEqual(files, ['root.ts', 'src/a.py', 'src/b.ts', 'src/nested/c.go'])
  })

  it('normalizes and sorts a changed-only delta', () => {
    const root = makeTree()
    const files = collectScopeFiles(root, {
      scope: 'changed-only',
      changedFiles: ['src/z.py', 'src/a.ts', 'NOPE.md', '../escape.py', ''],
    })
    assert.deepEqual(files, ['src/a.ts', 'src/z.py'])
  })

  it('returns nothing when a changed-only scope has no files', () => {
    const root = makeTree()
    assert.deepEqual(collectScopeFiles(root, { scope: 'changed-only' }), [])
  })
})