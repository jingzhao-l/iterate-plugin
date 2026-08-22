/**
 * iterate-plugin — dsh plugin for the iterate autonomous closed-loop workflow
 *
 * Architecture:
 * - The plugin registers 14 tools (config, validate, decision-log, context, review,
 *   triage, fix, diff, rollback, checkpoint, status, history, prune, transcript)
 * - The plugin injects a system prompt section teaching the iterate workflow pattern
 * - The model (prompted by the skill) writes a workflow script using dsh's `workflow` tool
 * - The workflow script uses `agent()` / `parallel()` / `phase()` / `log()` to orchestrate
 * - Subagents use the 14 tools to do real work (read config, run validation, log decisions,
 *   review, triage, apply/rollback/fixing, checkpoint, status, history, prune, transcript)
 * - A `tools/pre-execute` hook gates destructive iterate calls behind human approval
 *   (F8 observatory approval policy: ask / deny / allow).
 *
 * Tool invocation model:
 * - Workflow script CANNOT call tools directly (sandboxed vm, no Node API)
 * - Workflow script spawns subagents via `agent(prompt, opts)`
 * - Subagents are full agent sessions with access to all registered tools
 * - The script is pure orchestration: fan-out, aggregate, loop, stop
 *
 * Key files:
 * - src/index.ts      — Plugin entry: register tools + inject skill prompt
 * - src/tools/        — 13 tool implementations + meta-review/review engines
 * - src/config-loader.ts — YAML config loading
 * - src/types.ts     — Shared types
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerConfigTool } from './tools/config.ts'
import { registerValidateTool } from './tools/validate.ts'
import { registerDecisionLogTool } from './tools/decision-log.ts'
import { registerContextTool } from './tools/context.ts'
import { registerReviewTool } from './tools/review.ts'
import { registerTriageTool } from './tools/triage.ts'
import { registerFixTool, registerDiffTool, registerRollbackTool } from './tools/fix.ts'
import { registerCheckpointTool, registerStatusTool } from './tools/checkpoint.ts'
import { registerHistoryTool } from './tools/history.ts'
import { registerPruneTool } from './tools/prune.ts'
import { registerTranscriptTool } from './tools/transcript.ts'
import { registerSessionHooks } from './session-hooks.ts'
import { registerLiveCapture } from './live.ts'
import { ITERATE_SKILL_PROMPT } from './skill-prompt.ts'

export const name = 'iterate-plugin'
export const inject = ['tools', 'systemPrompt'] as const

export function apply(ctx: Context): void {
  // 1. Register the 14 tools
  registerConfigTool(ctx)
  registerValidateTool(ctx)
  registerDecisionLogTool(ctx)
  registerContextTool(ctx)
  registerReviewTool(ctx)
  registerTriageTool(ctx)
  registerFixTool(ctx)
  registerDiffTool(ctx)
  registerRollbackTool(ctx)
  registerCheckpointTool(ctx)
  registerStatusTool(ctx)
  registerHistoryTool(ctx)
  registerPruneTool(ctx)
  registerTranscriptTool(ctx)

  // 2. Wire the observatory approval gate onto dsh's tools/pre-execute waterfall,
  //    and the live reviewer-activity feed onto tools/result.
  registerSessionHooks(ctx)
  registerLiveCapture(ctx)

  // 2. Inject the iterate skill prompt as a system prompt section
  // This teaches the model how to write iterate workflow scripts using the tools.
  ctx.systemPrompt.section({
    name: 'iterate-skill',
    order: 100,
    text: ITERATE_SKILL_PROMPT,
  })
}