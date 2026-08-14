import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * Validate that a command is allowed by the whitelist.
 * A command is allowed if it starts with any whitelist prefix.
 */
export function isCommandAllowed(command: string, whitelist: string[]): boolean {
  const trimmed = command.trim()
  return whitelist.some((prefix) => trimmed.startsWith(prefix))
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