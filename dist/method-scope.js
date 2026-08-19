/**
 * src/method-scope.ts — deterministic "touched method" detection for the
 * atomic-fix gate.
 *
 * `config.atomic.max_adjacent_methods` caps how many ADJACENT methods a single
 * atomic fix may touch (SKILL.md: 改动在单个函数/方法内，或最多 N 个相邻的同类方法).
 * The fixer supplies only the new full-file content, so this module rebuilds a
 * best-effort method map (signature line → containing span) and counts the
 * distinct methods a diff's changed regions intersect. Purely textual and
 * deterministic — no parsing library — so it stays unit-testable.
 *
 * Heuristic (documented, not hidden):
 *  - A "method" is a line matching a conservative, language-agnostic signature
 *    pattern (JS/TS `function` + arrow assignments + class methods, Python
 *    `def`, Swift `func`, Go `func`, Rust `fn`, Ruby `def`, PHP `function`).
 *  - A method's span is approximated as `signatureLine .. nextSignatureLine-1`
 *    (no brace matching). Changes between two signatures are attributed to the
 *    earlier method — exactly the "adjacent methods" granularity this
 *    threshold governs.
 *  - A diff hunk counts a method as touched when the REMOVED block intersects
 *    a `before` span or the ADDED block intersects an `after` span. Pure
 *    insertions/deletions are attributed through the side that actually
 *    changed, so a single-method edit counts 1 and a deleted method does not
 *    drag in its neighbour.
 *  - If no method is detected around a change, `countTouchedMethods` returns 0,
 *    so the `max_lines` gate remains the only constraint for non-method code.
 */
/** Language keywords that never denote a method name. */
const RESERVED_WORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else',
    'do', 'try', 'case', 'new', 'typeof', 'instanceof', 'in', 'of', 'class',
    'interface', 'type', 'enum', 'import', 'export', 'default', 'extends',
    'implements', 'where', 'async', 'await', 'yield', 'throw', 'delete',
    'let', 'const', 'var', 'public', 'private', 'protected', 'static',
]);
/**
 * Test-framework callables that look like method declarations but are plain
 * calls (e.g. `it('…', () => { … })`). Excluding them keeps a test-only change
 * from falsely tripping the adjacent-method gate.
 */
const CALLABLE_NOISE = new Set([
    'it', 'test', 'describe', 'expect', 'beforeEach', 'afterEach',
    'beforeAll', 'afterAll', 'suite', 'specify',
]);
/** Signature patterns per language family. Each capture is the method name. */
const SIGNATURE_PATTERNS = [
    // JS/TS function declarations
    { kind: 'ts', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, nameIndex: 1 },
    // JS/TS arrow-function assignments (const f = (...) => …)
    { kind: 'ts-arrow', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, nameIndex: 1 },
    // Indented class methods (JS/TS/Java/Kotlin/C# style `name(…) {`)
    { kind: 'ts-method', re: /^\s{2,}(?:(?:public|private|protected|static|async|readonly)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/, nameIndex: 1 },
    // Python def (module-level and class methods)
    { kind: 'py', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, nameIndex: 1 },
    // Swift func
    { kind: 'swift', re: /^\s*(?:(?:override|public|private|internal|fileprivate|open|static|class)\s+)*func\s+([A-Za-z_][\w]*)\s*\(/, nameIndex: 1 },
    // Go func (plain + receiver)
    { kind: 'go', re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/, nameIndex: 1 },
    // Rust fn
    { kind: 'rust', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/, nameIndex: 1 },
    // Ruby def (def name / def self.name / def Class.name)
    { kind: 'ruby', re: /^\s*def\s+(?:(?:self|[A-Z][\w]*)\s*\.\s*)?([A-Za-z_][\w]*[!?]?)(?:\s|\(|$)/, nameIndex: 1 },
    // PHP function
    { kind: 'php', re: /^\s*(?:(?:public|private|protected|static)\s+)*function\s+([A-Za-z_][\w]*)\s*\(/, nameIndex: 1 },
];
/**
 * Collect method/function signatures from `text`.
 * Returns a sorted array of `{ name, line }` (1-based line numbers).
 */
export function collectMethodSignatures(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = i + 1;
        for (const p of SIGNATURE_PATTERNS) {
            const m = p.re.exec(raw);
            if (!m)
                continue;
            const name = m[p.nameIndex];
            if (!name || RESERVED_WORDS.has(name) || CALLABLE_NOISE.has(name))
                continue;
            // Avoid two patterns claiming the same line (e.g. TS method + arrow).
            if (out.some((s) => s.line === line && s.name === name))
                break;
            out.push({ name, line });
            break;
        }
    }
    return out;
}
/** Number of physical lines in `text` (a trailing newline does not add a line). */
export function countTextLines(text) {
    if (text === '')
        return 0;
    const parts = text.split('\n');
    return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}
/**
 * Build the approximate span owned by each signature: from its own line up to
 * (but excluding) the next signature line, trimmed of trailing blank lines so
 * a blank separator between two methods belongs to neither. The last method's
 * span runs to the final non-blank line of the file.
 */
export function collectMethodSpans(text) {
    const signatures = collectMethodSignatures(text);
    if (signatures.length === 0)
        return [];
    const lines = text.split('\n');
    const lineCount = countTextLines(text);
    /** Last non-blank line at or before `candidate`. */
    function trimBlank(endCandidate, floor) {
        let end = endCandidate;
        while (end > floor) {
            const raw = lines[end - 1];
            if (raw === undefined || raw.trim().length === 0)
                end--;
            else
                break;
        }
        return end;
    }
    const spans = [];
    for (let i = 0; i < signatures.length; i++) {
        const cur = signatures[i];
        const next = signatures[i + 1];
        const rawEnd = next ? next.line - 1 : lineCount;
        spans.push({ name: cur.name, startLine: cur.line, endLine: trimBlank(rawEnd, cur.line) });
    }
    return spans;
}
/** True when `[regionStart, regionEnd]` intersects `[spanStart, spanEnd]`. */
function intersects(spanStart, spanEnd, regionStart, regionEnd) {
    return spanStart <= regionEnd && spanEnd >= regionStart;
}
/**
 * Count the distinct methods a set of diff hunks touches.
 *
 * Semantics:
 *  - REMOVED lines (oldLines > 0) are attributed against the `before` method
 *    spans; PURE insertions (oldLines === 0) skip `before` so a deletion never
 *    drags in the next surviving method.
 *  - ADDED lines (newLines > 0) are attributed against the `after` spans;
 *    PURE deletions skip `after` so an insertion never mis-attributes to the
 *    following method.
 *  - Methods touched by both sides are counted once (keyed name@startLine).
 */
export function countTouchedMethods(before, after, hunks) {
    if (hunks.length === 0)
        return 0;
    const beforeSpans = collectMethodSpans(before);
    const afterSpans = collectMethodSpans(after);
    const touched = new Set();
    for (const h of hunks) {
        if (h.oldLines > 0) {
            const oldEnd = h.oldStart + h.oldLines - 1;
            for (const s of beforeSpans) {
                if (intersects(s.startLine, s.endLine, h.oldStart, oldEnd)) {
                    touched.add(`${s.name}@${s.startLine}`);
                }
            }
        }
        if (h.newLines > 0) {
            const newEnd = h.newStart + h.newLines - 1;
            for (const s of afterSpans) {
                if (intersects(s.startLine, s.endLine, h.newStart, newEnd)) {
                    touched.add(`${s.name}@${s.startLine}`);
                }
            }
        }
    }
    return touched.size;
}
