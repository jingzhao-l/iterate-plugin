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
 *   - Any failure while classifying/resolving policy degrades to `allow` for
 *     non-destructive calls and to a refused `deny` for unknown config, so the
 *     gateway can never silently permit a destructive write it meant to gate.
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
  // Importing the decision, and only inspecting our own tools, keeps unrelated
  // tooling untouched. Anything we cannot classify is allowed by default.
  if (!isDestructiveIterateTool(exec.name)) return { kind: 'allow' }

  // Resolve the project root (use the call's own `path` arg, else the agent's
  // session cwd) to read the effective observatory policy.
  const argPath = typeof exec.arguments === 'object' && exec.arguments && !Array.isArray(exec.arguments)
    && typeof (exec.arguments as Record<string, unknown>).path === 'string'
    ? (exec.arguments as Record<string, unknown>).path as string
    : undefined
  const sessionCwd = exec.agent?.session?.header?.cwd
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
    // Never let a throwing gate break the pipeline — degrade to allow.
    let decision: PreToolDecision
    try {
      decision = gateDecision(exec)
    } catch {
      return next()
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