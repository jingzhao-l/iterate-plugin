/**
 * src/approval-gate.ts — pure policy gate for destructive iterate tool calls.
 *
 * Feeds dsh's `tools/pre-execute` waterfall (registered in `session-hooks.ts`).
 * The gate classifies a tool execution and returns a typed decision without
 * any I/O, so it is fully unit-testable:
 *
 *   - `{ kind: 'allow' }`        → run the call.
 *   - `{ kind: 'ask', reason }`  → prompt the human via the dsh approval service.
 *   - `{ kind: 'deny', reason }` → refuse; the caller surfaces the reason.
 *
 * Policy (config `observatory.approval`, default 'ask'):
 *   - `allow` → destructive iterate calls always run (debug/trusted).
 *   - `deny`  → destructive iterate calls are always refused (fail-closed).
 *   - `ask`   → destructive iterate calls prompt the human first.
 *
 * Destructive calls are exactly the ones that mutate the workspace:
 * `iterate_fix` (writes files), `iterate_rollback` (restores from backups),
 * and `iterate_prune` with `dryRun !== true` (deletes `.iterate/` artifacts).
 * Read-only calls are always allowed. Non-iterate calls are untouched — the
 * gate only ever inspects iterate tools so it cannot alter unrelated behavior.
 */
/** Destructive iterate tools subject to the gate. */
const DESTRUCTIVE_TOOLS = new Set(['iterate_fix', 'iterate_rollback', 'iterate_prune']);
/** Human-readable reason rendered in the approval prompt. */
function describe(toolName, arguments0) {
    const file = arguments0 && typeof arguments0.file === 'string'
        ? `\`${arguments0.file}\``
        : 'the workspace';
    switch (toolName) {
        case 'iterate_fix':
            return `Apply an atomic fix to ${file}`;
        case 'iterate_rollback': {
            const id = arguments0 && typeof arguments0.id === 'string' ? ` \`${arguments0.id}\`` : '';
            return `Revert fix${id} (restore ${file} from backup)`;
        }
        case 'iterate_prune':
            return 'Delete stale `.iterate/` runtime artifacts';
        default:
            return `Run ${toolName}`;
    }
}
/**
 * Decide whether a tool execution may proceed under the given policy.
 * Returns `allow` for read-only prune (`dryRun: true`), for `allow`-policy
 * deployments, and for any non-iterate tool.
 */
export function decideApproval(execution, policy) {
    const name = typeof execution?.name === 'string' ? execution.name : '';
    if (!name)
        return { kind: 'allow' };
    if (!DESTRUCTIVE_TOOLS.has(name))
        return { kind: 'allow' };
    const rawArgs = execution.arguments;
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    // `iterate_prune` is read-only in its default dry-run mode — no gate needed.
    if (name === 'iterate_prune' && args.dryRun === false) {
        // falls through to the destructive path below
    }
    else if (name === 'iterate_prune') {
        return { kind: 'allow' };
    }
    if (policy === 'allow')
        return { kind: 'allow' };
    const reason = describe(name, args);
    if (policy === 'deny')
        return { kind: 'deny', reason };
    return { kind: 'ask', reason };
}
/** True when any destructive iterate tool is listed in a name set. */
export function isDestructiveIterateTool(name) {
    return typeof name === 'string' && DESTRUCTIVE_TOOLS.has(name);
}
/**
 * Evaluate an iterate tool's own boundary gate for a destructive call.
 * `approvedArg` is the caller-supplied `approved: true` flag (human consent
 * already obtained). Returns a run / refuse result without any I/O.
 */
export function toolGate(policy, execution, approvedArg) {
    const decision = decideApproval(execution, policy);
    if (decision.kind === 'allow')
        return { ok: true };
    if (decision.kind === 'deny') {
        return { ok: false, error: `Blocked by observatory approval policy: ${decision.reason}` };
    }
    // ask
    if (approvedArg === true)
        return { ok: true };
    return { ok: false, requiresApproval: true, reason: decision.reason };
}
