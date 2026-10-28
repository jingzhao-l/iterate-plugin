import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolNotFoundError, ToolOutputError } from "./contracts.js";
import { validateJsonSchemaValue } from "./json-schema.js";
/**
 * Shared invocation stages for batch and program schedulers. Schedulers order
 * prepare and complete calls while dispatch may overlap. Use executeToolBatch
 * for complete calls, including a single-call batch.
 */
export class ToolExecutionPipeline {
    ctx;
    source;
    tools;
    constructor(ctx, source = {}) {
        this.ctx = ctx;
        this.source = source;
        // Accepted calls retain their event subject while the service is withdrawn during shutdown.
        this.tools = ctx.tools;
    }
    get(name, scope, toolSet) {
        return this.source.get === undefined
            ? this.tools.executable(name, scope, toolSet)
            : this.source.get(name, scope, toolSet);
    }
    resolveExecution(name, scope, nested, toolSet) {
        const tool = this.get(name, scope, toolSet);
        return tool !== undefined && this.source.reject?.(name, nested) === undefined ? tool : undefined;
    }
    /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
    deferredContexts = new WeakMap();
    /** Executions whose tool body declared the current turn complete. */
    concludingExecutions = new WeakSet();
    /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
    cancellationStates = new WeakMap();
    /** Definition-owned final content transform snapshotted before policy begins. */
    contentFinalizers = new WeakMap();
    /** Execution-prepared content installed before post-execute policy. */
    contentProjectors = new WeakMap();
    /**
     * Classify a pending call through the caller's visible tool definition. Only
     * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
     * throwing classifiers are exclusive.
     * @param exec - call name, parsed arguments, and optional agent scope.
     * @returns the fail-closed scheduling mode.
     */
    executionMode(exec) {
        const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet);
        if (!tool?.isConcurrencySafe)
            return { kind: 'exclusive' };
        try {
            const concurrencySafe = tool.isConcurrencySafe(exec.arguments);
            return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' };
        }
        catch {
            return { kind: 'exclusive' };
        }
    }
    createExecution(exec) {
        const deferredContexts = [];
        const token = createExecutionToken();
        const callId = exec.callId;
        const rootCallId = exec.rootCallId ?? callId;
        const name = exec.name;
        const agent = exec.agent;
        const parent = exec.parent;
        const signal = exec.signal;
        // Executor refusals precede extensible policy; unknown tools retain dispatch-stage handling.
        const visible = this.get(name, agent, exec.toolSet);
        const rejection = visible === undefined ? undefined : this.source.reject?.(name, parent !== undefined);
        const rejected = rejection !== undefined;
        const concludingExecutions = this.concludingExecutions;
        const base = {
            token,
            callId,
            rootCallId,
            name,
            signal,
            ...agent !== undefined ? { agent } : {},
            ...exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {},
            ...parent !== undefined ? { parent } : {},
            ...exec.schema !== undefined ? { schema: exec.schema } : {},
            deferContext(context) {
                deferredContexts.push(context);
            },
            concludeTurn() {
                concludingExecutions.add(this);
            },
        };
        // Capture callbacks before argument getters run; rejected calls retain finalization only when aborted.
        const capturedFinalizer = visible?.finalizeContent?.bind(visible);
        const capturedProjector = visible?.projectContent?.bind(visible);
        const finalizerFor = () => rejected && !signal.aborted ? undefined : capturedFinalizer;
        try {
            const detached = snapshotJsonValue(exec.arguments);
            if (detached === undefined) {
                throw new TypeError('tool execution arguments must be losslessly JSON-serializable');
            }
            const execution = { ...base, arguments: deepFreeze(detached) };
            this.deferredContexts.set(execution, deferredContexts);
            this.contentFinalizers.set(execution, finalizerFor());
            if (!rejected)
                this.contentProjectors.set(execution, capturedProjector);
            this.cancellationStates.set(execution, {
                callerSignal: signal,
                bodyInvoked: false,
            });
            if (rejected) {
                // Cancellation takes precedence over an executor refusal.
                if (signal.aborted) {
                    return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() };
                }
                return {
                    kind: 'final-result',
                    exec: execution,
                    result: toolErrorResult(rejection),
                };
            }
            return { kind: 'ready', exec: execution };
        }
        catch (error) {
            const execution = { ...base, arguments: undefined };
            this.contentFinalizers.set(execution, finalizerFor());
            return { kind: 'final-result', exec: execution, result: toolErrorResult(error) };
        }
    }
    /**
     * Snapshot input, assign its correlation token, and run ordered pre-execute
     * policy and guards. Cancellation skips a body that has not started.
     * @param input - the caller-supplied execution input.
     * @returns the prepared execution plus the next scheduler stage.
     */
    async prepare(input) {
        const created = this.createExecution(input);
        if (created.kind !== 'ready')
            return created;
        const exec = created.exec;
        if (this.callerCancelled(exec)) {
            return { kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() };
        }
        try {
            const carrier = scopeTarget(this.tools, exec.agent);
            const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
            const askResolution = gate.kind === 'ask'
                ? await this.serviceAsk(exec, gate)
                : { decision: gate, approvalCancelled: false };
            const { decision } = askResolution;
            if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
                return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() };
            }
            if (decision.kind === 'cancel') {
                return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() };
            }
            const denialReason = decision.kind === 'allow' ? this.tools.checkGuards(exec) : decision.reason;
            const denialInfo = decision.kind === 'deny' ? decision.info : undefined;
            if (denialReason !== undefined) {
                return {
                    kind: 'post-result',
                    exec,
                    result: this.materializeFinalResult({
                        content: [{ type: 'text', text: `Error: ${denialReason}` }],
                        isError: true,
                        error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
                    }),
                };
            }
            if (this.callerCancelled(exec)) {
                return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() };
            }
            return { kind: 'dispatch', exec };
        }
        catch (error) {
            return { kind: 'final-result', exec, result: toolErrorResult(error) };
        }
    }
    /** Whether the original caller signal is currently aborted. */
    callerCancelled(exec) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        return state.callerSignal.aborted;
    }
    /** Canonical cancellation outcome selected by whether the tool body started. */
    cancellationResult(exec, prior) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        return state.bodyInvoked
            ? toolAbortedResult(prior)
            : toolAbortedBeforeDispatchResult(prior);
    }
    /**
     * Dispatch the registered body with the original caller signal fused back
     * into any around-wrapper replacement. Cancellation never abandons the body:
     * a started promise reaches quiescence before its outcome becomes `ABORTED`.
     */
    async dispatchToolBody(exec) {
        const state = this.cancellationStates.get(exec);
        /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
        if (state === undefined)
            throw new Error('tool registry scheduler invariant violated: missing cancellation state');
        const wrapperSignal = exec.signal;
        const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
        const signal = fused.signal;
        if (isAborted(signal)) {
            fused.dispose();
            return toolAbortedBeforeDispatchResult();
        }
        exec.signal = signal;
        try {
            const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet);
            if (!tool)
                throw new ToolNotFoundError(exec.name);
            state.bodyInvoked = true;
            const returned = await tool.execute(exec.arguments, exec);
            const result = this.createSuccessResult(exec, tool, returned);
            return isAborted(signal)
                ? toolAbortedResult(result)
                : result;
        }
        catch (error) {
            return toolErrorResult(error);
        }
        finally {
            fused.dispose();
            exec.signal = wrapperSignal;
        }
    }
    /**
     * Run around-dispatch and the tool body. Tool and unknown-tool failures still
     * receive post-execute; pipeline failures are already final. Started bodies
     * drain on cancellation before a successful outcome becomes `ABORTED`.
     * @param exec - the execution returned by this pipeline's prepare stage.
     * @returns whether the result still needs post-execute.
     */
    async dispatch(exec) {
        try {
            const mutableExec = exec;
            const carrier = scopeTarget(this.tools, exec.agent);
            const result = await this.ctx.waterfall(carrier, 'tools/execute', mutableExec, () => this.dispatchToolBody(mutableExec));
            const normalized = this.normalizeDispatchResult(exec, result);
            const deferredContexts = this.deferredContexts.get(exec);
            /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
            if (deferredContexts === undefined)
                throw new Error('tool registry scheduler invariant violated: unprepared execution');
            const resultWithDeferredContexts = deferredContexts.length === 0
                ? normalized
                : this.markCanonical(exec, {
                    ...normalized,
                    additionalContexts: [
                        ...deferredContexts,
                        ...normalized.additionalContexts ?? [],
                    ],
                });
            return {
                kind: 'post-result',
                result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
                    ? this.cancellationResult(exec, resultWithDeferredContexts)
                    : resultWithDeferredContexts,
            };
        }
        catch (error) {
            return { kind: 'final-result', result: toolErrorResult(error) };
        }
    }
    /**
     * Run post-execute when required, apply definition-owned content finalization,
     * and publish the lossless, frozen result. Policy and finalization failures
     * become error results. Cancellation replaces a successful outcome before
     * final materialization; tool-owned errors remain intact.
     * @param exec - the execution returned by this pipeline's prepare stage.
     * @param outcome - the preparation or dispatch result awaiting completion.
     * @returns the same materialized result delivered to final observers.
     */
    async complete(exec, outcome) {
        switch (outcome.kind) {
            case 'final-result':
                return this.finish(exec, outcome.result);
            case 'post-result':
                break;
            /* v8 ignore next -- closed-union exhaustiveness guard */
            default:
                return assertNever(outcome, 'scheduled tool outcome');
        }
        const { result } = outcome;
        try {
            const project = this.contentProjectors.get(exec);
            this.contentProjectors.delete(exec);
            const content = project?.(exec, result);
            const projected = content === undefined
                ? result
                : this.markCanonical(exec, this.materializeFinalResult({ ...result, content }));
            const postResult = await this.postExecute(exec, projected);
            return this.finish(exec, this.callerCancelled(exec) && !postResult.isError
                ? this.cancellationResult(exec, postResult)
                : postResult);
        }
        catch (error) {
            return this.finish(exec, toolErrorResult(error));
        }
    }
    /**
     * Materialize the candidate, apply definition-owned content finalization,
     * then materialize and notify the authoritative result.
     * @param exec - the prepared execution.
     * @param result - final result.
     * @returns the materialized final result.
     * @internal
     */
    finish(exec, result) {
        let materializedResult;
        try {
            materializedResult = this.materializeFinalResult(result);
        }
        catch (error) {
            materializedResult = this.materializeFinalResult(toolErrorResult(error));
        }
        let finalResult;
        try {
            finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
        }
        catch (error) {
            finalResult = this.materializeFinalResult(toolErrorResult(error));
        }
        this.notifyResult(exec, finalResult);
        return finalResult;
    }
    /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
    applyFinalContent(exec, result) {
        const finalizeContent = this.contentFinalizers.get(exec);
        if (finalizeContent === undefined)
            return result;
        const content = finalizeContent(exec, result);
        return content === undefined ? result : { ...result, content };
    }
    /** Notify observers without exposing a mutation or error channel into the outcome. */
    notifyResult(exec, result) {
        // Freeze the registry's live object before observers receive its readonly
        // WeakMap-keyable view.
        Object.freeze(exec);
        const { name: toolName, callId } = exec;
        const reportFailure = (error) => {
            this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${toolErrorMessage(error)}`);
        };
        const callbacks = this.ctx.events.dispatch('emit', [
            scopeTarget(this.tools, exec.agent), 'tools/result', exec, result,
        ]);
        for (const callback of callbacks) {
            try {
                const returned = callback(exec, result);
                void Promise.resolve(returned).catch(reportFailure);
            }
            catch (error) {
                reportFailure(error);
            }
        }
    }
    /**
     * Resolve an `ask` decision to allow/deny through the approval seam. The
     * seam is consumed opportunistically with `ctx.get('approval')` — a
     * deployment that composes no ApprovalService keeps the historical degrade
     * to deny, and an unmount mid-session degrades the same way on the next ask.
     * An agent-less execution also degrades: without an agent there is no
     * session to audit to and no UI to route to. Otherwise the outcome maps
     * one-to-one — `allowed-once` proceeds; the three non-grants deny with
     * distinct reasons so the model can tell a human "no" from an absent
     * approval channel.
     */
    async serviceAsk(exec, ask) {
        const approval = this.ctx.get('approval');
        if (approval === undefined) {
            return {
                decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
                approvalCancelled: false,
            };
        }
        if (exec.agent === undefined) {
            return {
                decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
                approvalCancelled: false,
            };
        }
        const outcome = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            callId: exec.callId,
            ...ask.reason !== undefined ? { reason: ask.reason } : {},
            ...ask.displayReason !== undefined ? { displayReason: ask.displayReason } : {},
            signal: exec.signal,
        });
        switch (outcome) {
            case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false };
            case 'rejected': return {
                decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
                approvalCancelled: false,
            };
            case 'cancelled': return {
                decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
                approvalCancelled: true,
            };
            case 'unavailable': return {
                decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
                approvalCancelled: false,
            };
            default: return assertNever(outcome, 'ApprovalOutcome');
        }
    }
    /**
     * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
     * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
     * `content` when given), `block` turns it into an `isError` whose content is
     * the corrective `feedback`. Either decision may attach `additionalContexts`,
     * which are ferried on the returned result for the loop's active-batch FIFO.
     * Context deferred by the tool body survives an accepted result but is
     * discarded when the outer call is blocked; a block exposes only context the
     * blocking decision explicitly supplied.
     * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
     */
    async postExecute(exec, result) {
        const decision = await this.ctx.waterfall(scopeTarget(this.tools, exec.agent), 'tools/post-execute', exec, result, () => Promise.resolve({ kind: 'accept' }));
        const decisionContexts = decision.additionalContexts ?? [];
        if (decision.kind === 'block') {
            const message = failureMessageFromContent(decision.feedback);
            return this.markCanonical(exec, {
                content: decision.feedback,
                isError: true,
                error: { message },
                ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
            });
        }
        if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
            throw new TypeError('tools/post-execute accept decision cannot replace both value and content');
        }
        const additionalContexts = [
            ...result.additionalContexts ?? [],
            ...decisionContexts,
        ];
        if (Object.hasOwn(decision, 'value')) {
            if (result.isError) {
                throw new TypeError('tools/post-execute cannot replace the value of a failed result');
            }
            const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet);
            if (tool === undefined)
                throw new ToolNotFoundError(exec.name);
            const replaced = this.createSuccessResult(exec, tool, decision.value);
            return this.markCanonical(exec, {
                ...replaced,
                ...additionalContexts.length > 0 ? { additionalContexts } : {},
            });
        }
        return this.markCanonical(exec, {
            ...result,
            ...decision.content !== undefined ? { content: decision.content } : {},
            ...additionalContexts.length > 0 ? { additionalContexts } : {},
        });
    }
    /** Registry-normalized results and the exact dispatch that validated each value. */
    canonicalResults = new WeakMap();
    /** Mark one registry-normalized result as canonical only for its owning dispatch. */
    markCanonical(exec, result) {
        this.canonicalResults.set(result, exec.token);
        return result;
    }
    /** Snapshot, validate, render, and optionally project one successful body value. */
    createSuccessResult(exec, tool, candidate) {
        const detached = snapshotToolValue(tool.name, candidate);
        const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
        if (violations.length > 0)
            throw new ToolOutputError(tool.name, violations);
        const value = deepFreeze(detached);
        let rendered;
        try {
            rendered = tool.output.render(exec.arguments, value);
        }
        catch (error) {
            throw projectionError(tool.name, 'render', error);
        }
        const content = snapshotProjection(tool.name, 'render', rendered);
        let meta;
        if (tool.output.presentationMeta !== undefined) {
            let projected;
            try {
                projected = tool.output.presentationMeta(exec.arguments, value);
            }
            catch (error) {
                throw projectionError(tool.name, 'presentationMeta', error);
            }
            meta = snapshotProjection(tool.name, 'presentationMeta', projected);
        }
        const concludesTurn = this.concludingExecutions.has(exec);
        return this.markCanonical(exec, this.materializeFinalResult({
            isError: false,
            value,
            content,
            ...meta !== undefined ? { meta } : {},
            ...concludesTurn ? { concludesTurn: true } : {},
        }));
    }
    /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
    normalizeDispatchResult(exec, result) {
        if (this.canonicalResults.get(result) === exec.token)
            return result;
        if (result.isError) {
            return this.markCanonical(exec, {
                isError: true,
                error: result.error,
                content: result.content,
                ...result.meta !== undefined ? { meta: result.meta } : {},
                ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
            });
        }
        const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet);
        if (tool === undefined)
            throw new ToolNotFoundError(exec.name);
        const normalized = this.createSuccessResult(exec, tool, result.value);
        return this.markCanonical(exec, {
            ...normalized,
            ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
        });
    }
    /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
    materializeFinalResult(result) {
        const presentation = {
            content: result.content,
            ...result.meta !== undefined ? { meta: result.meta } : {},
            ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
        };
        if (result.isError) {
            return materializePresentation({ isError: true, error: result.error, ...presentation });
        }
        const detached = materializePresentation({
            isError: false,
            ...presentation,
            ...result.concludesTurn === true ? { concludesTurn: true } : {},
        });
        return deepFreeze({ ...detached, value: result.value });
    }
}
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
    return new ToolOutputError(toolName, [`output.${projector} failed: ${toolErrorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
    try {
        const detached = snapshotJsonValue(candidate);
        if (detached === undefined) {
            throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
        }
        return detached;
    }
    catch (error) {
        if (error instanceof ToolOutputError)
            throw error;
        throw projectionError(toolName, projector, error);
    }
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
    try {
        const detached = snapshotJsonValue(candidate);
        if (detached === undefined)
            throw new ToolOutputError(toolName, ['value is not lossless JSON']);
        return detached;
    }
    catch (error) {
        if (error instanceof ToolOutputError)
            throw error;
        throw new ToolOutputError(toolName, [`value snapshot failed: ${toolErrorMessage(error)}`]);
    }
}
/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - thrown value from a tool or policy callback.
 * @returns a printable failure message, including for hostile thrown values.
 */
export function toolErrorMessage(error) {
    try {
        if (error instanceof Error)
            return error.message;
        if (typeof error === 'object' && error !== null
            && 'message' in error && typeof error.message === 'string') {
            return error.message;
        }
        return String(error);
    }
    catch {
        // A hostile thrown value can trap `instanceof`, property access, or string
        // coercion. Error normalization is the outermost safety boundary, so its
        // fallback must itself be total.
        return '<unprintable thrown value>';
    }
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
    const text = content
        .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
        .join('\n');
    return text.length > 0 ? text : 'tool result blocked by post-execute policy';
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
    const detached = snapshotJsonValue(candidate);
    if (detached === undefined) {
        throw new TypeError('tool result must be losslessly JSON-serializable');
    }
    return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
    try {
        return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined;
    }
    catch {
        return undefined;
    }
}
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
    return Symbol('dsh.tool.execution');
}
function toolErrorResult(error) {
    const info = errorInfo(error);
    const message = toolErrorMessage(error);
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
        error: { message, ...info ? { info } : {} },
    };
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
    return signal.aborted;
}
/**
 * Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
 * Keeping the relay dispatch-scoped also removes listeners when work settles.
 */
