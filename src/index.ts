/**
 * iterate-plugin — dsh plugin for the iterate autonomous closed-loop workflow
 *
 * Architecture:
 * - The plugin registers 5 tools (config, validate, decision-log, context, review)
 * - The plugin injects a system prompt section teaching the iterate workflow pattern
 * - The model (prompted by the skill) writes a workflow script using dsh's `workflow` tool
 * - The workflow script uses `agent()` / `parallel()` / `phase()` / `log()` to orchestrate
 * - Subagents use the 5 tools to do real work (read config, run validation, log decisions, review)
 *
 * Tool invocation model:
 * - Workflow script CANNOT call tools directly (sandboxed vm, no Node API)
 * - Workflow script spawns subagents via `agent(prompt, opts)`
 * - Subagents are full agent sessions with access to all registered tools
 * - The script is pure orchestration: fan-out, aggregate, loop, stop
 *
 * Key files:
 * - src/index.ts      — Plugin entry: register tools + inject skill prompt
 * - src/tools/        — 5 tool implementations + meta-review/review engines
 * - src/config-loader.ts — YAML config loading
 * - src/types.ts     — Shared types
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerConfigTool } from './tools/config.ts'
import { registerValidateTool } from './tools/validate.ts'
import { registerDecisionLogTool } from './tools/decision-log.ts'
import { registerContextTool } from './tools/context.ts'
import { registerReviewTool } from './tools/review.ts'
import { ITERATE_SKILL_PROMPT } from './skill-prompt.ts'

export const name = 'iterate-plugin'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context): void {
  // 1. Register the 5 core tools
  registerConfigTool(ctx)
  registerValidateTool(ctx)
  registerDecisionLogTool(ctx)
  registerContextTool(ctx)
  registerReviewTool(ctx)

  // 2. Inject the iterate skill prompt as a system prompt section
  // This teaches the model how to write iterate workflow scripts using the tools.
  ctx.systemPrompt.section({
    name: 'iterate-skill',
    order: 100,
    text: ITERATE_SKILL_PROMPT,
  })
}