import { exec } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadEffectiveConfig, isCommandAllowed, flattenCommands, resolveProjectRootForExec, } from "../config-loader.js";
const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on a single validation command's runtime, so a model cannot
 *  pin the tool open indefinitely via an unbounded `timeout` argument. */
const MAX_TIMEOUT_MS = 600_000;
/**
 * Clamp a caller-supplied timeout (ms) to a sane range.
 * Non-finite / non-positive values fall back to the default; any value above
 * the ceiling is capped. Pure function, unit-tested.
 */
export function clampTimeout(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(ms, MAX_TIMEOUT_MS);
}
/**
 * Run a single shell command with timeout and return structured results.
 * Pure function (no side effects beyond the exec call).
 */
async function runCommand(command, cwd, timeoutMs) {
    const start = performance.now();
    return new Promise((resolve) => {
        exec(command, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024, // 10 MB
            env: { ...process.env, PAGER: 'cat' },
        }, (error, stdout, stderr) => {
            const durationMs = Math.round(performance.now() - start);
            // error.code is the exit code when the command ran; error.killed means timeout
            resolve({
                command,
                exitCode: error?.code ?? (error ? 1 : 0),
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                timedOut: error?.killed === true,
                durationMs,
            });
        });
    });
}
/**
 * Register the `iterate_validate` tool.
 * Runs validation commands defined in iterate.config.yaml `validation.commands`.
 * Enforces exact-match — a command not listed there (exactly) is rejected.
 */
export function registerValidateTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_validate',
        description: 'Run a validation command that is PRECONFIGURED in iterate.config.yaml `validation.commands`. ' +
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
        async execute(args, exec) {
            const resolved = resolveProjectRootForExec(exec, args.path);
            if (!resolved.ok) {
                return {
                    allowed: false,
                    command: args.command,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    durationMs: 0,
                    rejectReason: resolved.reason,
                };
            }
            const projectRoot = resolved.root;
            // Effective config = defaults merged with project overrides. Never null.
            const { config, source } = loadEffectiveConfig(projectRoot);
            const timeout = clampTimeout(args.timeout);
            // Only commands predefined in validation.commands may run — the
            // user trusts exactly these, and nothing else. This replaces the
            // old prefix-match whitelist, which let e.g. `python3 -c "..."`
            // slip through on a `python3` prefix.
            const predefinedCommands = flattenCommands(config.validation.commands);
            if (predefinedCommands.length === 0) {
                return {
                    allowed: false,
                    command: args.command,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    durationMs: 0,
                    rejectReason: (source === 'defaults'
                        ? 'No iterate.config.yaml at project root — running on built-in defaults, which configure NO trusted validation commands. '
                        : 'No validation.commands configured in iterate.config.yaml. ') +
                        'Nothing can be validated until you define trusted commands in `validation.commands`.',
                };
            }
            if (!isCommandAllowed(args.command, predefinedCommands)) {
                return {
                    allowed: false,
                    command: args.command,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    durationMs: 0,
                    rejectReason: `Command must exactly match a command predefined in iterate.config.yaml validation.commands. ` +
                        `Allowed commands: ${predefinedCommands.join(' | ')}`,
                };
            }
            const result = await runCommand(args.command, projectRoot, timeout);
            return {
                allowed: true,
                ...result,
            };
        },
    }));
}
