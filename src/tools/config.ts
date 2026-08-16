import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { loadEffectiveConfig, validateConfig, resolveProjectRoot } from '../config-loader.ts'
import {
  applyConfigUpdates,
  readRawConfig,
  validateConfigUpdates,
  writeConfigFile,
} from '../config-write.ts'

/**
 * Register the `iterate_config` tool.
 * Reads and returns the iterate.config.yaml configuration, or writes a
 * validated partial update back to it (with backup + rollback).
 * Model-facing: returns JSON with the full config, a specific section, or validation errors.
 */
export function registerConfigTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_config',
      description:
        'Read or update the iterate.config.yaml configuration from the project root. ' +
        'Returns the full parsed config, a specific section, or validation errors. ' +
        'Use this to discover available dimensions, validation commands, git settings, and personalization rules, ' +
        'or to write back validated changes (goal, dimensions, max_rounds, review, atomic, validation, git, etc.).',

      parameters: {
        operation: {
          type: 'string',
          description: 'Default "read". "write" validates and applies a partial config update (backed up first).',
          enum: ['read', 'write'],
        },
        path: {
          type: 'string',
          description: 'Project root directory (default: current working directory).',
        },
        section: {
          type: 'string',
          description:
            'Optional config section to return: dimensions, validation, git, atomic, review, personalization, onboarding, or goal.',
        },
        validate: {
          type: 'boolean',
          description: 'If true, validate the config schema and return any missing fields.',
        },
        updates: {
          type: 'json',
          description:
            'For operation "write": a partial config object to merge in, e.g. ' +
            '{"goal":"...","dimensions":["correctness","security"],"max_rounds":5}. ' +
            'Supported keys: goal, language, dimensions, max_rounds, review, atomic, git, validation, personalization, onboarding.',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            valid: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'string' } },
            section: { type: 'string' },
            data: { type: 'json' },
            config: { type: 'json' },
            availableSections: { type: 'array', items: { type: 'string' } },
            operation: { type: 'string' },
            ok: { type: 'boolean' },
            backupPath: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args) {
        const resolved = resolveProjectRoot(args.path)
        if (!resolved.ok) {
          return { found: false, error: resolved.reason }
        }
        const projectRoot = resolved.root

        // ── Write operation ────────────────────────────────────────────────
        if (args.operation === 'write') {
          const updates = args.updates as Record<string, unknown> | undefined
          const updateErrors = validateConfigUpdates(updates ?? {})
          if (updateErrors.length > 0) {
            return { operation: 'write', ok: false, found: false, errors: updateErrors }
          }
          let base: Record<string, unknown>
          try {
            base = readRawConfig(join(projectRoot, 'iterate.config.yaml'))
          } catch (err) {
            return { operation: 'write', ok: false, found: false, error: `failed to read config: ${String(err)}` }
          }
          const merged = applyConfigUpdates(base, updates ?? {})
          const schemaErrors = validateConfig(merged)
          if (schemaErrors.length > 0) {
            return {
              operation: 'write',
              ok: false,
              found: false,
              errors: schemaErrors.map((e) => `missing/required field: ${e}`),
            }
          }
          const result = writeConfigFile(projectRoot, merged)
          if (!result.ok) return { operation: 'write', ok: false, found: false, error: result.error }
          const { config } = loadEffectiveConfig(projectRoot)
          return {
            operation: 'write',
            ok: true,
            found: true,
            backupPath: result.backupPath ?? undefined,
            config: config as unknown as JsonValue,
          }
        }

        // ── Read operations (original behavior) ────────────────────────────
        const { config, source } = loadEffectiveConfig(projectRoot)
        const hasOverride = source === 'override'

        if (args.validate) {
          const errors = validateConfig(config)
          return {
            found: hasOverride,
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
            section: 'validation_report',
          }
        }

        if (args.section) {
          const configRecord = config as unknown as Record<string, unknown>
          const section = configRecord[args.section]
          if (section === undefined) {
            return {
              found: hasOverride,
              error: `Section "${args.section}" not found in config.`,
              availableSections: Object.keys(configRecord),
            }
          }
          return { found: hasOverride, section: args.section, data: section as JsonValue }
        }

        return { found: hasOverride, config: config as unknown as JsonValue }
      },
    }),
  )
}
