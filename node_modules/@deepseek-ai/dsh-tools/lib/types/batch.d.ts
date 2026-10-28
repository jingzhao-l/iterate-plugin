/**
 * Schedules one assistant step's tool calls. Exclusive calls form barriers;
 * parallel calls use a bounded rolling pool and are reclassified before start.
 * Dispatch may overlap, while policy, results, and result context remain
 * model-ordered. Abort or an internal scheduler failure stops replenishment
 * and drains started calls.
 *
 * Abort records synthetic error results for skipped calls so replay stays
 * valid. A terminal scheduler failure rejects after draining; the owning step
 * records conservative recovery results before closing.
 * @module dsh-tools/batch
 */
import type { ToolBatchInput, ToolBatchResult } from './executor.ts';
import type { ToolExecutionPipeline } from './pipeline.ts';
/**
 * Execute raw calls with ordered policy and results around overlapping tool bodies.
 * Abort drains started calls and synthesizes results for skipped calls. Internal
 * failures drain before rejecting with the already committed results and context.
 * @param input - raw calls, optional concurrency override, and optional Session owner.
 * @param pipeline - executor-owned invocation implementation.
 * @param maxParallel - reads the executor's current validated limit when input has no override.
 * @returns model-ordered outcomes after every started body has settled.
 * @throws RangeError when the explicit concurrency override is not a positive integer.
 */
export declare function executeToolBatch(input: ToolBatchInput, pipeline: ToolExecutionPipeline, maxParallel: () => number): Promise<ToolBatchResult>;
//# sourceMappingURL=batch.d.ts.map