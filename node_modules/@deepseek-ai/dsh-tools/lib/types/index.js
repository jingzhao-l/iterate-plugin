/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope';
import { ToolExecutorUnavailableError } from "./executor.js";
import "./events.js";
import { projectToolSchema } from "./schema.js";
import { assertSupportedJsonSchema } from "./json-schema.js";
import { RUN_CODE_NAME, ToolActivationError } from "./contracts.js";
/** One scope's complete tool-registry contribution. */
class ToolLayer {
    tools;
    restrictions = new AnonymousEntries();
    constructor(scope) {
        this.tools = new NamedEntries(name => new Error(scope === undefined
            ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
            : `tool "${name}" is already registered in this scope`));
    }
    /** Whether every contribution table in this aggregate layer is empty. */
    isEmpty() {
        return this.tools.isEmpty() && this.restrictions.isEmpty();
    }
    /** Whether every compiled restriction in this layer admits a global tool name. */
    admits(name) {
        for (const filter of this.restrictions.values()) {
            if ((filter.allow !== undefined && !filter.allow.has(name))
                || (filter.deny !== undefined && filter.deny.has(name)))
                return false;
        }
        return true;
    }
}
class GuardLayer {
    guards = new AnonymousEntries();
    isEmpty() { return this.guards.isEmpty(); }
}
/** Concrete tool registry and scoped executor dispatcher. */
export class ToolsService extends Service {
    static inject = ['systemPrompt'];
    static Config = z.object({
        mode: z.never().description('Removed. Mount a native or PTC tool executor instead.'),
        maxParallelSubCalls: z.never().description('Moved to the PTC tool executor configuration.'),
    });
    layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change'); });
    scoped = new WeakMap();
    root;
    guards = new ScopedLayers(() => new GuardLayer(), () => { });
    constructor(ctx) {
        super(ctx, 'tools');
        ctx.systemPrompt.tools(({ scope, toolSet }) => {
            const executor = this.selectExecutor(scope);
            const description = executor.describe(this.definitions(scope, toolSet));
            return { ...description, knownNames: description.knownNames ?? [...this.view(scope).knownNames] };
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
        if (output === undefined || typeof output !== 'object'
            || typeof output.render !== 'function'
            || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
            throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
        }
        assertSupportedJsonSchema(output.schema);
        const timeoutMs = definition.timeoutMs;
        if (timeoutMs !== undefined
            && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
        }
        // Reserved unconditionally: any agent may select a code mode for itself,
        // so a name free to take under the deployment default would become a
        // collision the moment a preset mounted.
        if (name === RUN_CODE_NAME) {
            throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
        }
        return this.layers.effect(this.ctx, layer => layer.tools.insert(name, { definition, when: options.when }), { label: 'tools.register()' });
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
        if (scope === undefined) {
            throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead');
        }
        const allow = filter.allow;
        const deny = filter.deny;
        if (allow === undefined && deny === undefined) {
            throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)');
        }
        const compiled = {
            ...allow !== undefined ? { allow: new Set(allow) } : {},
            ...deny !== undefined ? { deny: new Set(deny) } : {},
        };
        if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
            throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
        }
        const known = this.view(scope).restrictableNames;
        const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name));
        if (unknown.length > 0) {
            throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`);
        }
        return this.layers.effect(this.ctx, layer => layer.restrictions.append(compiled), { label: 'tools.restrict()' });
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
            if (layer === own)
                continue;
            for (const [name, registration] of layer.tools.entries())
                inherited.set(name, registration);
        }
        const visible = new Map();
        const registrations = new Map();
        const knownNames = new Set();
        const restrictableNames = new Set();
        for (const [name, registration] of inherited) {
            knownNames.add(name);
            restrictableNames.add(name);
            if (layers.every(layer => layer.admits(name))) {
                visible.set(name, registration.definition);
                registrations.set(name, registration);
            }
        }
        if (own !== undefined) {
            for (const [name, registration] of own.tools.entries()) {
                knownNames.add(name);
                visible.set(name, registration.definition);
                registrations.set(name, registration);
            }
        }
        return { visible, registrations, knownNames, restrictableNames };
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
        return toolSet === undefined ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name);
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
        if (toolSet !== undefined)
            return toolSet.view(scope).get(name);
        const view = this.view(scope);
        return view.registrations.get(name)?.when === undefined ? view.visible.get(name) : undefined;
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
        const admitted = new Map();
        for (const [name, definition] of view.visible) {
            const registration = view.registrations.get(name);
            let enabled;
            try {
                enabled = registration?.when === undefined || await registration.when(context);
            }
            catch (cause) {
                signal.throwIfAborted();
                throw new ToolActivationError(name, cause);
            }
            signal.throwIfAborted();
            if (enabled)
                admitted.set(name, definition);
        }
        let closed = false;
        return Object.freeze({
            dispose: () => { closed = true; },
            view: (scope) => {
                const visible = new Map();
                if (closed || scope !== agent)
                    return visible;
                const current = this.view(agent);
                for (const [name, definition] of admitted) {
                    if (current.visible.get(name) === definition
                        && current.registrations.get(name) === view.registrations.get(name)) {
                        visible.set(name, definition);
                    }
                }
                return visible;
            },
        });
    }
    /**
     * Read the visible capability definitions for descriptions and program bindings.
     * @param scope - viewing Agent or preset; omitted selects the global view.
     * @param toolSet - step admission; omit only to inspect registered definitions.
     * @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
     */
    definitions(scope, toolSet) {
        return toolSet === undefined ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()];
    }
    /**
     * Project visible definitions onto the allowlisted model-facing schema fields,
     * excluding execution and presentation callbacks.
     * @param scope - the viewing scope (the agent); omitted = the global view.
     * @param toolSet - step admission, or omitted for registered-definition inspection.
     * @returns one deep-cloned schema per visible tool.
     */
    schemas(scope, toolSet) {
        return this.definitions(scope, toolSet).map(definition => projectToolSchema(definition, true));
    }
    /**
     * Provide the executor for the calling scope; an unscoped contribution is the deployment default.
     * Rendering any executor-owned section requires the viewing scope's selection to remain available.
     * @param executor - initialized provider owned by the contributing plugin.
     * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
     */
    setExecutor(executor) {
        const scope = scopeOf(this.ctx);
        const existing = scope === undefined ? this.root : this.scoped.get(scope);
        if (existing?.executor !== undefined)
            throw new Error('Only one tool executor may be registered in each scope');
        const record = { executor };
        // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
        return this.ctx.effect(function* () {
            for (const section of executor.sections ?? []) {
                yield this.ctx.systemPrompt.section({
                    name: section.name,
                    order: section.order,
                    ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
                    text: ({ scope, toolSet }) => {
                        if (this.selectExecutor(scope) !== executor)
                            return '';
                        return typeof section.text === 'function' ? section.text(this.definitions(scope, toolSet)) : section.text;
                    },
                });
            }
            if (scope === undefined)
                this.root = record;
            else
                this.scoped.set(scope, record);
            yield () => {
                // Keep an unavailable selection so a program cannot fall through to a different executor.
                record.executor = undefined;
            };
        }.bind(this), 'tools.setExecutor()');
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
            if (record !== undefined)
                break;
        }
        record ??= this.root;
        const executor = record?.executor;
        if (executor === undefined)
            throw new ToolExecutorUnavailableError();
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
        return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' });
    }
    /**
     * Check global and inherited guards after pre-execute policy and approval resolve.
     * @param exec - invocation whose guards are checked before dispatch.
     * @returns the first denial reason, or undefined when no guard denies.
     */
    checkGuards(exec) {
        for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
            for (const guard of layer.guards.values()) {
                const reason = guard(exec);
                if (reason !== undefined)
                    return reason;
            }
        }
        return undefined;
    }
}
export default ToolsService;
export * from "./contracts.js";
export * from "./executor.js";
export * from "./schema.js";
export * from "./json-schema.js";
export * from "./presentation.js";
export { ToolsService as ToolRuntime };
//# sourceMappingURL=index.js.map