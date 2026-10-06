/**
 * iterate-plugin — dsh plugin for the iterate autonomous closed-loop workflow
 *
 * Architecture:
 * - The plugin registers 17 tools (14 original + 3 v3.0 quality command center tools)
 *   Original: config, validate, decision-log, context, review, triage, fix, diff,
 *   rollback, checkpoint, status, history, prune, transcript
 *   v3.0: experience, quality_gate, defense_events
 * - The plugin injects a system prompt section teaching the iterate workflow pattern
 * - The model (prompted by the skill) writes a workflow script using dsh's `workflow` tool
 * - The workflow script uses `agent()` / `parallel()` / `phase()` / `log()` to orchestrate
 * - Subagents use the 17 tools to do real work (read config, run validation, log decisions,
 *   review, triage, apply/rollback/fixing, checkpoint, status, history, prune, transcript,
 *   query experience bank, check quality gates, query defense events)
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
 * - src/tools/        — 17 tool implementations (14 original + 3 v3.0)
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
import { registerExperienceBankTool } from "./tools/experience-bank.js";
import { registerQualityGateTool } from "./tools/quality-gate.js";
import { registerDefenseEventsTool } from "./tools/defense-events.js";
import { registerSessionHooks } from "./session-hooks.js";
import { registerLiveCapture } from "./live.js";
import { ITERATE_SKILL_PROMPT } from "./skill-prompt.js";
export const name = 'iterate-plugin';
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx) {
    // 0. Wire the SAFETY hooks BEFORE any tool is registered.
    //    Registration is a list of 17 independent calls; if one of them threw
    //    (duplicate name, malformed definition, hostile ctx) while the gate was
    //    registered last, the tools registered up to that point would keep
    //    running with NO `tools/pre-execute` approval gate — a fail-open hole
    //    created by load order. Registering the gate first means a partial load
    //    can only ever err on the side of MORE gating, never less.
    registerSessionHooks(ctx);
    registerLiveCapture(ctx);
    // 1. Register the 17 tools (14 original + 3 v3.0). Each registration is
    //    isolated: one failing tool must not take down the other 16, the gate
    //    above, or the prompt below (a partial plugin that still gates and
    //    teaches the workflow beats an aborted `apply`). Failures are logged,
    //    never swallowed silently.
    const toolRegistrations = [
        ['iterate_config', () => registerConfigTool(ctx)],
        ['iterate_validate', () => registerValidateTool(ctx)],
        ['iterate_decision_log', () => registerDecisionLogTool(ctx)],
        ['iterate_context', () => registerContextTool(ctx)],
        ['iterate_review', () => registerReviewTool(ctx)],
        ['iterate_triage', () => registerTriageTool(ctx)],
        ['iterate_fix', () => registerFixTool(ctx)],
        ['iterate_diff', () => registerDiffTool(ctx)],
        ['iterate_rollback', () => registerRollbackTool(ctx)],
        ['iterate_checkpoint', () => registerCheckpointTool(ctx)],
        ['iterate_status', () => registerStatusTool(ctx)],
        ['iterate_history', () => registerHistoryTool(ctx)],
        ['iterate_prune', () => registerPruneTool(ctx)],
        ['iterate_transcript', () => registerTranscriptTool(ctx)],
        // v3.0: Quality Command Center tools
        ['iterate_experience', () => registerExperienceBankTool(ctx)],
        ['iterate_quality_gate', () => registerQualityGateTool(ctx)],
        ['iterate_defense_events', () => registerDefenseEventsTool(ctx)],
    ];
    for (const [toolName, register] of toolRegistrations) {
        try {
            register();
        }
        catch (err) {
            console.warn(`[iterate] failed to register ${toolName}; continuing.`, err);
        }
    }
    // 2. Inject the iterate skill prompt as a system prompt section.
    //    This teaches the model how to write iterate workflow scripts using the
    //    tools. Guarded for the same reason as above: a prompt-injection failure
    //    must not undo a load that already wired the gate and the tools.
    try {
        ctx.systemPrompt.section({
            name: 'iterate-skill',
            order: 100,
            text: ITERATE_SKILL_PROMPT,
        });
    }
    catch (err) {
        console.warn('[iterate] failed to inject the skill prompt section; continuing.', err);
    }
}
