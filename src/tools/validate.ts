import { exec } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadConfig, isCommandAllowed } from '../config-loader.ts'
import type { ValidationResult } from '../types.ts'

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Run a single shell command with timeout and return structured results.
 * Pure function (no side effects beyond the exec call).
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ValidationResult> {
  const start = performance.now()
  return new Promise<ValidationResult>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, PAGER: 'cat' },
      },
      (error, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - start)
        // error.code is the exit code when the command ran; error.killed means timeout
        resolve({
          command,
          exitCode: error?.code ?? (error ? 1 : 0),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: error?.killed === true,
          durationMs,
        })
      },
    )
  })
}

/**
 * Register the `iterate_validate` tool.
 * Runs validation commands defined in iterate.config.yaml.
 * Enforces the command_whitelist — commands not matching any prefix are rejected.
 */
export function registerValidateTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_validate',
      description:
        'Run a validation command from the project root. ' +
        'Only commands matching the iterate.config.yaml command_whitelist are allowed. ' +
        'Returns exit code, stdout, stderr, and duration. ' +
        'Use this after making fixes to verify correctness.',

      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'The shell command to run (e.g. "pytest tests/ -x -q").',
        },
        path: {
          type: 'string',
          description: 'Project root directory (default: current working directory).',
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: 120000).',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            allowed: { type: 'boolean', required: true },
            command: { type: 'string', required: true },
            exitCode: { type: 'integer', required: true },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            timedOut: { type: 'boolean', required: true },
            durationMs: { type: 'integer', required: true },
            rejectReason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.allowed
              ? [
                  `Command: ${value.command}`,
                  `Exit code: ${value.exitCode}`,
                  `Duration: ${value.durationMs}ms`,
                  value.timedOut ? '⚠ Timed out' : '',
                  '',
                  value.stdout ? `[stdout]\n${value.stdout}` : '',
                  value.stderr ? `[stderr]\n${value.stderr}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              : `Command rejected: ${value.rejectReason}`,
          },
        ],
      },

      async execute(args) {
        const projectRoot = args.path ?? process.cwd()
        const config = loadConfig(projectRoot)
        const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS

        if (!config) {
          return {
            allowed: false,
            command: args.command,
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            durationMs: 0,
            rejectReason: 'iterate.config.yaml not found — cannot validate command whitelist.',
          }
        }

        // Check whitelist
        const whitelist = config.validation.command_whitelist ?? []
        if (!isCommandAllowed(args.command, whitelist)) {
          return {
            allowed: false,
            command: args.command,
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            durationMs: 0,
            rejectReason: `Command does not match any whitelist prefix. Allowed: ${whitelist.join(', ')}`,
          }
        }

        const result = await runCommand(args.command, projectRoot, timeout)
        return {
          allowed: true,
          ...result,
        }
      },
    }),
  )
}