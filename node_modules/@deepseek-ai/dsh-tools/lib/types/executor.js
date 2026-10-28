/** Model tool descriptions and complete batch execution owned by plugins. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** A drained batch failed internally; only the included results are committed. */
export class ToolBatchExecutionError extends Error {
    partial;
    constructor(cause, partial) {
        super('Tool batch execution failed', { cause });
        this.partial = partial;
        this.name = 'ToolBatchExecutionError';
    }
}
/** The selected provider is missing or unloaded; another provider must not take its calls. */
export class ToolExecutorUnavailableError extends HarnessError {
    constructor() {
        super('The selected tool executor is unavailable. Load an executor in this composition before running the agent.', 'TOOL_EXECUTOR_UNAVAILABLE');
        this.name = 'ToolExecutorUnavailableError';
    }
}
//# sourceMappingURL=executor.js.map