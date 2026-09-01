import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseChangedFiles,
  filterExistingFiles,
  decideScope,
  resolveChangedFiles,
} from '../src/git-scope.ts'

describe('parseChangedFiles', () => {
  it('returns an empty list for empty stdout', () => {
    assert.deepEqual(parseChangedFiles(''), [])
  })

  it('splits NUL-delimited names (machine-safe mode)', () => {
    const out = parseChangedFiles('src/a.ts\0src/b.ts\0tests/c.test.ts\0')
    assert.deepEqual(out, ['src/a.ts', 'src/b.ts', 'tests/c.test.ts'])
  })

  it('falls back to newline-split when no NUL is present', () => {
    const out = parseChangedFiles('src/a.ts\nsrc/b.ts\n')
    assert.deepEqual(out, ['src/a.ts', 'src/b.ts'])
  })

  it('unescapes quoted git core.quotePath output', () => {
    // `git diff --name-only` (no -z) wraps special-char paths in quotes and
    // uses C-style escapes. "a\"b c.ts" with a literal quote and space.
    const out = parseChangedFiles('"a\\"b c.ts"\nsrc/plain.ts\n')
    assert.deepEqual(out, ['a"b c.ts', 'src/plain.ts'])
  })

  it('decodes C-style escapes inside quoted paths', () => {
    const out = parseChangedFiles('"dir\\tfile.ts"\n')
    assert.deepEqual(out, ['dir\tfile.ts'])
  })

  it('decodes octal escapes for non-ASCII bytes', () => {
    // \303\251 = é in UTF-8 (octal 303 251)
    const out = parseChangedFiles('"caf\\303\\251.ts"\n')
    assert.deepEqual(out, ['caf\u00e9.ts'])
  })

  it('treats an escaped backslash atomically (does not re-parse following octal)', () => {
    // A filename containing a literal backslash + "303": git quotes the
    // backslash as `\\`, and the "303" must stay literal ASCII, not 0xC3.
    const out = parseChangedFiles('"a\\\\303.ts"\n')
    assert.deepEqual(out, ['a\\303.ts'])
  })

  it('keeps unknown escapes literal', () => {
    const out = parseChangedFiles('"a\\q.ts"\n')
    assert.deepEqual(out, ['a\\q.ts'])
  })

  it('drops blank lines but keeps ordinary names', () => {
    const out = parseChangedFiles('src/a.ts\n\nsrc/b.ts\n')
    assert.deepEqual(out, ['src/a.ts', 'src/b.ts'])
  })
})

describe('filterExistingFiles', () => {
  it('keeps only entries that resolve to an existing regular file under root', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'dir-only'))
    writeFileSync(join(root, 'b.ts'), 'export const b = 2\n')

    const out = filterExistingFiles(root, ['src/a.ts', 'b.ts', 'dir-only', 'missing.ts'])
    assert.deepEqual(out, ['src/a.ts', 'b.ts'])
  })

  it('rejects absolute paths and NUL-containing entries outright', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    const out = filterExistingFiles(root, ['a.ts', '/etc/passwd', 'a\0b.ts'])
    assert.deepEqual(out, ['a.ts'])
  })

  it('rejects parent-traversal entries that escape the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    const out = filterExistingFiles(root, ['../etc/passwd', '..', 'a/../../b'])
    assert.deepEqual(out, [])
  })

  it('silently skips unreadable entries (e.g. broken symlinks)', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    // A dangling symlink exists but is not a regular file; statSync rejects it.
    symlinkSync(join(root, 'does-not-exist-target'), join(root, 'broken-link'))
    const out = filterExistingFiles(root, ['broken-link', 'missing'])
    assert.deepEqual(out, [])
  })
})

describe('decideScope', () => {
  it('returns changed-only scope when there are changed files', () => {
    assert.deepEqual(decideScope(['src/a.ts']), {
      scope: 'changed-only',
      fallbackToFull: false,
    })
  })

  it('falls back to full scope when zero files changed (SKILL.md auto-fallback)', () => {
    assert.deepEqual(decideScope([]), {
      scope: 'full',
      fallbackToFull: true,
    })
  })
})

describe('resolveChangedFiles', () => {
  it('rejects a missing target branch with a full-scope fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    const result = await resolveChangedFiles(root, '')
    assert.equal(result.scope, 'full')
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.fallbackToFull, true)
    assert.ok(result.error?.includes('invalid target branch'))
  })

  it('rejects an option-injection branch name (leading dash)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    const result = await resolveChangedFiles(root, '--output=evil')
    assert.equal(result.scope, 'full')
    assert.ok(result.error?.includes('invalid target branch'))
  })

  it('degrades to full scope with an error when git is unavailable', async () => {
    // A plain temp dir is not a git repository — `git diff` fails and the
    // resolver must fall back to `full` instead of crashing the plan.
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    const result = await resolveChangedFiles(root, 'main')
    assert.equal(result.scope, 'full')
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.fallbackToFull, true)
    assert.ok(result.error && result.error.length > 0)
  })

  it('resolves the real changed-file set against a git repo', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'git-scope-'))
    try {
      const env = { ...process.env, PAGER: 'cat' }
      execFileSync('git', ['init', '-q'], { cwd: root, env })
      writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
      execFileSync('git', ['add', 'a.ts'], { cwd: root, env })
      execFileSync(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=iterate test', 'commit', '-q', '-m', 'init'],
        { cwd: root, env },
      )
      // Modify the committed file so `git diff HEAD` reports it as changed.
      writeFileSync(join(root, 'a.ts'), 'export const a = 2\n')
      writeFileSync(join(root, 'untracked.ts'), 'not tracked\n')
    } catch {
      // git binary or repo setup unavailable in this environment — skip.
      t.skip('git is not available in the test environment')
      return
    }

    const result = await resolveChangedFiles(root, 'HEAD')
    assert.equal(result.scope, 'changed-only')
    assert.ok(result.changedFiles.includes('a.ts'), `expected a.ts in ${JSON.stringify(result.changedFiles)}`)
    assert.equal(result.changedFiles.includes('untracked.ts'), false)
    assert.equal(result.fallbackToFull, false)
    assert.equal(result.error, undefined)
  })
})
