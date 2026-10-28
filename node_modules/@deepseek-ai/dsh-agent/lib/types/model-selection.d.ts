/** Agent-owned model selection, its durable projection, and scoped switch notices.
 * @module @deepseek-ai/dsh-agent/model-selection
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Model, AgentOptions } from './runtime-types.ts';
import type { ModelSelection } from './types.ts';
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
/**
 * Durable model-selection state for one Session. An effort the adapter
 * defaulted on a recorded request is omitted, so later requests resolve the
 * default again instead of pinning it as a choice.
 */
export interface ModelSelectionProjectionState {
    /** Selection used by the latest recorded model request. */
    readonly lastUsed: ModelSelection | null;
    /** Later recorded selection not yet used by a matching model request. */
    readonly pending: ModelSelection | null;
}
/**
 * Session selection fold: recorded selections become
 * the pending choice, and each request header retires a matching one.
 */
export declare const modelSelectionProjectionDefinition: Required<ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>>;
/**
 * Read and record one Agent's model choices without resolving adapter defaults.
 * @param readState - driver-owned reader for this Session's selection projection.
 * @param session - Session receiving durable model selections.
 * @param options - live route fallback until a selection or request is recorded.
 */
export declare class AgentModel implements Model {
    private readonly readState;
    private readonly session;
    private readonly options;
    constructor(readState: () => ModelSelectionProjectionState, session: Session, options: AgentOptions);
    current(): Readonly<ModelSelection> | undefined;
    select(selection: Readonly<ModelSelection>): void;
    private recordedSelection;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'model-selection': {
            kind: 'model-selection';
        } & ContextFormed;
    }
}
/**
 * Append a model-switch notice when the step's fixed route differs from the
 * last request header. Effort-only changes and empty no-request decisions add
 * no notice; a failure before header persistence repeats it on the next step.
 * Install in the selected Agent's unpublished setup scope.
 * @param agentCtx - The selected Agent's scoped context.
 * @returns Disposer for the scoped pre-step listener.
 */
export declare function installModelSelection(agentCtx: Context): () => void;
//# sourceMappingURL=model-selection.d.ts.map