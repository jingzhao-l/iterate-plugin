import { a as ToolNotFoundError, m as ToolBatchExecutionError, n as TOOL_ABORTED, o as ToolOutputError, p as validateJsonSchemaValue, r as TOOL_ABORTED_BEFORE_DISPATCH } from "./shared-DTdn5dXO.js";
import { scopeTarget } from "@deepseek-ai/dsh-scope";
import { HarnessError, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { assertNever, deepFreeze, snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
//#region lib/types/batch.js
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
async function executeToolBatch(input, pipeline, maxParallel) {
	const { calls: toolCalls, signal, agent, toolSet, maxParallelToolCalls } = input;
	if (maxParallelToolCalls !== void 0 && (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1)) throw new RangeError("maxParallelToolCalls must be a positive integer");
	const settlement = new BatchSettlement(input);
	try {
		const planned = toolCalls.map((block) => ({
			block,
			exec: {
				callId: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments),
				...agent === void 0 ? {} : { agent },
				...toolSet === void 0 ? {} : { toolSet },
				signal
			}
		}));
		let next = 0;
		let concluded = false;
		while (next < planned.length) {
			const first = planned[next];
			const mode = pipeline.executionMode(first.exec).kind;
			const group = mode === "parallel" ? planned.slice(next) : [first];
			const outcome = await runGroup(pipeline, settlement, maxParallelToolCalls ?? maxParallel(), group, mode, signal);
			next += outcome.consumed;
			concluded ||= outcome.concluded;
			if (outcome.aborted) {
				for (const call of planned.slice(next)) settlement.skip(call.block);
				return settlement.result(concluded);
			}
		}
		return settlement.result(concluded);
	} catch (error) {
		throw new ToolBatchExecutionError(error, settlement.result());
	}
}
/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw) {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch (_error) {
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
	const slots = group.map(() => void 0);
	const callSeqs = group.map(() => void 0);
	let nextToStart = 0;
	let committed = 0;
	let started = 0;
	let aborted = signal.aborted;
	let concluded = false;
	let schedulerFailure;
	const throwSchedulerFailure = () => {
		if (schedulerFailure !== void 0) throw schedulerFailure.error;
	};
	const commitReady = async () => {
		while (committed < group.length) {
			const slot = slots[committed];
			if (slot === void 0) break;
			const call = group[committed];
			const result = await pipeline.complete(slot.exec, slot);
			settlement.commit(call.block, result, callSeqs[committed]);
			concluded ||= result.concludesTurn === true;
			committed++;
		}
	};
	const inFlight = /* @__PURE__ */ new Map();
	const startCall = async (index) => {
		const call = group[index];
		callSeqs[index] = settlement.start(call.block);
		started++;
		const prepared = await pipeline.prepare(call.exec);
		throwSchedulerFailure();
		switch (prepared.kind) {
			case "dispatch": {
				const promise = pipeline.dispatch(prepared.exec).then((outcome) => {
					slots[index] = {
						...outcome,
						exec: prepared.exec
					};
					return index;
				}, (error) => {
					schedulerFailure ??= { error };
					return index;
				});
				inFlight.set(index, promise);
				break;
			}
			case "post-result":
			case "final-result":
				slots[index] = prepared;
				break;
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: assertNever(prepared, "tool-call scheduler prepare result");
		}
	};
	const fillPool = async () => {
		while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
			const nextCall = group[nextToStart];
			if (nextToStart > 0 && mode === "parallel" && pipeline.executionMode(nextCall.exec).kind !== "parallel") break;
			await startCall(nextToStart);
			nextToStart++;
			throwSchedulerFailure();
			await commitReady();
			throwSchedulerFailure();
			if (signal.aborted) aborted = true;
		}
	};
	try {
		await fillPool();
		while (inFlight.size > 0) {
			const settledIndex = await Promise.race(inFlight.values());
			inFlight.delete(settledIndex);
			throwSchedulerFailure();
			await commitReady();
			throwSchedulerFailure();
			if (signal.aborted) aborted = true;
			await fillPool();
		}
	} catch (error) {
		schedulerFailure ??= { error };
		await Promise.allSettled(inFlight.values());
		throw schedulerFailure.error;
	}
	if (aborted) {
		for (const call of group.slice(started)) settlement.skip(call.block);
		return {
			consumed: group.length,
			aborted: true,
			concluded
		};
	}
	/* v8 ignore next -- unreachable: a non-aborted group commits every started call */
	if (committed !== started) throw new Error("tool-call scheduler: uncommitted settled calls");
	return {
		consumed: started,
		aborted: false,
		concluded
	};
}
/** Collect committed results and optionally append their durable Session events. */
var BatchSettlement = class {
	input;
	results = [];
	contexts = [];
	constructor(input) {
		this.input = input;
	}
	start(block) {
		if (this.input.log === void 0) return void 0;
		const { agent, log: { turn, step } } = this.input;
		return agent.session.append("tool/call", {
			turn,
			step,
			callId: block.id,
			name: block.name,
			arguments: block.arguments
		}).seq;
	}
	commit(block, result, callSeq) {
		if (this.input.log !== void 0) {
			const { agent, log: { turn, step } } = this.input;
			agent.session.append("tool/result", {
				turn,
				step,
				message: createToolResultMessage({
					callId: block.id,
					content: result.content,
					isError: result.isError
				}),
				...result.error?.info ? { error: result.error.info } : {},
				...result.meta !== void 0 ? { meta: result.meta } : {}
			}, {
				surfaceOp: "append",
				sourceEventSeqs: [callSeq]
			});
		}
		this.results.push({
			callId: block.id,
			result
		});
		this.contexts.push(...result.additionalContexts ?? []);
	}
	skip(block) {
		this.commit(block, {
			content: [{
				type: "text",
				text: "Error: tool call aborted before dispatch"
			}],
			isError: true,
			error: {
				message: "tool call aborted before dispatch",
				info: {
					name: "AbortError",
					code: TOOL_ABORTED_BEFORE_DISPATCH
				}
			}
		}, this.start(block));
	}
	result(concluded = this.results.some(({ result }) => result.concludesTurn === true)) {
		return {
			results: this.results,
			additionalContexts: this.contexts,
			concluded
		};
	}
};
//#endregion
//#region lib/types/pipeline.js
/**
* Shared invocation stages for batch and program schedulers. Schedulers order
* prepare and complete calls while dispatch may overlap. Use executeToolBatch
* for complete calls, including a single-call batch.
*/
var ToolExecutionPipeline = class {
	ctx;
	source;
	tools;
	constructor(ctx, source = {}) {
		this.ctx = ctx;
		this.source = source;
		this.tools = ctx.tools;
	}
	get(name, scope, toolSet) {
		return this.source.get === void 0 ? this.tools.executable(name, scope, toolSet) : this.source.get(name, scope, toolSet);
	}
	resolveExecution(name, scope, nested, toolSet) {
		const tool = this.get(name, scope, toolSet);
		return tool !== void 0 && this.source.reject?.(name, nested) === void 0 ? tool : void 0;
	}
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	/** Execution-prepared content installed before post-execute policy. */
	contentProjectors = /* @__PURE__ */ new WeakMap();
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
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
		const visible = this.get(name, agent, exec.toolSet);
		const rejection = visible === void 0 ? void 0 : this.source.reject?.(name, parent !== void 0);
		const rejected = rejection !== void 0;
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...exec.toolSet !== void 0 ? { toolSet: exec.toolSet } : {},
			...parent !== void 0 ? { parent } : {},
			...exec.schema !== void 0 ? { schema: exec.schema } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const capturedProjector = visible?.projectContent?.bind(visible);
		const finalizerFor = () => rejected && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			if (!rejected) this.contentProjectors.set(execution, capturedProjector);
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (rejected) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(rejection)
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
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
		if (created.kind !== "ready") return created;
		const exec = created.exec;
		if (this.callerCancelled(exec)) return {
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		};
		try {
			const carrier = scopeTarget(this.tools, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return {
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			};
			if (decision.kind === "cancel") return {
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			};
			const denialReason = decision.kind === "allow" ? this.tools.checkGuards(exec) : decision.reason;
			const denialInfo = decision.kind === "deny" ? decision.info : void 0;
			if (denialReason !== void 0) return {
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: {
						message: denialReason,
						...denialInfo === void 0 ? {} : { info: denialInfo }
					}
				})
			};
			if (this.callerCancelled(exec)) return {
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			};
			return {
				kind: "dispatch",
				exec
			};
		} catch (error) {
			return {
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			};
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
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
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
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
			case "final-result": return this.finish(exec, outcome.result);
			case "post-result": break;
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(outcome, "scheduled tool outcome");
		}
		const { result } = outcome;
		try {
			const project = this.contentProjectors.get(exec);
			this.contentProjectors.delete(exec);
			const content = project?.(exec, result);
			const projected = content === void 0 ? result : this.markCanonical(exec, this.materializeFinalResult({
				...result,
				content
			}));
			const postResult = await this.postExecute(exec, projected);
			return this.finish(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
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
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${toolErrorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this.tools, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
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
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			...ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
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
		const decision = await this.ctx.waterfall(scopeTarget(this.tools, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${toolErrorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
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
function toolErrorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = toolErrorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
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
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
//#endregion
export { ToolExecutionPipeline, executeToolBatch, toolErrorMessage };
