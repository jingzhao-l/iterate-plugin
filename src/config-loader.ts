import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import yaml from 'js-yaml'
import type { IterateConfig } from './types.ts'

/**
 * Load and parse iterate.config.yaml from the project root.
 * Returns null if the file is missing or invalid.
 */
export function loadConfig(projectRoot: string): IterateConfig | null {
  try {
    const content = readFileSync(join(projectRoot, 'iterate.config.yaml'), 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as unknown as IterateConfig
  } catch {
    return null
  }
}

/**
 * Sensible defaults for every config field. These are the "Master" config:
 * when a project has no iterate.config.yaml (or only partial overrides), every
 * missing key is filled from here so the plugin is usable out of the box while
 * never inventing trusted validation commands (they must be configured).
 */
export function defaultConfig(): IterateConfig {
  return {
    goal: 'Improve code quality and maintainability',
    max_rounds: 7,
    language: 'en',
    dimensions: [
      'correctness',
      'security',
      'performance',
      'architecture',
      'style-tests',
      'tech-debt',
      'spec-compliance',
      'frontend-backend',
      'ui-ux',
    ],
    review: { scope: 'full' },
    atomic: { max_lines: 20, max_adjacent_methods: 3 },
    git: {
      target_branch: 'main',
      use_worktree: false,
      push_per_round: false,
      auto_merge: false,
    },
    validation: { command_whitelist: [], commands: {} },
    reviewer: { output_schema_validation: true, evidence_validation: true },
  }
}

/**
 * Recursively merge `override` on top of `base`.
 * - Missing keys in `base` are added from `override`.
 * - Present keys in `override` win.
 * - Plain objects are merged recursively; arrays and scalars are replaced
 *   wholesale by the override (arrays are NOT concatenated).
 * Returns a NEW object; neither input is mutated.
 */
export function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override || typeof override !== 'object') return { ...base }
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const baseValue = out[key]
    if (
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = mergeConfig(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Load the EFFECTIVE config for a project: project-root overrides merged on top
 * of the built-in defaults ("Master + Overrides"). Never returns null — a
 * project without a config file simply runs on the defaults (with an empty
 * validation command set, so nothing untrusted can ever execute).
 */
export function loadEffectiveConfig(projectRoot: string): {
  config: IterateConfig
  source: 'defaults' | 'override'
  override: IterateConfig | null
} {
  const override = loadConfig(projectRoot)
  if (!override) {
    return { config: defaultConfig(), source: 'defaults', override: null }
  }
  const merged = mergeConfig(
    defaultConfig() as unknown as Record<string, unknown>,
    override as unknown as Record<string, unknown>,
  ) as unknown as IterateConfig
  return { config: merged, source: 'override', override }
}

/**
 * Check whether a command is in the predefined commands list.
 * A command is allowed if it is EXACTLY (after trim) listed in any
 * module's command array in `validation.commands`.
 * This replaces the old prefix-based whitelist at runtime — the
 * `command_whitelist` is still used for config-time validation only.
 */
export function isCommandAllowed(command: string, predefinedCommands: string[]): boolean {
  const trimmed = command.trim()
  return predefinedCommands.includes(trimmed)
}

/**
 * Flatten all commands from `validation.commands` into a single string array.
 * Used for runtime exact-match checking.
 */
export function flattenCommands(
  commands: Record<string, string[]> | undefined,
): string[] {
  if (!commands || typeof commands !== 'object') return []
  const out: string[] = []
  for (const v of Object.values(commands)) {
    if (Array.isArray(v)) out.push(...v)
  }
  return out
}

/**
 * Validate that the config has all required fields.
 * Returns an array of missing field paths.
 */
export function validateConfig(config: unknown): string[] {
  const errors: string[] = []
  if (!config || typeof config !== 'object') {
    errors.push('root')
    return errors
  }
  const c = config as Record<string, unknown>
  if (!c.goal) errors.push('goal')
  if (!Array.isArray(c.dimensions)) errors.push('dimensions')
  if (!c.validation || typeof c.validation !== 'object') {
    errors.push('validation')
  } else {
    const v = c.validation as Record<string, unknown>
    if (!Array.isArray(v.command_whitelist)) errors.push('validation.command_whitelist')
    if (!v.commands || typeof v.commands !== 'object') errors.push('validation.commands')
  }
  return errors
}

/** Result of resolving/validating a caller-supplied project root. */
export type ProjectRootResult = { ok: true; root: string } | { ok: false; reason: string }

/**
 * Resolve a caller-supplied project root to a safe absolute path.
 *
 * Every tool accepts a model-controlled `path` argument. Before it is used in
 * any file read/write or as a command `cwd`, it must be sanitized:
 *  - an empty/missing `path` falls back to the current working directory;
 *  - the path is resolved to an absolute path (collapsing `..` and symlinks);
 *  - the filesystem root (`/`) is refused — it would let a prompt point tools
 *    at arbitrary system directories (path-traversal escape).
 *
 * Returns `{ ok: true, root }` on success, or `{ ok: false, reason }` when the
 * path is unsafe; callers must short-circuit on the failure and return a
 * structured error instead of proceeding.
 */
export function resolveProjectRoot(input?: string): ProjectRootResult {
  const raw = (input ?? '').trim()
  const root = raw ? resolve(raw) : resolve(process.cwd())
  if (!root || root === sep) {
    return { ok: false, reason: 'Refusing filesystem root as project root.' }
  }
  return { ok: true, root }
}