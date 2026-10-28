import { a as ToolNotFoundError, c as assertObjectJsonSchema, d as isPlainJsonArray, f as isPlainJsonRecord, h as ToolExecutorUnavailableError, i as ToolActivationError, l as assertSupportedJsonSchema, m as ToolBatchExecutionError, n as TOOL_ABORTED, o as ToolOutputError, p as validateJsonSchemaValue, r as TOOL_ABORTED_BEFORE_DISPATCH, s as JsonSchemaError, t as RUN_CODE_NAME, u as isJsonSchemaRecord } from "./shared-DTdn5dXO.js";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
//#region lib/types/schema.js
/** Unified JSON-value schema DSL, inference, compilation, and tool definition helpers. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of":
			destination.target[destination.index] = node;
			break;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Validate model-generated arguments against an implicit parameter schema.
* @param spec - declared parameter schema.
* @param args - candidate arguments, however malformed.
* @returns Path-qualified violations; empty means valid.
*/
function validateArgs(spec, args) {
	return validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, "");
}
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userProjectContent = options.projectContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* Omit execution and presentation callbacks from a tool definition.
* @param definition - visible capability or executor-owned transport.
* @param detachParameters - copy parameters for a caller-owned inspection result.
* @returns the model-facing schema fields.
*/
function projectToolSchema(definition, detachParameters) {
	const { name, description, parameters, deferLoading } = definition;
	const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
	if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
	return {
		name,
		description,
		parameters: detached,
		...deferLoading === true ? { deferLoading } : {}
	};
}
//#endregion
//#region lib/types/index.js
/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty();
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
};
var GuardLayer = class {
	guards = new AnonymousEntries();
	isEmpty() {
		return this.guards.isEmpty();
	}
};
/** Concrete tool registry and scoped executor dispatcher. */
var ToolsService = class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.never().description("Removed. Mount a native or PTC tool executor instead."),
		maxParallelSubCalls: z.never().description("Moved to the PTC tool executor configuration.")
	});
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	scoped = /* @__PURE__ */ new WeakMap();
	root;
	guards = new ScopedLayers(() => new GuardLayer(), () => {});
	constructor(ctx) {
		super(ctx, "tools");
		ctx.systemPrompt.tools(({ scope, toolSet }) => {
			const description = this.selectExecutor(scope).describe(this.definitions(scope, toolSet));
			return {
				...description,
				knownNames: description.knownNames ?? [...this.view(scope).knownNames]
			};
		});
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @param options - optional step-time activation condition.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition, options = {}) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {
			definition,
			when: options.when
		}), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Resolve visible tools and pre-restriction names. Restrictions across the
	* scope chain intersect over inherited global and ancestor tools; the viewing
	* scope's own registrations remain exempt. Nearer registrations shadow
	* farther ones. Pre-restriction names support restriction and prompt-order validation.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration);
		}
		const visible = /* @__PURE__ */ new Map();
		const registrations = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, registration] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) {
				visible.set(name, registration.definition);
				registrations.set(name, registration);
			}
		}
		if (own !== void 0) for (const [name, registration] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, registration.definition);
			registrations.set(name, registration);
		}
		return {
			visible,
			registrations,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope, toolSet) {
		return toolSet === void 0 ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name);
	}
	/**
	* Resolve the definition a call may execute. With a step's admitted set, the
	* set decides; without one, conditional registrations are unavailable.
	* @param name - the tool name as registered.
	* @param scope - the calling agent; omitted = the global view.
	* @param toolSet - step admission, or omitted for a call outside a model step.
	* @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
	*/
	executable(name, scope, toolSet) {
		if (toolSet !== void 0) return toolSet.view(scope).get(name);
		const view = this.view(scope);
		return view.registrations.get(name)?.when === void 0 ? view.visible.get(name) : void 0;
	}
	/**
	* Resolve conditions once for this step without changing shared registrations.
	* Cancellation or a rejected condition publishes no partial selection. Removed
	* registrations cannot be restored by a late condition result.
	* @param context - preparing agent, captured model selection, and cancellation.
	* @returns the complete selection; the caller disposes it after its tool batch settles.
	*/
	async resolve(context) {
		const { agent, signal } = context;
		signal.throwIfAborted();
		const view = this.view(agent);
		const admitted = /* @__PURE__ */ new Map();
		for (const [name, definition] of view.visible) {
			const registration = view.registrations.get(name);
			let enabled;
			try {
				enabled = registration?.when === void 0 || await registration.when(context);
			} catch (cause) {
				signal.throwIfAborted();
				throw new ToolActivationError(name, cause);
			}
			signal.throwIfAborted();
			if (enabled) admitted.set(name, definition);
		}
		let closed = false;
		return Object.freeze({
			dispose: () => {
				closed = true;
			},
			view: (scope) => {
				const visible = /* @__PURE__ */ new Map();
				if (closed || scope !== agent) return visible;
				const current = this.view(agent);
				for (const [name, definition] of admitted) if (current.visible.get(name) === definition && current.registrations.get(name) === view.registrations.get(name)) visible.set(name, definition);
				return visible;
			}
		});
	}
	/**
	* Read the visible capability definitions for descriptions and program bindings.
	* @param scope - viewing Agent or preset; omitted selects the global view.
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
	*/
	definitions(scope, toolSet) {
		return toolSet === void 0 ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()];
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param toolSet - step admission, or omitted for registered-definition inspection.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope, toolSet) {
		return this.definitions(scope, toolSet).map((definition) => projectToolSchema(definition, true));
	}
	/**
	* Provide the executor for the calling scope; an unscoped contribution is the deployment default.
	* Rendering any executor-owned section requires the viewing scope's selection to remain available.
	* @param executor - initialized provider owned by the contributing plugin.
	* @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
	*/
	setExecutor(executor) {
		const scope = scopeOf(this.ctx);
		if ((scope === void 0 ? this.root : this.scoped.get(scope))?.executor !== void 0) throw new Error("Only one tool executor may be registered in each scope");
		const record = { executor };
		return this.ctx.effect(function* () {
			for (const section of executor.sections ?? []) yield this.ctx.systemPrompt.section({
				name: section.name,
				order: section.order,
				...section.interpolate === void 0 ? {} : { interpolate: section.interpolate },
				text: ({ scope, toolSet }) => {
					if (this.selectExecutor(scope) !== executor) return "";
					return typeof section.text === "function" ? section.text(this.definitions(scope, toolSet)) : section.text;
				}
			});
			if (scope === void 0) this.root = record;
			else this.scoped.set(scope, record);
			yield () => {
				record.executor = void 0;
			};
		}.bind(this), "tools.setExecutor()");
	}
	/**
	* Resolve the nearest scoped provider, or the deployment default.
	* @param scope - Agent or preset scope; omitted selects only the root contribution.
	* @returns the selected executor; throws when it is missing or unloaded.
	*/
	selectExecutor(scope) {
		let record;
		for (const key of scopeChainOf(scope)) {
			record = this.scoped.get(key);
			if (record !== void 0) break;
		}
		record ??= this.root;
		const executor = record?.executor;
		if (executor === void 0) throw new ToolExecutorUnavailableError();
		return executor;
	}
	/**
	* Delegate a raw call batch to its Agent's provider or the deployment default.
	* Select at dispatch; accepted batches settle through that provider even if it unloads.
	* @param input - original calls, optional owning Agent, and optional logging step.
	* @returns the selected executor's settled batch; unavailable selections reject.
	*/
	async execute(input) {
		return this.selectExecutor(input.agent).execute(input);
	}
	/**
	* Register a monotonic denial in the calling scope.
	* @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
	* @returns the effect disposer that removes this guard.
	*/
	guard(guard) {
		return this.guards.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()" });
	}
	/**
	* Check global and inherited guards after pre-execute policy and approval resolve.
	* @param exec - invocation whose guards are checked before dispatch.
	* @returns the first denial reason, or undefined when no guard denies.
	*/
	checkGuards(exec) {
		for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) for (const guard of layer.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
//#endregion
export { JsonSchemaError, RUN_CODE_NAME, TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolActivationError, ToolArgsError, ToolBatchExecutionError, ToolExecutorUnavailableError, ToolNotFoundError, ToolOutputError, ToolsService as ToolRuntime, ToolsService, ToolsService as default, assertObjectJsonSchema, assertSupportedJsonSchema, defineTool, isJsonSchemaRecord, isPlainJsonArray, isPlainJsonRecord, parameterSchemaSpecToJsonSchema, projectToolSchema, validateArgs, validateJsonSchemaValue, valueSchemaSpecToJsonSchema };
