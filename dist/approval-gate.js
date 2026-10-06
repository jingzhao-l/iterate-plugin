/**
 * src/approval-gate.ts — pure policy gate for destructive iterate tool calls.
 *
 * Feeds dsh's `tools/pre-execute` waterfall (registered in `session-hooks.ts`).
 * The gate classifies a tool execution and returns a typed decision without
 * any I/O, so it is fully unit-testable:
 *
 *   - `{ kind: 'allow' }`        → run the call.
 *   - `{ kind: 'ask', reason, displayReason }` → prompt the human via the dsh
 *     approval service (`displayReason` carries the localized prompt text;
 *     dsh 0.2.x renders it when present).
 *   - `{ kind: 'deny', reason }` → refuse; the caller surfaces the reason.
 *
 * LANGUAGE RULE (project `config.language`, zh|en):
 *   - Human-facing text (the `ask` prompt / `displayReason`) FOLLOWS the
 *     configured language.
 *   - Structured/durable text (the `deny` reason, `deny.info.reason`,
 *     decision-log and console output) STAYS ENGLISH so logs, audits, and
 *     machine matchers never depend on a locale. `ask.reason` is the audited
 *     English summary; `displayReason` is the localized prompt.
 *
 * Policy (config `observatory.approval`, default 'ask'):
 *   - `allow` → destructive iterate calls always run (debug/trusted).
 *   - `deny`  → destructive iterate calls are always refused (fail-closed).
 *   - `ask`   → destructive iterate calls prompt the human first.
 *
 * Destructive calls are exactly the ones that mutate the workspace:
 * `iterate_fix` (writes files), `iterate_rollback` (restores from backups),
 * `iterate_prune` with `dryRun === false` (deletes `.iterate/` artifacts —
 * prune is read-only by default, so only an explicit `dryRun: false` gates),
 * and `iterate_config` with `operation === 'write'` (rewrites
 * `iterate.config.yaml`). `iterate_config` writes matter because the config
 * is policy: a silent `reviewer: {evidence_validation: false}` or a
 * `validation.commands` addition changes what later rounds are allowed to do,
 * so a write is consented to exactly like a file write — the read operation
 * stays free.
 * Read-only calls are always allowed. Non-iterate calls are untouched — the
 * gate only ever inspects iterate tools so it cannot alter unrelated behavior.
 */
/** Iterate tools subject to the gate (some only in specific operations). */
const DESTRUCTIVE_TOOLS = new Set([
    'iterate_fix',
    'iterate_rollback',
    'iterate_prune',
    'iterate_config',
]);
/**
 * True when this specific call MUTATES the workspace and therefore needs
 * consent. Two of the four gated tools are operation-conditional:
 *   - `iterate_prune` is read-only unless `dryRun === false`;
 *   - `iterate_config` reads freely, but `operation === 'write'` rewrites
 *     `iterate.config.yaml` — the file that carries the approval policy,
 *     the reviewer gates, and the command allow-list.
 */
function mutatesWorkspace(toolName, args) {
    if (toolName === 'iterate_prune')
        return args.dryRun === false;
    if (toolName === 'iterate_config')
        return args.operation === 'write';
    return DESTRUCTIVE_TOOLS.has(toolName);
}
/** Config updates the model supplied (empty when absent/malformed). */
function readUpdates(args) {
    const u = args.updates;
    return u && typeof u === 'object' && !Array.isArray(u) ? u : {};
}
/**
 * Config switches that DISABLE a safety gate, for the consent text. Writing
 * `reviewer.evidence_validation: false` is legal config — but the human being
 * asked must see that the call is about to turn a review gate off, not just
 * "update a file".
 */
function disabledReviewGates(updates) {
    const rv = updates.reviewer;
    if (!rv || typeof rv !== 'object' || Array.isArray(rv))
        return [];
    const off = [];
    for (const key of ['output_schema_validation', 'evidence_validation', 'coverage_validation']) {
        if (rv[key] === false)
            off.push(`reviewer.${key}`);
    }
    return off;
}
/**
 * Human-readable reason rendered in the approval prompt.
 *
 * `language` selects the wording of the HUMAN-FACING text; call it with
 * `'en'` for the structured, machine-readable string (deny reasons, audited
 * ask summaries) and with the project's configured language for the prompt
 * text (`displayReason`). The structured deny reason therefore never
 * localizes, while the consent prompt follows `config.language`.
 */
