/**
 * The decision kinds THIS plugin's own producers write.
 *
 * DISPLAY AND DOCUMENTATION ONLY — never a validity rule. Membership in this list
 * used to be the gate on `iterate_decision_log` appends, and it disagreed with the
 * Python harness's own list (which rejected `round_failed` and `resume` outright):
 * two shells, two closed sets, one shared ledger. The disagreement WAS the bug.
 * Validity is now the kernel's kind GRAMMAR (`DECISION_KIND_PATTERN`,
 * `^[a-z][a-z0-9_]{0,31}$`) — see `src/tools/decision-log.ts` `isDecisionKind` —
 * deliberately open so adding a kind does not need a kernel release, and so a kind
 * produced by either shell is readable by the other.
 */
export const KNOWN_DECISION_KINDS = [
    'round_start',
    'review_result',
    'atomic_fix',
    'architectural_fix',
    'revert',
    'validation',
    'decision',
    'report',
    'round_failed',
    'resume',
];
