import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COVERAGE_TARGET,
  DEFAULT_SCOPE_CHUNK_SIZE,
  WHOLE_FILE_LINE,
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

  it('does NOT fold a leading ../.. traversal into a bare filename', () => {
    const root = makeTree()
    // `../../evil.ts` must stay scoped OUT: the old normalizePath folded it
    // into the single segment `evil.ts`, which no longer starts with '..' and
    // therefore leaked into the inventory undetected.
    const files = collectScopeFiles(root, {
      scope: 'changed-only',
      changedFiles: ['src/a.ts', '../../evil.ts', 'a/../../b.ts'],
    })
    assert.deepEqual(files, ['src/a.ts'])
  })

  it('returns nothing when a changed-only scope has no files', () => {
    const root = makeTree()
    assert.deepEqual(collectScopeFiles(root, { scope: 'changed-only' }), [])
  })
})
// ─── input hardening ────────────────────────────────────────────────────────

describe('review-scope input hardening', () => {
  it('computeCoverage survives a non-array read list (no for..of throw)', () => {
    // A bare number used to throw `x is not iterable`; a bare string used to
    // iterate single characters into the read set.
    for (const bad of [42, true, {}, 'src/a.py']) {
      const out = computeCoverage(['src/a.py'], bad as unknown as string[])
      assert.equal(typeof out.ratio, 'number')
      assert.equal(out.covered.length, 0, `${JSON.stringify(bad)} matched nothing`)
      assert.equal(out.ratio, 0)
    }
    assert.equal(computeCoverage(['src/a.py'], null).ratio, 0)
  })

  it('computeCoverage survives a non-array assigned inventory', () => {
    for (const bad of [42, 'src/a.py', null, undefined]) {
      const out = computeCoverage(bad as unknown as string[], ['src/a.py'])
      assert.deepEqual(out.assigned, [])
      assert.equal(out.ratio, 1) // empty inventory is vacuously fully covered
    }
  })

  it('computeCoverage drops non-string inventory entries', () => {
    const out = computeCoverage(
      ['src/a.py', 7, null, {}] as unknown as string[],
      ['src/a.py'],
    )
    assert.deepEqual(out.assigned, ['src/a.py'])
    assert.equal(out.ratio, 1)
  })

  it('chunkFiles survives a non-array inventory', () => {
    for (const bad of [undefined, null, 42, 'a.ts']) {
      assert.deepEqual(chunkFiles(bad as unknown as string[]), [])
    }
  })

  it('chunkFiles drops non-string entries instead of throwing on rel.includes', () => {
    const chunks = chunkFiles(['a.ts', 7, null, 'b.ts'] as unknown as string[], 2)
    assert.deepEqual(chunks, [['a.ts', 'b.ts']])
  })

  it('chunkFiles floors a fractional chunk size', () => {
    // 2.5 used to produce alternating 3- and 2-member chunks.
    const files = Array.from({ length: 5 }, (_, i) => `f${i}.ts`)
    for (const bad of [2.5, 3.9]) {
      const chunks = chunkFiles(files, bad)
      for (const c of chunks) assert.ok(c.length <= Math.floor(bad), `${c.length} > floor(${bad})`)
      assert.equal(chunks.flat().length, 5, 'no file is lost')
    }
    // Non-finite sizes still fall back to the default.
    assert.equal(chunkFiles(Array.from({ length: 30 }, (_, i) => `f${i}.ts`), Infinity).length, 2)
  })

  it('collectScopeFiles tolerates a missing options object', () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-scope-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'x')
    const files = collectScopeFiles(root, undefined as unknown as { scope: 'full' })
    assert.deepEqual(files, ['src/a.ts'])
  })

  it('collectScopeFiles tolerates a non-array changedFiles list', () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-scope-'))
    const files = collectScopeFiles(root, {
      scope: 'changed-only',
      changedFiles: 'src/a.ts' as unknown as string[],
    })
    assert.deepEqual(files, [])
    assert.deepEqual(
      collectScopeFiles(root, { scope: 'changed-only', changedFiles: [7, null] as unknown as string[] }),
      [],
    )
  })
})

describe('WHOLE_FILE_LINE is shared with evidence.ts', () => {
  it('re-exports the single sentinel instead of redefining it', async () => {
    const evidence = await import('../src/evidence.ts')
    assert.equal(WHOLE_FILE_LINE, evidence.WHOLE_FILE_LINE)
    assert.equal(WHOLE_FILE_LINE, 0)
  })
})
