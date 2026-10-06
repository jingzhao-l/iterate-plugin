import { exec } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  loadEffectiveConfig,
  isCommandAllowed,
  flattenCommands,
  resolveProjectRootForExec,
} from '../config-loader.ts'
import type { ValidationResult } from '../types.ts'

const DEFAULT_TIMEOUT_MS = 120_000
/** Hard ceiling on a single validation command's runtime, so a model cannot
 *  pin the tool open indefinitely via an unbounded `timeout` argument. */
const MAX_TIMEOUT_MS = 600_000

/** Default cap on a validation command's captured stdout+stderr (10 MB). */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

/**
 * Clamp a caller-supplied timeout (ms) to a sane range.
 * Non-finite / non-positive values fall back to the default; any value above
 * the ceiling is capped. Pure function, unit-tested.
 */
export function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(ms, MAX_TIMEOUT_MS)
}

/**
 * Result of {@link runCommand}: a plain {@link ValidationResult} plus two run
 * anomalies the tool layer must surface but the shared `ValidationResult`
 * DTO (src/types.ts) has no field for.
 *   - `truncated` — output hit the `maxBuffer` cap; stdout/stderr were cut.
 *   - `startError` — `exec()` refused to spawn the command (it throws
 *     SYNCHRONOUSLY for e.g. a NUL byte in the command string); the command
 *     never ran at all.
 */
export type RunCommandResult = ValidationResult & {
  truncated?: boolean
  startError?: string
}

/**
 * Run a single shell command with timeout and return structured results.
 * Pure function (no side effects beyond the exec call).
 *
 * `signal` (the caller's `exec.signal` per the dsh tools contract) is forwarded
 * to the child process so a cancelled tool call kills the running command
 * instead of pinning the dispatch open until the timeout elapses. The result
 * distinguishes "cancelled by the caller" (`canceled: true`) from "ran past
 * `timeoutMs`" (`timedOut: true`).
 *
 * `maxBuffer` is injectable for tests (defaults to the production 10 MB cap);
 * hitting it sets `truncated: true` so callers can report the cut output
 * instead of silently returning a partial stream.
 *
 * Never rejects: `exec()` validates its arguments synchronously and can THROW
 * before registering its callback (a NUL byte in the command raises
 * ERR_INVALID_ARG_VALUE). Inside a promise executor that throw would reject
 * the promise and escape `execute` unguarded, so it is caught and resolved as
 * a `startError` result instead.
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBuffer: number = DEFAULT_MAX_BUFFER,
): Promise<RunCommandResult> {
  const start = performance.now()
  return new Promise<RunCommandResult>((resolve) => {
    try {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer,
          env: { ...process.env, PAGER: 'cat' },
          signal,
        },
        (error, stdout, stderr) => {
          const durationMs = Math.round(performance.now() - start)
          // error.code is the exit code when the command ran; when the binary
          // cannot be spawned Node sets error.code to a STRING ('ENOENT' etc).
          // Coerce to a number so the integer output schema is never violated.
          const exitCode = typeof error?.code === 'number' ? error.code : (error ? 1 : 0)
          const canceled = signal?.aborted === true
          // maxBuffer overflow: error.code is the STRING
          // 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' and stdout/stderr were cut
          // short — flag it instead of reporting a plain exit-1 with silently
          // truncated output. @types/node types ExecException.code as
          // number|undefined, so widen to unknown for the runtime comparison.
          const errorCode: unknown = error?.code
          const truncated = errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          resolve({
            command,
            exitCode,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            // A caller cancellation also kills the child (killed === true), but
            // that is not a timeout — only report timedOut for the deadline path.
            timedOut: error?.killed === true && !canceled,
            canceled,
            durationMs,
            truncated,
          })
        },
      )
    } catch (err) {
      // Synchronous exec() throw (invalid command string, e.g. a NUL byte):
      // resolve a structured "never started" failure rather than rejecting.
      resolve({
        command,
        exitCode: 1,
        stdout: '',
        stderr: String(err),
        timedOut: false,
        canceled: false,
        durationMs: Math.round(performance.now() - start),
        truncated: false,
        startError: String((err as Error)?.message ?? err),
      })
    }
  })
}

/**
 * Register the `iterate_validate` tool.
 * Runs validation commands defined in iterate.config.yaml `validation.commands`.
 * Enforces exact-match — a command not listed there (exactly) is rejected.
 */
