import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRoot } from "../config-loader.js";
const LOG_DIR = '.iterate';
const LOG_FILE = 'decision-log.jsonl';
/**
 * Resolve the log file path, creating the directory if needed.
 */
function logPath(projectRoot) {
    const dir = join(projectRoot, LOG_DIR);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return join(dir, LOG_FILE);
}
/**
 * Append one entry to the decision log (JSONL format).
 * Returns the entry count after appending.
 */
export function appendDecisionEntry(projectRoot, entry) {
    const filePath = logPath(projectRoot);
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(filePath, line, 'utf-8');
    // Count entries
    let count = 0;
    try {
        const content = readFileSync(filePath, 'utf-8');
        count = content.split('\n').filter((l) => l.trim().length > 0).length;
    }
    catch {
        count = 1;
    }
    return { count, path: filePath };
}
/**
 * Read all entries from the decision log.
 */
export function readDecisionEntries(projectRoot) {
    const filePath = join(projectRoot, LOG_DIR, LOG_FILE);
    if (!existsSync(filePath))
        return [];
    try {
        const content = readFileSync(filePath, 'utf-8');
        return content
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l));
    }
    catch {
        return [];
    }
}
/**
 * Register the `iterate_decision_log` tool.
 * Append-only decision log stored in .iterate/decision-log.jsonl.
 * Supports `append` and `read` operations.
 */
export function registerDecisionLogTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_decision_log',
        description: 'Append-only decision log for the iterate loop. ' +
            'Use `append` to record a round start, review finding, fix, validation result, or decision. ' +
            'Use `read` to retrieve all entries for review. ' +
            'The log is stored in .iterate/decision-log.jsonl and persists across sessions.',
        parameters: {
            operation: {
                type: 'string',
                required: true,
                description: '"append" to add an entry, "read" to retrieve all entries.',
                enum: ['append', 'read'],
            },
            type: {
                type: 'string',
                description: 'Entry type (required for append): round_start, review_result, atomic_fix, ' +
                    'architectural_fix, revert, validation, decision, report.',
                enum: [
                    'round_start',
                    'review_result',
                    'atomic_fix',
                    'architectural_fix',
                    'revert',
                    'validation',
                    'decision',
                    'report',
                ],
            },
            round: {
                type: 'integer',
                description: 'Current iteration round number (required for append).',
            },
            data: {
                type: 'json',
                description: 'Entry payload as JSON object (required for append).',
            },
            path: {
                type: 'string',
                description: 'Project root directory (default: current working directory).',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    operation: { type: 'string', required: true },
                    entryCount: { type: 'integer' },
                    logPath: { type: 'string' },
                    entries: { type: 'json' },
                    success: { type: 'boolean' },
                    entry: { type: 'json' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(args) {
            const resolved = resolveProjectRoot(args.path);
            if (!resolved.ok) {
                return { operation: args.operation, error: resolved.reason };
            }
            const projectRoot = resolved.root;
            if (args.operation === 'read') {
                const entries = readDecisionEntries(projectRoot);
                return {
                    operation: 'read',
                    entryCount: entries.length,
                    logPath: join(projectRoot, LOG_DIR, LOG_FILE),
                    entries: entries,
                };
            }
            if (args.operation === 'append') {
                if (!args.type || !args.round) {
                    return {
                        operation: 'append',
                        error: 'type and round are required for append operation.',
                    };
                }
                const entry = {
                    timestamp: new Date().toISOString(),
                    round: args.round,
                    type: args.type,
                    data: args.data ?? {},
                };
                const result = appendDecisionEntry(projectRoot, entry);
                return {
                    operation: 'append',
                    success: true,
                    entryCount: result.count,
                    logPath: result.path,
                    entry: entry,
                };
            }
            return {
                operation: args.operation,
                error: `Unknown operation "${args.operation}". Use "append" or "read".`,
            };
        },
    }));
}
