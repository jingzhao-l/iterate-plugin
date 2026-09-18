/**
 * src/session-hooks.ts — dsh pipeline hooks for the iterate observatory (F8).
 *
 * Wires the {@link decideApproval} policy gate to dsh's `tools/pre-execute`
 * waterfall. This is the AUTHORITATIVE approval seam for destructive iterate
 * tools (`iterate_fix` / `iterate_rollback` / `iterate_prune` with dryRun:false):
 *
 *   - `allow` policy      → the call runs.
 *   - `deny`  policy      → the call is refused (fail-closed), surfaced as an
 *                           error to the model. Since dsh 0.1.6-alpha.1 the
 *                           denial carries a structured `info` (name
 *                           `iterate-approval-gate`, code `APPROVAL_DENIED`,
 *                           plus the human-readable reason) so durable
 *                           projections can route it distinctly from a normal
 *                           tool failure.
 *   - `ask`   policy      → return `{ kind: 'ask', reason }`; dsh's own
 *                           scheduler routes it through the `approval` service
 *                           (see `@deepseek-ai/dsh-user-approval`), which
 *                           prompts the human and audits an approve/deny pair
 *                           on the session.
 *   - canceled            → if the caller aborted the invocation before
 *                           dispatch, return `{ kind: 'cancel' }` (the
 *                           canonical 0.1.6-alpha.1 cancellation result) so a
 *                           destructive call never runs (or asks) for a dead
 *                           request.
 *
 * We deliberately do NOT also add `approved` flags inside the tool bodies:
 * the pre-execute waterfall consumes the human decision before the tool runs,
 * so a second tool-internal gate would double-ask. This one gate is enough and
 * stays dsh-native.
 *
 * Safety properties:
 *   - Read-only tools and non-iterate tools are always allowed (the gate only
 *     inspects the three destructive iterate toolnames).
 *   - If the project root / observatory config cannot be resolved, the policy
 *     degrades to `ask` (fail-safe: destructive writes always require consent).
 */
import { loadEffectiveConfig, resolveProjectRoot } from "./config-loader.js";
import { decideApproval, isDestructiveIterateTool } from "./approval-gate.js";
/** Structured error identity attached to policy denials (dsh 0.1.6-alpha.1:
 *  `deny.info` lets durable projections / retry / replay distinguish an
 *  approval-policy denial from a tool-thrown failure). */
const DENY_INFO = {
    name: 'iterate-approval-gate',
    code: 'APPROVAL_DENIED',
};
/**
 * Build the per-call approval decision for a tool execution.
 * Returns a dsh `PreToolDecision` so the caller can short-circuit the caller.
 */
export function gateDecision(exec) {
    // Defensively read the tool name: an exec handed to the waterfall is an
    // ordinary object, but a hostile/proxied exec must degrade to "not our tool"
    // (allow) instead of throwing before classification. The gate only ever
    // inspects iterate tools, so an unreadable name also must not alter
    // unrelated tooling.
    let name = '';
    try {
        name = exec?.name ?? '';
    }
    catch {
        name = '';
    }
    if (!isDestructiveIterateTool(name))
        return { kind: 'allow' };
    // dsh 0.1.6-alpha.1: if the caller already aborted this invocation before
    // dispatch, there is nothing to gate — select the canonical cancellation
    // result (`cancel`) rather than prompting a human for a dead call or running
    // `next()` (which would allow) on an aborted one.
    let signal;
    try {
        signal = exec.signal;
    }
    catch {
        signal = undefined;
    }
    if (signal && typeof signal.aborted === 'boolean' && signal.aborted) {
        return { kind: 'cancel' };
    }
    // Resolve the project root (use the call's own `path` arg, else the agent's
    // session cwd) to read the effective observatory policy.
    let argPath;
    let sessionCwd;
    try {
        const args = exec?.arguments;
        if (args && typeof args === 'object' && !Array.isArray(args)) {
            const p = args.path;
            if (typeof p === 'string')
                argPath = p;
        }
        sessionCwd = exec?.agent?.session?.header?.cwd;
    }
    catch {
        // hostile/proxied exec — fall through with both undefined (defaults to ask)
    }
    const resolved = resolveProjectRoot(argPath, sessionCwd);
    let policy = 'ask';
    if (resolved.ok) {
        const { config } = loadEffectiveConfig(resolved.root);
        const p = config.observatory?.approval;
        if (p === 'deny')
            policy = 'deny';
        else if (p === 'allow')
            policy = 'allow';
        // anything else (including a corrupt/missing `ask`) → 'ask'
    }
    const decision = decideApproval(exec, policy);
    if (decision.kind === 'deny') {
        return {
            kind: 'deny',
            reason: decision.reason,
            info: {
                ...DENY_INFO,
                // ToolErrorInfo.reason (0.1.6-alpha.1): raw user-facing detail kept in
                // durable state; the model-facing text still only sees `reason` above.
                reason: decision.reason,
            },
        };
    }
    if (decision.kind === 'ask')
        return { kind: 'ask', reason: decision.reason };
    return { kind: 'allow' };
}
/**
 * Register the `tools/pre-execute` waterfall listener that applies the
 * observatory approval gate to every destructive iterate tool call.
 */
export function registerSessionHooks(ctx) {
    ctx.on('tools/pre-execute', (exec, next) => {
        // Fail-safe: a throwing gate must never fail OPEN. Degrade to `ask` so a
        // destructive call still routes through human consent instead of running
        // via `next()`'s allow default (matches the header's documented contract).
        let decision;
        try {
            decision = gateDecision(exec);
        }
        catch (err) {
            console.warn('[iterate] approval gate failed; degrading to ask.', err);
            return Promise.resolve({
                kind: 'ask',
                reason: 'iterate approval gate unavailable — require consent',
            });
        }
        if (decision.kind === 'ask') {
            // Delegate the actual human-consent prompt + audit to dsh's approval
            // service via the scheduler's `ask` path. `next()` here would short-circuit
            // to allow, which would bypass consent — so return our ask decision.
            return Promise.resolve(decision);
        }
        if (decision.kind === 'deny' || decision.kind === 'cancel') {
            // deny: refuse the call. cancel: the caller already aborted this
            // invocation — selecting the canonical cancellation result instead of
            // letting `next()` allow it or prompting consent for a dead request.
            return Promise.resolve(decision);
        }
        return next();
    });
}
