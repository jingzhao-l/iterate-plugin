/** Shared pure fold of the Session's turn and step events. */
import type { TurnBoundaryProjection } from './types.ts';
import { z as zod } from 'zod';
/** Host projection of agent turn and step boundaries. */
export declare const turnBoundaryProjectionDefinition: {
    key: "turnBoundary";
    stateVersion: number;
    stateSchema: zod.ZodType<TurnBoundaryProjection, unknown, zod.core.$ZodTypeInternals<TurnBoundaryProjection, unknown>>;
    init: () => {
        openTurnStartSeq: null;
        lastStepStartSeq: null;
        lastStepBoundary: null;
        lastTurn: number;
    };
    apply: (state: NoInfer<TurnBoundaryProjection>, event: import("@deepseek-ai/dsh-session").SessionEvent) => TurnBoundaryProjection;
};
//# sourceMappingURL=projection.d.ts.map