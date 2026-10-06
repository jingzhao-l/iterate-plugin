/**
 * src/tools/present.ts — shared `presentResult` helpers for the iterate tools (#12).
 *
 * dsh presents a completed call through `ToolDefinition.presentResult(args,
 * result)` when the tool supplies one; the return value is a `ToolResultView`
 * (a `card`-tagged render intent from `@deepseek-ai/dsh-tools`). These helpers
 * read ONLY the durable result projection handed to the presenter
 * (`result.content` / `result.isError`) — they never re-execute anything, so a
 * live call and a session-log replay produce the identical card.
 *
 * House rules for every presenter built on this module:
 *   - Pure / replay-safe: depend on `args` + `result` only.
 *   - Defensive: any shape it cannot read returns `undefined`, which makes the
 *     UI fall back to the default presentation (pending title + raw result)
 *     instead of a wrong or half-guessed card.
 *   - No invented copy: card text is derived from the render output the tool
 *     itself produced.
 */
/**
 * Concatenated text of a completed call's rendered content, or `undefined`
 * when there is none. Failure results are never summarized — the presenter
 * declines the card and the UI shows the raw error.
 */
export function renderedText(result) {
    if (!result || result.isError === true || !Array.isArray(result.content))
        return undefined;
    const parts = [];
    for (const block of result.content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}
/**
 * First non-empty line of the rendered content — the card headline for a
 * `presentResult` (#12). Long lines are clamped so a card header stays a
 * header. `undefined` (failure / no text) means "decline the card".
 */
export function resultHeadline(result, maxLength = 160) {
    const text = renderedText(result);
    if (!text)
        return undefined;
    const line = text.split('\n').find((l) => l.trim().length > 0);
    if (!line)
        return undefined;
    const trimmed = line.trim();
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}
/**
 * Parse a tool's rendered content as JSON — for tools whose `render` emits
 * `JSON.stringify(value, null, 2)` verbatim (review, checkpoint). Returns a
 * plain record, or `undefined` when the content is not an object-shaped JSON
 * document (the presenter then declines the card rather than guess).
 */
export function parseRenderedJson(result) {
    const text = renderedText(result);
    if (!text)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : undefined;
}
/** Narrow an unknown value to a plain record (arrays/null/primitives → undefined). */
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** Finite-number narrow for defensively reading fields off a parsed result. */
export function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
