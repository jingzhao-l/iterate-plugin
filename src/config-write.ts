/**
 * src/config-write.ts — shared helpers for safely WRITING iterate.config.yaml.
 *
 * Used by the `iterate_config` write operation. Provides:
 *   - validateConfigUpdates : validate a caller-supplied partial update
 *   - applyConfigUpdates    : merge a partial update into the current config
 *   - writeConfigFile       : backup + write + rollback on failure
 *
 * The security posture mirrors the triage tool: never overwrite a malformed
 * config, always back up before writing, roll back on failure.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** Config file name (must match config-loader). */
export const CONFIG_FILE = 'iterate.config.yaml'

/** Backup suffix helper (filesystem-safe timestamp). */
export function configBackupSuffix(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * Validate a partial config update.
 * Returns an array of error strings (empty when the update is valid).
 */
export function validateConfigUpdates(updates: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return ['updates must be a JSON object']
  }

  if ('goal' in updates && typeof updates.goal !== 'string') {
    errors.push('updates.goal must be a string')
  }
  if ('language' in updates && updates.language !== 'zh' && updates.language !== 'en') {
    errors.push('updates.language must be "zh" or "en"')
  }
  if ('dimensions' in updates) {
    if (!Array.isArray(updates.dimensions) || updates.dimensions.some((d) => typeof d !== 'string' || d.trim().length === 0)) {
      errors.push('updates.dimensions must be an array of non-empty strings')
    }
  }
  if ('max_rounds' in updates) {
    if (typeof updates.max_rounds !== 'number' || !Number.isInteger(updates.max_rounds) || updates.max_rounds < 1) {
      errors.push('updates.max_rounds must be a positive integer')
    }
  }
  if ('review' in updates) {
    const r = updates.review as Record<string, unknown> | undefined
    if (!r || typeof r !== 'object') {
      errors.push('updates.review must be an object')
    } else if (r.scope !== undefined && r.scope !== 'full' && r.scope !== 'changed-only') {
      errors.push('updates.review.scope must be "full" or "changed-only"')
    }
  }
  if ('atomic' in updates) {
    const a = updates.atomic as Record<string, unknown> | undefined
    if (!a || typeof a !== 'object') {
      errors.push('updates.atomic must be an object')
    } else {
      if (a.max_lines !== undefined && (typeof a.max_lines !== 'number' || !Number.isInteger(a.max_lines) || a.max_lines < 1)) {
        errors.push('updates.atomic.max_lines must be a positive integer')
      }
      if (a.max_adjacent_methods !== undefined && (typeof a.max_adjacent_methods !== 'number' || a.max_adjacent_methods < 0)) {
        errors.push('updates.atomic.max_adjacent_methods must be a non-negative number')
      }
    }
  }
  if ('git' in updates) {
    const g = updates.git as Record<string, unknown> | undefined
    if (!g || typeof g !== 'object') {
      errors.push('updates.git must be an object')
    } else {
      if (g.target_branch !== undefined && typeof g.target_branch !== 'string') {
        errors.push('updates.git.target_branch must be a string')
      }
      for (const boolKey of ['use_worktree', 'push_per_round', 'auto_merge'] as const) {
        if (g[boolKey] !== undefined && typeof g[boolKey] !== 'boolean') {
          errors.push(`updates.git.${boolKey} must be a boolean`)
        }
      }
    }
  }
  if ('validation' in updates) {
    const v = updates.validation as Record<string, unknown> | undefined
    if (!v || typeof v !== 'object') {
      errors.push('updates.validation must be an object')
    } else if ('commands' in v && v.commands !== undefined && typeof v.commands !== 'object') {
      errors.push('updates.validation.commands must be an object of command arrays')
    }
  }
  if ('personalization' in updates && (!updates.personalization || typeof updates.personalization !== 'object')) {
    errors.push('updates.personalization must be an object')
  }
  if ('onboarding' in updates && (!updates.onboarding || typeof updates.onboarding !== 'object')) {
    errors.push('updates.onboarding must be an object')
  }
  return errors
}

/** Recursively merge `updates` over `base` (arrays replaced wholesale). */
export function applyConfigUpdates(
  base: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(updates)) {
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
      out[key] = applyConfigUpdates(baseValue as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Read the raw config object from disk (empty object when missing).
 * Throws when the file exists but cannot be parsed as a YAML mapping
 * (never overwrite a malformed config).
 */
export function readRawConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  const content = readFileSync(configPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch {
    throw new Error('existing iterate.config.yaml is not a valid YAML mapping')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('existing iterate.config.yaml is not a valid YAML mapping')
  }
  return parsed as Record<string, unknown>
}

/**
 * Write a config object to disk with backup + rollback.
 * Returns `{ ok: true, backupPath }` or `{ ok: false, error }`.
 */
export function writeConfigFile(
  projectRoot: string,
  config: Record<string, unknown>,
): { ok: true; backupPath: string | null } | { ok: false; error: string } {
  const configPath = join(projectRoot, CONFIG_FILE)
  const hadFile = existsSync(configPath)
  const backupPath = hadFile ? `${configPath}.bak-${configBackupSuffix()}` : null

  if (backupPath) {
    try {
      copyFileSync(configPath, backupPath)
    } catch (err) {
      return { ok: false, error: `failed to create backup: ${String(err)}` }
    }
  }

  try {
    writeFileSync(configPath, yaml.dump(config, { noRefs: true }), 'utf-8')
  } catch (err) {
    let rollbackError = ''
    try {
      if (backupPath) copyFileSync(backupPath, configPath)
      else if (existsSync(configPath)) rmSync(configPath, { force: true })
    } catch (rbErr) {
      rollbackError = `; rollback also failed: ${String(rbErr)}`
    }
    return { ok: false, error: `failed to write config: ${String(err)}${rollbackError}` }
  }

  return { ok: true, backupPath }
}
