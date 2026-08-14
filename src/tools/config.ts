import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { loadEffectiveConfig, validateConfig } from '../config-loader.ts'

/**
 * Register the `iterate_config` tool.
 * Reads and returns the iterate.config.yaml configuration.
 * Model-facing: returns JSON with the full config, a specific section, or validation errors.
 */
export function registerConfigTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_config',
      description:
        'Read the iterate.config.yaml configuration from the project root. ' +
        'Returns the full parsed config, a specific section, or validation errors. ' +
        'Use this to discover available dimensions, validation commands, git settings, and personalization rules.',

      parameters: {
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
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args) {
        const projectRoot = args.path ?? process.cwd()
        // Effective config = defaults (Master) merged with any project-root
        // overrides. Never null: a project without a config file runs on the
        // built-in defaults, so the workflow stays usable out of the box.
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
