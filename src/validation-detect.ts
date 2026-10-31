/**
 * src/validation-detect.ts — detect a project's validation commands.
 *
 * Why it exists: the iterate loop is fail-closed on `validation.commands` — an
 * empty set means it cannot tell a fix from a regression, so `iterate_preflight`
 * blocks the run. Until now the only remedy was to hand-write the YAML, which is
 * error-prone (wrong nesting, wrong module key, commands the project does not
 * actually expose). This module inspects the project's own manifest files and
 * proposes a small, curated command set that the config tool can apply in one
 * call.
 *
 * Detection is advisory and read-only: it only proposes commands the project's
 * manifest actually advertises (package.json scripts, pytest/ruff/mypy config,
 * Cargo, Go, Make targets). It never invents a command and never executes one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Ecosystems this module knows how to read a manifest for. */
export type Ecosystem = 'node' | 'python' | 'rust' | 'go' | 'make'

/** One manifest fact that produced a command. */
export interface DetectionSource {
  /** Manifest file, relative to the project root. */
  file: string
  /** Short machine-stable reason, e.g. `scripts.test`. */
  reason: string
}

/** The result of inspecting a project root. */
export interface ValidationDetection {
  /** The ecosystem that produced the first command, or null when none matched. */
  ecosystem: Ecosystem | null
  /** Ordered, de-duplicated commands for `validation.commands.default`. */
  commands: string[]
  /** One entry per command, same order/length as `commands`. */
  sources: DetectionSource[]
}

/** Hard cap so a project with many scripts cannot flood the config. */
const MAX_COMMANDS = 6

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const text = readText(path)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    // A JSON array / scalar is not a manifest object — treat it as absent.
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function existsFile(root: string, name: string): boolean {
  try {
    return existsSync(join(root, name))
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

type AddCommand = (command: string, file: string, reason: string) => void

/** Node: only scripts the manifest explicitly defines, in a curated order. */
function detectNode(root: string, add: AddCommand): boolean {
  const pkg = readJsonObject(join(root, 'package.json'))
  if (!pkg) return false
  const scripts = asRecord(pkg.scripts)
  const has = (name: string): boolean =>
    typeof scripts[name] === 'string' && (scripts[name] as string).trim().length > 0
  // test/typecheck/lint/build are the four signals that actually prove a change
  // is sound. Arbitrary user scripts are intentionally NOT auto-run.
  if (has('test')) add('npm test', 'package.json', 'scripts.test')
  if (has('typecheck')) add('npm run typecheck', 'package.json', 'scripts.typecheck')
  if (has('lint')) add('npm run lint', 'package.json', 'scripts.lint')
  if (has('build')) add('npm run build', 'package.json', 'scripts.build')
  return true
}

/** Python: pytest plus configured ruff / mypy. A bare pyproject is not pytest. */
function detectPython(root: string, add: AddCommand): boolean {
  const pyproject = readText(join(root, 'pyproject.toml'))
  const setupCfg = readText(join(root, 'setup.cfg'))
  const pytestIni = existsFile(root, 'pytest.ini')
  const toxIni = existsFile(root, 'tox.ini')
  const testsDir = existsFile(root, 'tests')
  const pyprojectPytest = pyproject !== null && /\[tool\.pytest/.test(pyproject)
  const setupCfgPytest = setupCfg !== null && /\[tool:pytest\]/.test(setupCfg)
  const matched = pyproject !== null || setupCfg !== null || pytestIni || toxIni || testsDir
  if (!matched) return false

  if (pytestIni) add('pytest -q', 'pytest.ini', 'pytest')
  else if (toxIni) add('pytest -q', 'tox.ini', 'pytest')
  else if (pyprojectPytest) add('pytest -q', 'pyproject.toml', 'tool.pytest')
  else if (setupCfgPytest) add('pytest -q', 'setup.cfg', 'tool:pytest')
  else if (testsDir) add('pytest -q', 'tests', 'tests-dir')

  if (pyproject !== null && /\[tool\.ruff/.test(pyproject)) add('ruff check .', 'pyproject.toml', 'tool.ruff')
  if (pyproject !== null && /\[tool\.mypy\]/.test(pyproject)) add('mypy .', 'pyproject.toml', 'tool.mypy')
  return true
}

/** Rust: cargo test, plus clippy/rustfmt when the project configures them. */
function detectRust(root: string, add: AddCommand): boolean {
  if (!existsFile(root, 'Cargo.toml')) return false
  add('cargo test', 'Cargo.toml', 'cargo.test')
  if (existsFile(root, 'clippy.toml') || existsFile(root, '.clippy.toml')) {
    add('cargo clippy --all-targets -- -D warnings', 'clippy.toml', 'cargo.clippy')
  }
  if (existsFile(root, 'rustfmt.toml') || existsFile(root, '.rustfmt.toml')) {
    add('cargo fmt --check', 'rustfmt.toml', 'cargo.fmt')
  }
  return true
}

/** Go: test + vet are the two checks a go module always supports. */
function detectGo(root: string, add: AddCommand): boolean {
  if (!existsFile(root, 'go.mod')) return false
  add('go test ./...', 'go.mod', 'go.test')
  add('go vet ./...', 'go.mod', 'go.vet')
  return true
}

/** Make: the generic fallback, only when no ecosystem-specific command exists. */
function detectMake(root: string, add: AddCommand): boolean {
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((name) => existsFile(root, name))
  if (!makefile) return false
  const text = readText(join(root, makefile)) ?? ''
  const targets = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    // `target:`, but NOT a `VAR := value` / `VAR = value` assignment. The
    // lookahead has to skip the optional space before `=` (`test := nope`).
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=|\s*=)/.exec(line)
    if (match) targets.add(match[1] as string)
  }
  if (targets.has('test')) add('make test', makefile, 'target.test')
  if (targets.has('check')) add('make check', makefile, 'target.check')
  return true
}

/**
 * Inspect `projectRoot` and return a curated, ordered validation-command set.
 *
 * Never throws: unreadable or malformed manifests simply contribute nothing.
 * The returned `commands` and `sources` always have the same length.
 */
export function detectValidationCommands(projectRoot: string): ValidationDetection {
  const commands: string[] = []
  const sources: DetectionSource[] = []
  const seen = new Set<string>()
  const add: AddCommand = (command, file, reason) => {
    if (commands.length >= MAX_COMMANDS) return
    if (seen.has(command)) return
    seen.add(command)
    commands.push(command)
    sources.push({ file, reason })
  }

  let ecosystem: Ecosystem | null = null
  const run = (name: Ecosystem, detect: (add: AddCommand) => boolean): void => {
    const before = commands.length
    let matched = false
    try {
      matched = detect(add)
    } catch {
      matched = false
    }
    if (matched && commands.length > before && ecosystem === null) ecosystem = name
  }

  run('node', (a) => detectNode(projectRoot, a))
  run('python', (a) => detectPython(projectRoot, a))
  run('rust', (a) => detectRust(projectRoot, a))
  run('go', (a) => detectGo(projectRoot, a))
  // Make is the generic wrapper: only consult it when nothing else produced a
  // command, so a Makefile that just calls `npm test` does not double-report.
  if (commands.length === 0) run('make', (a) => detectMake(projectRoot, a))

  return { ecosystem, commands, sources }
}

/**
 * Build the partial config update that installs a detected command set under
 * the `default` module. The config tool deep-merges this into an existing
 * `validation.commands` map, so other modules are preserved.
 */
export function buildValidationUpdates(commands: string[]): Record<string, unknown> {
  return { validation: { commands: { default: [...commands] } } }
}
