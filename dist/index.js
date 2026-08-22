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
import { registerConfigTool } from "./tools/config.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerDecisionLogTool } from "./tools/decision-log.js";
import { registerContextTool } from "./tools/context.js";
import { registerReviewTool } from "./tools/review.js";
import { registerTriageTool } from "./tools/triage.js";
import { registerFixTool, registerDiffTool, registerRollbackTool } from "./tools/fix.js";
import { registerCheckpointTool, registerStatusTool } from "./tools/checkpoint.js";
import { registerHistoryTool } from "./tools/history.js";
import { registerPruneTool } from "./tools/prune.js";
import { registerTranscriptTool } from "./tools/transcript.js";
import { registerSessionHooks } from "./session-hooks.js";
import { ITERATE_SKILL_PROMPT } from "./skill-prompt.js";
export const name = 'iterate-plugin';
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx) {
    // 1. Register the 14 tools
    registerConfigTool(ctx);
    registerValidateTool(ctx);
    registerDecisionLogTool(ctx);
    registerContextTool(ctx);
    registerReviewTool(ctx);
    registerTriageTool(ctx);
    registerFixTool(ctx);
    registerDiffTool(ctx);
    registerRollbackTool(ctx);
    registerCheckpointTool(ctx);
    registerStatusTool(ctx);
    registerHistoryTool(ctx);
    registerPruneTool(ctx);
    registerTranscriptTool(ctx);
    // 2. Wire the observatory approval gate onto dsh's tools/pre-execute waterfall.
    registerSessionHooks(ctx);
    // 2. Inject the iterate skill prompt as a system prompt section
    // This teaches the model how to write iterate workflow scripts using the tools.
    ctx.systemPrompt.section({
        name: 'iterate-skill',
        order: 100,
        text: ITERATE_SKILL_PROMPT,
    });
}
