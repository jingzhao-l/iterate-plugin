import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defaultConfig, loadEffectiveConfig, validateConfig, resolveProjectRootForExec, flattenCommands } from '../config-loader.ts'
import {
  applyConfigUpdates,
  readRawConfig,
  validateConfigUpdates,
  writeConfigFile,
} from '../config-write.ts'
import { withProjectLock } from '../file-lock.ts'
import { buildValidationUpdates, detectValidationCommands } from '../validation-detect.ts'

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
      // `read` never writes; `write` persists a config update. `detect` is a
      // read UNLESS it is asked to apply the detected commands.
      isConcurrencySafe: (args) => {
        const a = args as { operation?: unknown; apply?: unknown }
        return a.operation !== 'write' && !(a.operation === 'detect' && a.apply === true)
      },
      // Pending-call card: a config read vs a validated write.
      presentCall: (args) => {
        const a = args as { operation?: unknown; section?: unknown; apply?: unknown }
        const isWrite = a.operation === 'write' || (a.operation === 'detect' && a.apply === true)
        const title = isWrite
          ? 'Update iterate.config.yaml'
          : a.operation === 'detect'
            ? 'Detect validation commands'
            : 'Read iterate.config.yaml'
        return {
          card: 'generic',
          title,
          kind: isWrite ? 'edit' : 'read',
          ...(typeof a.section === 'string' && a.section ? { rawInput: { section: a.section } } : {}),
        }
      },
      description:
        'Read or update the iterate.config.yaml configuration from the project root. ' +
        'Returns the full parsed config, a specific section, or validation errors. ' +
        'Use this to discover available dimensions, validation commands, git settings, and personalization rules, ' +
        'or to write back validated changes (goal, dimensions, max_rounds, review, atomic, validation, git, etc.). ' +
        'operation "detect" inspects the project manifest (package.json scripts / pytest / Cargo / Go / Make) and ' +
        'proposes a ready-to-apply validation.commands set; pass apply:true to install it in one call.',

      parameters: {
        operation: {
          type: 'string',
          description:
            'Default "read". "write" validates and applies a partial config update (backed up first). ' +
            '"detect" proposes validation commands from the project manifest.',
          enum: ['read', 'write', 'detect'],
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
        apply: {
          type: 'boolean',
          description:
            'For operation "detect": when true, install the detected commands under validation.commands.default ' +
            '(refused if commands are already configured unless force:true).',
        },
        force: {
          type: 'boolean',
          description: 'For operation "detect" with apply:true: replace an existing default command set.',
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
            errors: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
            section: { type: 'string' },
            data: { type: 'json' },
            config: { type: 'json' },
            availableSections: { type: 'array', items: { type: 'string' } },
            operation: { type: 'string' },
            ok: { type: 'boolean' },
            applied: { type: 'boolean' },
            ecosystem: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            commands: { type: 'array', items: { type: 'string' } },
            sources: { type: 'json' },
            updates: { type: 'json' },
            backupPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) {
          return { found: false, error: resolved.reason }
        }
        const projectRoot = resolved.root

        // ── Detect operation (validation-command auto-detection) ───────────
        // Reads the project manifest and proposes a curated command set. With
        // apply:true it installs the set under validation.commands.default in
        // the same validated, backed-up, locked write path as operation:write.
        if (args.operation === 'detect') {
          const configPath = join(projectRoot, 'iterate.config.yaml')
          const configExists = existsSync(configPath)
          const detection = detectValidationCommands(projectRoot)
          const updates = buildValidationUpdates(detection.commands)
          const base = {
            operation: 'detect',
            found: configExists,
            ecosystem: detection.ecosystem,
            commands: detection.commands,
            sources: detection.sources as unknown as JsonValue,
            updates: updates as unknown as JsonValue,
          }
          if (detection.commands.length === 0) {
            return {
              ...base,
              ok: false,
              applied: false,
              error:
                'no validation commands detected — the project does not advertise a test/typecheck/lint/build ' +
                'command; configure validation.commands manually',
            }
          }
          if (args.apply !== true) {
            return { ...base, ok: true, applied: false }
          }
          // Refuse to silently clobber a hand-tuned command set.
          const current = loadEffectiveConfig(projectRoot).config
          const existing = flattenCommands(current.validation?.commands)
          if (existing.length > 0 && args.force !== true) {
            return {
              ...base,
              ok: false,
              applied: false,
              error:
                `validation.commands already has ${existing.length} command(s); ` +
                'pass force:true to replace the "default" module',
            }
          }
          return withProjectLock(projectRoot, 'config-write', () => {
            let cfgBase: Record<string, unknown>
            try {
              cfgBase = configExists
                ? readRawConfig(configPath)
                : (defaultConfig() as unknown as Record<string, unknown>)
            } catch (err) {
              return { ...base, ok: false, applied: false, error: `failed to read config: ${String(err)}` }
            }
            const merged = applyConfigUpdates(cfgBase, updates)
            const schemaErrors = validateConfig(merged)
            if (schemaErrors.length > 0) {
              return {
                ...base,
                ok: false,
                applied: false,
                errors: schemaErrors.map((e) => `missing/required field: ${e}`),
              }
            }
            const result = writeConfigFile(projectRoot, merged)
            if (!result.ok) return { ...base, ok: false, applied: false, error: result.error }
            const { config } = loadEffectiveConfig(projectRoot)
            return {
              ...base,
              ok: true,
              applied: true,
              backupPath: result.backupPath ?? null,
              config: config as unknown as JsonValue,
            }
          })
        }

        // ── Write operation ────────────────────────────────────────────────
        if (args.operation === 'write') {
          const updates = args.updates as Record<string, unknown> | undefined
          // Missing/empty `updates` used to re-dump the config as-is: the
          // write "succeeded" (ok:true + a spurious backup) while silently
          // re-serializing the file and losing any hand-written comments.
          // There is nothing to merge — refuse instead.
          const isEmptyUpdate =
            updates === undefined ||
            updates === null ||
            (typeof updates === 'object' && !Array.isArray(updates) && Object.keys(updates).length === 0)
          if (isEmptyUpdate) {
            return {
              operation: 'write',
              ok: false,
              found: false,
              error: 'updates is required (and must be non-empty) for operation "write"',
            }
          }
          const updateErrors = validateConfigUpdates(updates ?? {})
          if (updateErrors.length > 0) {
            return { operation: 'write', ok: false, found: false, errors: updateErrors }
          }
          // Serialize the read→merge→validate→write cycle against any other
          // config/triage writer in a sibling process: without the lock, two
          // sessions on the same project each read a stale base and the second
          // merge silently discards the first's update (lost update). The same
          // lock name is shared with `iterate_triage apply` so the two writers
          // are mutually exclusive.
          return withProjectLock(projectRoot, 'config-write', () => {
            let base: Record<string, unknown>
            try {
              // Partial updates must be mergeable on a FRESH project (no config
              // file yet): otherwise `{max_rounds: 5}` alone fails schema
              // validation with a misleading "missing goal". Merge against the
              // built-in defaults when there is no file to read, so the written
              // config captures the effective config (defaults + update) and the
              // documented "write a partial update" contract works out of the box.
              base = existsSync(join(projectRoot, 'iterate.config.yaml'))
                ? readRawConfig(join(projectRoot, 'iterate.config.yaml'))
                : (defaultConfig() as unknown as Record<string, unknown>)
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
              backupPath: result.backupPath ?? null,
              config: config as unknown as JsonValue,
            }
          })
        }

        // ── Read operations (original behavior) ────────────────────────────
        const { config, source } = loadEffectiveConfig(projectRoot)
        const hasOverride = source === 'override'

        if (args.validate) {
          const errors = validateConfig(config)
          // A config file that EXISTS but cannot be parsed silently degrades to
          // the built-in defaults (loadEffectiveConfig never throws). Reporting
          // `valid: true` for that file would wave through the breakage —
          // re-read it raw and surface the parse failure as a validation error.
          const configPath = join(projectRoot, 'iterate.config.yaml')
          if (source === 'defaults' && existsSync(configPath)) {
            const raw = readFileSync(configPath, 'utf-8')
            if (raw.trim().length > 0) {
              try {
                readRawConfig(configPath)
              } catch (err) {
                return {
                  found: true,
                  valid: false,
                  errors: [`iterate.config.yaml is not usable: ${String((err as Error).message ?? err)}`],
                  section: 'validation_report',
                }
              }
            }
          }
          return {
            found: hasOverride,
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : null,
            section: 'validation_report',
          }
        }

        if (args.section) {
          const configRecord = config as unknown as Record<string, unknown>
          // Object.hasOwn, NOT `configRecord[args.section]`: a plain
          // `configRecord["toString"]` resolves through the PROTOTYPE CHAIN to
          // a function (non-JSON → ToolOutputError) and `["__proto__"]`
          // returns Object.prototype dressed up as an "existing section".
          const section = Object.hasOwn(configRecord, args.section)
            ? (configRecord[args.section] as unknown)
            : undefined
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