export function registerValidateTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_validate',
      // Pending-call card: render the pending validation as a terminal card.
      // Pure — derived from args only; no `cwd` (the UI bridge resolves the
      // relative command against the session workspace).
      presentCall: (args) => {
        const a = args as { command?: unknown }
        if (typeof a.command !== 'string' || a.command.length === 0) return undefined
        return {
          card: 'terminal',
          title: a.command,
          description: 'Run a preconfigured iterate validation command (exact match on validation.commands).',
        }
      },
      description:
        'Run a validation command that is PRECONFIGURED in iterate.config.yaml `validation.commands`. ' +
        'The command must exactly match one of the configured commands (they are the only ones the user trusts). ' +
        'Returns exit code, stdout, stderr, and duration. ' +
        'Use this after making fixes to verify correctness.',

      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'One of the commands listed in iterate.config.yaml validation.commands (exact match required, e.g. "pytest tests/ -x -q").',
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
            canceled: { type: 'boolean', required: true },
            durationMs: { type: 'integer', required: true },
            truncated: {
              type: 'boolean',
              description: 'true when command output exceeded the maxBuffer cap and was cut short.',
            },
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
                  value.canceled ? '⚠ Cancelled before completion' : '',
                  // A truncated run still reports its (partial) output — the
                  // reader must be told the stream was cut, otherwise the
                  // missing tail reads as "no output".
                  value.truncated
                    ? `⚠ ${value.rejectReason ?? 'Output truncated: maxBuffer limit exceeded.'}`
                    : '',
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

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) {
          return {
            allowed: false,
            command: args.command,
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            canceled: false,
            durationMs: 0,
            rejectReason: resolved.reason,
          }
        }
        const projectRoot = resolved.root
        // Effective config = defaults merged with project overrides. Never null.
        const { config, source } = loadEffectiveConfig(projectRoot)
        const timeout = clampTimeout(args.timeout)

        // Only commands predefined in validation.commands may run — the
        // user trusts exactly these, and nothing else. This replaces the
        // old prefix-match whitelist, which let e.g. `python3 -c "..."`
        // slip through on a `python3` prefix.
        const predefinedCommands = flattenCommands(config.validation.commands)
        if (predefinedCommands.length === 0) {
          return {
            allowed: false,
            command: args.command,
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            canceled: false,
            durationMs: 0,
            rejectReason:
              (source === 'defaults'
                ? 'No iterate.config.yaml at project root — running on built-in defaults, which configure NO trusted validation commands. '
                : 'No validation.commands configured in iterate.config.yaml. ') +
              'Nothing can be validated until you define trusted commands in `validation.commands`.',
          }
        }
        if (!isCommandAllowed(args.command, predefinedCommands)) {
          return {
            allowed: false,
            command: args.command,
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            canceled: false,
            durationMs: 0,
            rejectReason:
              `Command must exactly match a command predefined in iterate.config.yaml validation.commands. ` +
              `Allowed commands: ${predefinedCommands.join(' | ')}`,
          }
        }

        const result = await (async (): Promise<RunCommandResult> => {
          try {
            return await runCommand(args.command, projectRoot, timeout, exec.signal)
          } catch (err) {
            // runCommand resolves its own start failures; this guard exists so
            // NO unexpected rejection can escape `execute` as an unhandled tool
            // crash (the tool contract is a structured result, always).
            return {
              command: args.command,
              exitCode: 1,
              stdout: '',
              stderr: String(err),
              timedOut: false,
              canceled: false,
              durationMs: 0,
              truncated: false,
              startError: String((err as Error)?.message ?? err),
            }
          }
        })()

        // exec() refused the command before it ever ran (e.g. a NUL byte in a
        // whitelisted command string): the command never started, so this is a
        // structured failure — exit 1 + a rejectReason naming the cause — not a
        // run that merely exited non-zero.
        if (result.startError !== undefined) {
          return {
            allowed: false,
            command: args.command,
            exitCode: 1,
            stdout: '',
            stderr: result.stderr,
            timedOut: false,
            canceled: false,
            durationMs: result.durationMs,
            rejectReason: `command failed to start: ${result.startError}`,
          }
        }
        if (result.truncated === true) {
          return {
            allowed: true,
            ...result,
            rejectReason: `command output exceeded the ${Math.round(DEFAULT_MAX_BUFFER / (1024 * 1024))} MB maxBuffer limit and was truncated`,
          }
        }
        return {
          allowed: true,
          ...result,
        }
      },
    }),
  )
}