export function describe(toolName, arguments0, language = 'en') {
    const zh = language === 'zh';
    const file = arguments0 && typeof arguments0.file === 'string'
        ? `\`${arguments0.file}\``
        : zh
            ? '工作区'
            : 'the workspace';
    switch (toolName) {
        case 'iterate_fix':
            return zh
                ? `对 ${file} 应用一次原子修复`
                : `Apply an atomic fix to ${file}`;
        case 'iterate_rollback': {
            // Rollback's parameters are `id` (required) + `path` (project root) —
            // it has NO `file` param, so naming `arguments.file` could never
            // identify the target ("restore the workspace from backup" every time).
            // Name the fix id and, when present, the project scope instead.
            const id = arguments0 && typeof arguments0.id === 'string' && arguments0.id
                ? `\`${arguments0.id}\``
                : null;
            const scope = arguments0 && typeof arguments0.path === 'string' && arguments0.path
                ? `\`${arguments0.path}\``
                : null;
            const target = id ?? scope ?? (zh ? '一次修复' : 'a fix');
            const inScope = id && scope ? (zh ? `（位于 ${scope}）` : ` in ${scope}`) : '';
            return zh
                ? `回滚修复 ${target}${inScope}（从备份恢复其文件）`
                : `Revert fix ${target}${inScope} (restore its file from backup)`;
        }
        case 'iterate_prune':
            return zh
                ? '删除过期的 `.iterate/` 运行时产物'
                : 'Delete stale `.iterate/` runtime artifacts';
        case 'iterate_config': {
            // Name WHAT is being written and shout when the write disables a review
            // gate — the consent prompt is the last human look before the model
            // rewrites the policy file. The WARNING marker stays literal in both
            // languages so the UI's highlight rule matches on it.
            const updates = readUpdates(arguments0 ?? {});
            const keys = Object.keys(updates);
            const scope = keys.length > 0 ? keys.map((k) => `\`${k}\``).join(', ') : (zh ? '配置' : 'the configuration');
            const base = zh
                ? `更新 \`iterate.config.yaml\`（${scope}）`
                : `Update \`iterate.config.yaml\` (${scope})`;
            const off = disabledReviewGates(updates);
            if (off.length === 0)
                return base;
            return zh
                ? `${base} — WARNING：将关闭 ${off.join(', ')}`
                : `${base} — WARNING: turns OFF ${off.join(', ')}`;
        }
        default:
            return zh ? `运行 ${toolName}` : `Run ${toolName}`;
    }
}
/**
 * Decide whether a tool execution may proceed under the given policy.
 * Returns `allow` for read-only prune (`dryRun: true`), for config READS
 * (`iterate_config` without `operation: 'write'`), for `allow`-policy
 * deployments, and for any non-iterate tool.
 *
 * `language` only affects the HUMAN-FACING `ask.displayReason` text; the
 * audited `ask.reason` and the `deny.reason` stay English (see header).
 */
export function decideApproval(execution, policy, language = 'en') {
    // Defensive reads: a hostile/proxied execution object must degrade to "not
    // our tool" (allow) rather than throw inside the gate.
    let name = '';
    try {
        name = typeof execution?.name === 'string' ? execution.name : '';
    }
    catch {
        name = '';
    }
    if (!name)
        return { kind: 'allow' };
    if (!DESTRUCTIVE_TOOLS.has(name))
        return { kind: 'allow' };
    let rawArgs;
    try {
        rawArgs = execution.arguments;
    }
    catch {
        rawArgs = undefined;
    }
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    // Operation-conditional tools are read-only in their default operation —
    // `iterate_prune` dry-runs and `iterate_config` reads need no consent.
    if (!mutatesWorkspace(name, args))
        return { kind: 'allow' };
    if (policy === 'allow')
        return { kind: 'allow' };
    // Structured text (deny reason / audited ask summary) is always English;
    // only the human prompt (`displayReason`) follows the project language.
    const reason = describe(name, args, 'en');
    if (policy === 'deny')
        return { kind: 'deny', reason };
    const localized = describe(name, args, language);
    return {
        kind: 'ask',
        reason,
        displayReason: language === 'zh' ? { en: reason, zh: localized } : { en: reason },
    };
}
/**
 * True when a tool name is ROUTED through the approval gate.
 *
 * Name-level only (the caller has not parsed arguments yet), so the two
 * operation-conditional tools are included for their whole name and
 * {@link decideApproval} narrows per call: prune with a dry run and
 * `iterate_config` reads both come back `allow`.
 */
export function isDestructiveIterateTool(name) {
    return typeof name === 'string' && DESTRUCTIVE_TOOLS.has(name);
}
