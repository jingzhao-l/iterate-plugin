import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { buildValidationUpdates, detectValidationCommands } from '../src/validation-detect.ts'

function project(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-vdetect-test-'))
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'x', scripts }, null, 2)
}

describe('detectValidationCommands', () => {
  it('returns nothing for an empty / nonexistent directory (never throws)', () => {
    const empty = detectValidationCommands('/definitely/not/a/real/project/root')
    assert.deepEqual(empty, { ecosystem: null, commands: [], sources: [] })

    const { dir, cleanup } = project({})
    try {
      assert.deepEqual(detectValidationCommands(dir), { ecosystem: null, commands: [], sources: [] })
    } finally {
      cleanup()
    }
  })

  it('detects the curated Node scripts in a stable order', () => {
    const { dir, cleanup } = project({
      'package.json': pkg({ build: 'tsc', lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test' }),
    })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'node')
      assert.deepEqual(out.commands, ['npm test', 'npm run typecheck', 'npm run lint', 'npm run build'])
      assert.equal(out.sources.length, out.commands.length)
      assert.deepEqual(out.sources.map((s) => s.file), ['package.json', 'package.json', 'package.json', 'package.json'])
      assert.deepEqual(out.sources.map((s) => s.reason), ['scripts.test', 'scripts.typecheck', 'scripts.lint', 'scripts.build'])
    } finally {
      cleanup()
    }
  })

  it('only proposes scripts the manifest actually defines', () => {
    const { dir, cleanup } = project({ 'package.json': pkg({ test: 'vitest' }) })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'node')
      assert.deepEqual(out.commands, ['npm test'])
    } finally {
      cleanup()
    }
  })

  it('treats a package.json with no usable scripts as "nothing detected"', () => {
    const { dir, cleanup } = project({ 'package.json': pkg({ dev: 'vite', serve: 'vite preview' }) })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, null)
      assert.deepEqual(out.commands, [])
    } finally {
      cleanup()
    }
  })

  it('degrades a malformed package.json to nothing instead of throwing', () => {
    const { dir, cleanup } = project({ 'package.json': '{ not json' })
    try {
      assert.deepEqual(detectValidationCommands(dir), { ecosystem: null, commands: [], sources: [] })
    } finally {
      cleanup()
    }
  })

  it('ignores a non-object package.json (array / scalar)', () => {
    const { dir, cleanup } = project({ 'package.json': '[]' })
    try {
      assert.deepEqual(detectValidationCommands(dir).commands, [])
    } finally {
      cleanup()
    }
  })

  it('detects pytest + ruff + mypy from pyproject', () => {
    const { dir, cleanup } = project({
      'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n',
    })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'python')
      assert.deepEqual(out.commands, ['pytest -q', 'ruff check .', 'mypy .'])
      assert.deepEqual(out.sources.map((s) => s.reason), ['tool.pytest', 'tool.ruff', 'tool.mypy'])
    } finally {
      cleanup()
    }
  })

  it('detects pytest from a bare tests/ directory', () => {
    const { dir, cleanup } = project({ 'tests/test_a.py': 'def test_a(): pass\n' })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'python')
      assert.deepEqual(out.commands, ['pytest -q'])
      assert.equal(out.sources[0]!.file, 'tests')
    } finally {
      cleanup()
    }
  })

  it('does not assume pytest for a pyproject with no pytest config', () => {
    const { dir, cleanup } = project({ 'pyproject.toml': '[project]\nname = "x"\n' })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, null)
      assert.deepEqual(out.commands, [])
    } finally {
      cleanup()
    }
  })

  it('detects cargo test plus configured clippy / rustfmt', () => {
    const { dir, cleanup } = project({
      'Cargo.toml': '[package]\nname = "x"\n',
      'clippy.toml': 'msrv = "1.70"\n',
      'rustfmt.toml': 'edition = "2021"\n',
    })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'rust')
      assert.deepEqual(out.commands, ['cargo test', 'cargo clippy --all-targets -- -D warnings', 'cargo fmt --check'])
    } finally {
      cleanup()
    }
  })

  it('detects go test + vet', () => {
    const { dir, cleanup } = project({ 'go.mod': 'module x\n\ngo 1.22\n' })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'go')
      assert.deepEqual(out.commands, ['go test ./...', 'go vet ./...'])
    } finally {
      cleanup()
    }
  })

  it('uses Makefile targets as the generic fallback', () => {
    const { dir, cleanup } = project({ Makefile: 'all: build\n\ntest:\n\tgo test ./...\n\ncheck:\n\tlint\n' })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'make')
      assert.deepEqual(out.commands, ['make test', 'make check'])
    } finally {
      cleanup()
    }
  })

  it('never mistakes a := assignment for a make target', () => {
    const { dir, cleanup } = project({ Makefile: 'test := nope\nOTHER := x\n' })
    try {
      assert.deepEqual(detectValidationCommands(dir).commands, [])
    } finally {
      cleanup()
    }
  })

  it('prefers an ecosystem-specific command over a wrapping Makefile', () => {
    const { dir, cleanup } = project({
      'package.json': pkg({ test: 'jest' }),
      Makefile: 'test:\n\tnpm test\n',
    })
    try {
      const out = detectValidationCommands(dir)
      assert.equal(out.ecosystem, 'node')
      assert.deepEqual(out.commands, ['npm test'])
    } finally {
      cleanup()
    }
  })

  it('caps the command list and de-duplicates identical commands', () => {
    const { dir, cleanup } = project({
      'package.json': pkg({ test: 'a', typecheck: 'b', lint: 'c', build: 'd' }),
      'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n',
    })
    try {
      const out = detectValidationCommands(dir)
      assert.ok(out.commands.length <= 6, `got ${out.commands.length}`)
      assert.equal(new Set(out.commands).size, out.commands.length)
      assert.equal(out.sources.length, out.commands.length)
      // Node is detected first, so it owns the ecosystem label.
      assert.equal(out.ecosystem, 'node')
    } finally {
      cleanup()
    }
  })
})

describe('buildValidationUpdates', () => {
  it('builds a deep-mergeable partial config under the default module', () => {
    const updates = buildValidationUpdates(['npm test', 'npm run lint'])
    assert.deepEqual(updates, {
      validation: { commands: { default: ['npm test', 'npm run lint'] } },
    })
  })

  it('copies the array so callers cannot mutate the built payload', () => {
    const commands = ['npm test']
    const updates = buildValidationUpdates(commands) as {
      validation: { commands: { default: string[] } }
    }
    updates.validation.commands.default.push('npm run build')
    assert.deepEqual(commands, ['npm test'])
  })
})
