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
import { ToolBatchExecutionError } from "./executor.js";
import { TOOL_ABORTED_BEFORE_DISPATCH } from "./contracts.js";
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { assertNever } from '@deepseek-ai/dsh-util-values';
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
export async function executeToolBatch(input, pipeline, maxParallel) {
    const { calls: toolCalls, signal, agent, toolSet, maxParallelToolCalls } = input;
    if (maxParallelToolCalls !== undefined && (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1)) {
        throw new RangeError('maxParallelToolCalls must be a positive integer');
    }
    const settlement = new BatchSettlement(input);
    try {
        // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
        const planned = toolCalls.map(block => ({
            block,
            exec: {
                callId: block.id,
                name: block.name,
                arguments: parseArguments(block.arguments),
                ...agent === undefined ? {} : { agent },
                ...toolSet === undefined ? {} : { toolSet },
                signal,
            },
        }));
        let next = 0;
        let concluded = false;
        while (next < planned.length) {
            // Commit before classifying again so registry changes affect unstarted calls.
            // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
            const first = planned[next];
            const mode = pipeline.executionMode(first.exec).kind;
            const group = mode === 'parallel' ? planned.slice(next) : [first];
            const outcome = await runGroup(pipeline, settlement, maxParallelToolCalls ?? maxParallel(), group, mode, signal);
            next += outcome.consumed;
            concluded ||= outcome.concluded;
            if (outcome.aborted) {
                for (const call of planned.slice(next))
                    settlement.skip(call.block);
                return settlement.result(concluded);
            }
        }
        return settlement.result(concluded);
    }
    catch (error) {
        throw new ToolBatchExecutionError(error, settlement.result());
    }
}
/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw) {
    try {
        return raw ? JSON.parse(raw) : {};
    }
    catch (_error) {
        // Preserve malformed model input for tool-owned argument diagnostics.
        return raw;
    }
}
/**
 * Run one exclusive barrier or parallel pool. Later calls are reclassified
 * before start; an exclusive reclassification waits for the current pool to
 * drain and remains for the caller's next barrier. Results and contexts commit
 * in model order. Abort stops starts, drains and commits started calls, accepts
 * their contexts into the owning batch, records results for skipped calls, and
 * returns an aborted outcome. Scheduler failure drains dispatches and rejects
 * for the owning step to record recovery results.
 */
async function runGroup(pipeline, settlement, maxParallelToolCalls, group, mode, signal) {
    const slots = group.map(() => undefined);
    // Started slots retain their `tool/call` seq so the result can cite it.
    const callSeqs = group.map(() => undefined);
    let nextToStart = 0;
    let committed = 0;
    let started = 0;
    let aborted = signal.aborted;
    let concluded = false;
    let schedulerFailure;
    const throwSchedulerFailure = () => {
        if (schedulerFailure !== undefined)
            throw schedulerFailure.error;
    };
    // `committed` advances only across contiguous model-order slots.
    const commitReady = async () => {
        while (committed < group.length) {
            const slot = slots[committed];
            if (slot === undefined)
                break;
            const call = group[committed];
            const result = await pipeline.complete(slot.exec, slot);
            // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
            settlement.commit(call.block, result, callSeqs[committed]);
            concluded ||= result.concludesTurn === true;
            committed++;
        }
    };
    const inFlight = new Map();
    const startCall = async (index) => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
        const call = group[index];
        callSeqs[index] = settlement.start(call.block);
        started++;
        const prepared = await pipeline.prepare(call.exec);
        throwSchedulerFailure();
        switch (prepared.kind) {
            case 'dispatch': {
                const promise = pipeline.dispatch(prepared.exec).then((outcome) => {
                    slots[index] = { ...outcome, exec: prepared.exec };
                    return index;
                }, (error) => {
                    schedulerFailure ??= { error };
                    return index;
                });
                inFlight.set(index, promise);
                break;
            }
            case 'post-result':
            case 'final-result':
                slots[index] = prepared;
                break;
            /* v8 ignore next -- closed-union exhaustiveness guard */
            default:
                assertNever(prepared, 'tool-call scheduler prepare result');
        }
    };
    const fillPool = async () => {
        while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
            // Re-read later modes after ordered commits so registry changes can create a barrier.
            // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
            const nextCall = group[nextToStart];
            if (nextToStart > 0 && mode === 'parallel'
                && pipeline.executionMode(nextCall.exec).kind !== 'parallel')
                break;
            await startCall(nextToStart);
            nextToStart++;
            throwSchedulerFailure();
            await commitReady();
            throwSchedulerFailure();
            // Abort may arrive while pre-execute awaits.
            if (signal.aborted)
                aborted = true;
        }
    };
    // Ordered pre-execute may await; only dispatch/body overlaps. A scheduler
    // failure stops new dispatches and reaches the turn boundary after every
    // already-started dispatch settles.
    try {
        await fillPool();
        while (inFlight.size > 0) {
            const settledIndex = await Promise.race(inFlight.values());
            inFlight.delete(settledIndex);
            throwSchedulerFailure();
            await commitReady();
            throwSchedulerFailure();
            // Abort may arrive while a tool or ordered commit awaits.
            if (signal.aborted)
                aborted = true;
            await fillPool();
        }
    }
    catch (error) {
        schedulerFailure ??= { error };
        await Promise.allSettled(inFlight.values());
        throw schedulerFailure.error;
    }
    if (aborted) {
        // Started calls and accepted context settle first; every remaining model
        // call then receives an ordered synthetic result before the turn aborts.
        for (const call of group.slice(started))
            settlement.skip(call.block);
        return { consumed: group.length, aborted: true, concluded };
    }
    /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
    if (committed !== started)
        throw new Error('tool-call scheduler: uncommitted settled calls');
    return { consumed: started, aborted: false, concluded };
}
/** Collect committed results and optionally append their durable Session events. */
class BatchSettlement {
    input;
    results = [];
    contexts = [];
    constructor(input) {
        this.input = input;
    }
    start(block) {
        if (this.input.log === undefined)
            return undefined;
        const { agent, log: { turn, step } } = this.input;
        // oxlint-disable-next-line typescript/no-non-null-assertion -- ToolBatchInput requires agent whenever log is provided
        return agent.session.append('tool/call', {
            turn, step, callId: block.id, name: block.name, arguments: block.arguments,
        }).seq;
    }
    commit(block, result, callSeq) {
        if (this.input.log !== undefined) {
            const { agent, log: { turn, step } } = this.input;
            // oxlint-disable-next-line typescript/no-non-null-assertion -- ToolBatchInput requires agent whenever log is provided
            agent.session.append('tool/result', {
                turn, step,
                message: createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError }),
                ...result.error?.info ? { error: result.error.info } : {},
                ...result.meta !== undefined ? { meta: result.meta } : {},
            }, {
                surfaceOp: 'append',
                // oxlint-disable-next-line typescript/no-non-null-assertion -- start records a call seq whenever this batch logs results
                sourceEventSeqs: [callSeq],
            });
        }
        this.results.push({ callId: block.id, result });
        this.contexts.push(...result.additionalContexts ?? []);
    }
    skip(block) {
        this.commit(block, {
            content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
            isError: true,
            error: {
                message: 'tool call aborted before dispatch',
                info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
            },
        }, this.start(block));
    }
    result(concluded = this.results.some(({ result }) => result.concludesTurn === true)) {
        return { results: this.results, additionalContexts: this.contexts, concluded };
    }
}
//# sourceMappingURL=batch.js.map