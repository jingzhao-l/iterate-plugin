/**
 * src/session-hooks.ts — dsh pipeline hooks for the iterate observatory (F8).
 *
 * Wires the {@link decideApproval} policy gate to dsh's `tools/pre-execute`
 * waterfall. This is the AUTHORITATIVE approval seam for destructive iterate
 * tools (`iterate_fix` / `iterate_rollback` / `iterate_prune` with dryRun:false):
 *
 *   - `allow` policy      → the call runs.
 *   - `deny`  policy      → the call is refused (fail-closed), surfaced as an
 *                           error to the model.
 *   - `ask`   policy      → return `{ kind: 'ask', reason }`; dsh's own
 *                           scheduler routes it through the `approval` service
 *                           (see `@deepseek-ai/dsh-user-approval`), which
 *                           prompts the human and audits an approve/deny pair
 *                           on the session.
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

import { loadEffectiveConfig, resolveProjectRoot } from './config-loader.ts'
import { decideApproval, isDestructiveIterateTool } from './approval-gate.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'

/**
 * Build the per-call approval decision for a tool execution.
 * Returns a dsh `PreToolDecision` so the caller can short-circuit the caller.
 */
export function gateDecision(exec: ToolExecution): PreToolDecision {
  // Defensively read the tool name: an exec handed to the waterfall is an
  // ordinary object, but a hostile/proxied exec must degrade to "not our tool"
  // (allow) instead of throwing before classification. The gate only ever
  // inspects iterate tools, so an unreadable name also must not alter
  // unrelated tooling.
  let name = ''
  try {
    name = exec?.name ?? ''
  } catch {
    name = ''
  }
  if (!isDestructiveIterateTool(name)) return { kind: 'allow' }

  // Resolve the project root (use the call's own `path` arg, else the agent's
  // session cwd) to read the effective observatory policy.
  let argPath: string | undefined
  let sessionCwd: string | undefined
  try {
    const args = exec?.arguments
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const p = (args as Record<string, unknown>).path
      if (typeof p === 'string') argPath = p
    }
    sessionCwd = exec?.agent?.session?.header?.cwd
  } catch {
    // hostile/proxied exec — fall through with both undefined (defaults to ask)
  }
  const resolved = resolveProjectRoot(argPath, sessionCwd)
  let policy: 'ask' | 'deny' | 'allow' = 'ask'
  if (resolved.ok) {
    const { config } = loadEffectiveConfig(resolved.root)
    const p = config.observatory?.approval
    if (p === 'deny') policy = 'deny'
    else if (p === 'allow') policy = 'allow'
    // anything else (including a corrupt/missing `ask`) → 'ask'
  }

  const decision = decideApproval(exec, policy)
  if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
  if (decision.kind === 'ask') return { kind: 'ask', reason: decision.reason }
  return { kind: 'allow' }
}

/**
 * Register the `tools/pre-execute` waterfall listener that applies the
 * observatory approval gate to every destructive iterate tool call.
 */
export function registerSessionHooks(ctx: Context): void {
  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    // Fail-safe: a throwing gate must never fail OPEN. Degrade to `ask` so a
    // destructive call still routes through human consent instead of running
    // via `next()`'s allow default (matches the header's documented contract).
    let decision: PreToolDecision
    try {
      decision = gateDecision(exec)
    } catch (err) {
      console.warn('[iterate] approval gate failed; degrading to ask.', err)
      return Promise.resolve({
        kind: 'ask',
        reason: 'iterate approval gate unavailable — require consent',
      })
    }
    if (decision.kind === 'ask') {
      // Delegate the actual human-consent prompt + audit to dsh's approval
      // service via the scheduler's `ask` path. `next()` here would short-circuit
      // to allow, which would bypass consent — so return our ask decision.
      return Promise.resolve(decision)
    }
    if (decision.kind === 'deny') {
      return Promise.resolve(decision)
    }
    return next()
  })
}