function fuseToolSignals(caller, wrapper) {
    if (caller === wrapper)
        return { signal: caller, dispose() { } };
    const controller = new AbortController();
    let listening = false;
    const dispose = () => {
        if (!listening)
            return;
        listening = false;
        caller.removeEventListener('abort', abortFromCaller);
        wrapper.removeEventListener('abort', abortFromWrapper);
    };
    const abortFrom = (source) => {
        const reason = source.reason;
        controller.abort(reason);
        dispose();
    };
    const abortFromCaller = () => { abortFrom(caller); };
    const abortFromWrapper = () => { abortFrom(wrapper); };
    if (wrapper.aborted)
        abortFromWrapper();
    else if (caller.aborted)
        abortFromCaller();
    else {
        listening = true;
        caller.addEventListener('abort', abortFromCaller, { once: true });
        wrapper.addEventListener('abort', abortFromWrapper, { once: true });
    }
    return { signal: controller.signal, dispose };
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
    const additionalContexts = prior?.additionalContexts ?? [];
    return {
        content: [{ type: 'text', text: 'Error: tool call aborted' }],
        isError: true,
        error: {
            message: 'tool call aborted',
            info: { name: 'AbortError', code: TOOL_ABORTED },
        },
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
    };
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
    const additionalContexts = prior?.additionalContexts ?? [];
    return {
        content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
        isError: true,
        error: {
            message: 'tool call aborted before dispatch',
            info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
        },
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
    };
}
export { executeToolBatch } from "./batch.js";
//# sourceMappingURL=pipeline.js.map