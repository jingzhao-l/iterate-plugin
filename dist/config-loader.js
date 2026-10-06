import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
/**
 * Load and parse iterate.config.yaml from the project root.
 * Returns null if the file is missing or invalid.
 */
export function loadConfig(projectRoot) {
    try {
        const content = readFileSync(join(projectRoot, 'iterate.config.yaml'), 'utf-8');
        const parsed = yaml.load(content);
        // A YAML sequence root (e.g. a list of findings or a `- foo` file) must
        // not masquerade as a config object — treating it as one would merge its
        // indices into the config (config bomb). Reject it, not coerce it.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Sensible defaults for every config field. These are the "Master" config:
 * when a project has no iterate.config.yaml (or only partial overrides), every
 * missing key is filled from here so the plugin is usable out of the box while
 * never inventing trusted validation commands (they must be configured).
 */
export function defaultConfig() {
    return {
        goal: 'Improve code quality and maintainability',
        max_rounds: 7,
        language: 'en',
        dimensions: [
            'correctness',
            'security',
            'performance',
            'architecture',
            'style-tests',
            'tech-debt',
            'spec-compliance',
            'frontend-backend',
            'ui-ux',
        ],
        review: { scope: 'full' },
        atomic: { max_lines: 20, max_adjacent_methods: 3 },
        git: {
            target_branch: 'main',
            use_worktree: false,
            push_per_round: false,
            auto_merge: false,
        },
        validation: { command_whitelist: [], commands: {} },
        reviewer: {
            output_schema_validation: true,
            evidence_validation: true,
            coverage_validation: true,
            scope_chunk_size: 25,
        },
        observatory: {
            capture: true,
            approval: 'ask',
        },
    };
}
/**
 * Recursively merge `override` on top of `base`.
 * - Missing keys in `base` are added from `override`.
 * - Present keys in `override` win.
 * - Plain objects are merged recursively; arrays and scalars are replaced
 *   wholesale by the override (arrays are NOT concatenated).
 * Returns a NEW object; neither input is mutated.
 */
export function mergeConfig(base, override) {
    if (!override || typeof override !== 'object')
        return { ...base };
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined)
            continue;
        // Prototype-pollution guard: a YAML `__proto__`/`constructor`/`prototype`
        // key must never be plain-assigned — js-yaml stores __proto__ as an own
        // data property, and `out[key] = value` would invoke the __proto__ setter.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
            continue;
        const baseValue = out[key];
        if (baseValue &&
            typeof baseValue === 'object' &&
            !Array.isArray(baseValue) &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value)) {
            out[key] = mergeConfig(baseValue, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Load the EFFECTIVE config for a project: project-root overrides merged on top
 * of the built-in defaults ("Master + Overrides"). Never returns null — a
 * project without a config file simply runs on the defaults (with an empty
 * validation command set, so nothing untrusted can ever execute).
 *
 * The merged result is FIELD-COERCED (see {@link coerceKnownFields}): YAML has
 * no schema, so a hand-edited `max_rounds: "ten"` falls back to the default
 * per field instead of flowing into the review loop as garbage.
 */
export function loadEffectiveConfig(projectRoot) {
    const override = loadConfig(projectRoot);
    if (!override) {
        return { config: defaultConfig(), source: 'defaults', override: null };
    }
    const merged = mergeConfig(defaultConfig(), override);
    coerceKnownFields(merged);
    return { config: merged, source: 'override', override };
}
/** True for a plain object (not null, not an array). */
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** A positive integer (rounds, line budgets, chunk sizes). */
function isPositiveInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
/** A non-negative integer (thresholds where 0 means "no limit"). */
function isNonNegativeInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
/** An array of strings; `nonEmptyItems` also rejects blank entries. */
function isStringArray(v, nonEmptyItems = false) {
    return (Array.isArray(v) &&
        v.every((x) => typeof x === 'string' && (!nonEmptyItems || x.trim().length > 0)));
}
/**
 * Coerce the KNOWN config fields back to their documented types, falling back
 * to the built-in default PER FIELD when the on-disk value is garbage.
 *
 * YAML has no schema: `max_rounds: "ten"` used to flow straight into the
 * review loop (which then silently ran zero rounds), `dimensions: "all"`
 * replaced the dimension list with a string, and a garbage
 * `observatory.approval` reached the approval gate unchecked. Free-form
 * sections (`onboarding`, `personalization`) and unknown project keys are NOT
 * touched beyond requiring them to be objects. Mutates `raw` in place — only
 * safe on freshly-merged objects (see {@link loadEffectiveConfig}).
 */
function coerceKnownFields(raw) {
    const d = defaultConfig();
    if (typeof raw.goal !== 'string' || raw.goal.trim().length === 0)
        raw.goal = d.goal;
    if (!isPositiveInt(raw.max_rounds))
        raw.max_rounds = d.max_rounds;
    if (raw.language !== 'zh' && raw.language !== 'en')
        raw.language = d.language;
    if (!isStringArray(raw.dimensions, true))
        raw.dimensions = d.dimensions;
    // `reasoning_effort` is optional (absent → provider default). Present but
    // invalid → drop back to absent rather than inventing a value.
    if ('reasoning_effort' in raw &&
        raw.reasoning_effort !== 'low' && raw.reasoning_effort !== 'medium' && raw.reasoning_effort !== 'high') {
        delete raw.reasoning_effort;
    }
    // A scalar/null value wholesale-replaces its default section during the
    // merge — restore a full default section, then coerce its members.
    const section = (key) => {
        if (!isPlainObject(raw[key]))
            raw[key] = { ...d[key] };
        return raw[key];
    };
    const review = section('review');
    if (review.scope !== 'full' && review.scope !== 'changed-only') {
        review.scope = d.review.scope;
    }
    const atomic = section('atomic');
    if (!isPositiveInt(atomic.max_lines))
        atomic.max_lines = d.atomic.max_lines;
    if (!isNonNegativeInt(atomic.max_adjacent_methods)) {
        atomic.max_adjacent_methods = d.atomic.max_adjacent_methods;
    }
    const git = section('git');
    if (typeof git.target_branch !== 'string' || git.target_branch.length === 0) {
        git.target_branch = d.git.target_branch;
    }
    for (const key of ['use_worktree', 'push_per_round', 'auto_merge']) {
        if (typeof git[key] !== 'boolean')
            git[key] = d.git[key];
    }
    const validation = section('validation');
    if (!isStringArray(validation.command_whitelist)) {
        validation.command_whitelist = d.validation.command_whitelist;
    }
    // `commands` is an allow-list (module → command[]): a malformed entry must
    // fall back to the default (empty) so an invalid shape can never smuggle a
    // command into the runtime allow-list.
    if (!isPlainObject(validation.commands) || !Object.values(validation.commands).every((v) => isStringArray(v))) {
        validation.commands = d.validation.commands;
    }
    const reviewer = section('reviewer');
    const dReviewer = d.reviewer;
    for (const key of ['output_schema_validation', 'evidence_validation', 'coverage_validation']) {
        if (typeof reviewer[key] !== 'boolean')
            reviewer[key] = dReviewer[key];
    }
    if (!isPositiveInt(reviewer.scope_chunk_size))
        reviewer.scope_chunk_size = dReviewer.scope_chunk_size;
    const observatory = section('observatory');
    const dObs = d.observatory;
    if (typeof observatory.capture !== 'boolean')
        observatory.capture = dObs.capture;
    if (observatory.approval !== 'ask' && observatory.approval !== 'deny' && observatory.approval !== 'allow') {
        observatory.approval = dObs.approval;
    }
    // Free-form sections must be objects (consumers treat them as maps).
    for (const key of ['onboarding', 'personalization']) {
        if (key in raw && !isPlainObject(raw[key]))
            delete raw[key];
    }
}
/**
 * Check whether a command is in the predefined commands list.
 * A command is allowed if it is EXACTLY (after trim) listed in any
 * module's command array in `validation.commands`.
 * This replaces the old prefix-based whitelist at runtime — the
 * `command_whitelist` is still used for config-time validation only.
 */
export function isCommandAllowed(command, predefinedCommands) {
    const trimmed = command.trim();
    return predefinedCommands.includes(trimmed);
}
/**
 * Flatten all commands from `validation.commands` into a single string array.
 * Used for runtime exact-match checking.
 */
export function flattenCommands(commands) {
    if (!commands || typeof commands !== 'object')
        return [];
    const out = [];
    for (const v of Object.values(commands)) {
        if (Array.isArray(v))
            out.push(...v);
    }
    return out;
}
/**
 * Every top-level key `IterateConfig` defines. Anything else in the file is
 * an unknown key: a typo (`maxRounds`) or a hallucinated section that nothing
 * ever reads. Single source of truth for BOTH validation paths —
 * {@link validateConfig} (read/merge) and `validateConfigUpdates` (write).
 *
 * Keep in sync with `IterateConfig` (src/types.ts).
 */
export const SUPPORTED_CONFIG_KEYS = [
    'goal',
    'language',
    'dimensions',
    'max_rounds',
    'reasoning_effort',
    'review',
    'reviewer',
    'atomic',
    'git',
    'validation',
    'observatory',
    'personalization',
    'onboarding',
];
/** Upper bound on configurable iteration rounds (config bomb guard). */
export const MAX_MAX_ROUNDS = 100;
/** Upper bound on `atomic.max_lines` (a single fix never needs more). */
export const MAX_ATOMIC_MAX_LINES = 10_000;
/** Upper bound on `atomic.max_adjacent_methods`. */
export const MAX_MAX_ADJACENT_METHODS = 200;
/** Upper bound on `reviewer.scope_chunk_size` (files per reviewer task batch). */
export const MAX_SCOPE_CHUNK_SIZE = 1000;
/** `review.scope` enum. */
const REVIEW_SCOPES = ['full', 'changed-only'];
/** `reasoning_effort` enum (absent → provider default). */
const REASONING_EFFORTS = ['low', 'medium', 'high'];
/** `observatory.approval` enum (the human-consent policy). */
const APPROVAL_POLICIES = ['ask', 'deny', 'allow'];
/** True when `v` is one of the allowed enum members. */
function isEnum(v, allowed) {
    return typeof v === 'string' && allowed.includes(v);
}
/**
 * Validate the config's shape, ranges, and enums.
 *
 * Returns an array of error strings (empty when valid). Three tiers:
 *   - `root` — the whole document is not an object (return immediately).
 *   - the three PRESENCE-required fields (`goal`, `dimensions`, `validation`)
 *     — reported by their bare path so existing callers keep matching them;
 *   - STRICT checks on every field that IS present: bounded integers
 *     (`max_rounds ≤ 100`, `atomic.max_lines`, `reviewer.scope_chunk_size`),
 *     enums (`review.scope`, `reasoning_effort`, `observatory.approval`),
 *     booleans (`git.*`, `reviewer.*`), the `validation.commands` allow-list
 *     shape (a `Record<string, string[]>` — an ARRAY is refused, otherwise
 *     `flattenCommands` would silently discard it and leave a whitelist that
 *     looks configured but allows nothing), and unknown top-level keys.
 *
 * Absent optional fields are accepted: `loadEffectiveConfig` fills them from
 * the built-in defaults, and hand-written partial configs are legitimate —
 * but a present field must be RIGHT (YAML has no schema, so `max_rounds:
 * "ten"` or `reviewer: {evidence_validation: "yes"}` used to pass the old
 * three-presence-check validator untouched).
 */
export function validateConfig(config) {
    const errors = [];
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        errors.push('root');
        return errors;
    }
    const c = config;
    // ── Required core fields (presence, bare-path identifiers) ──────────────
    if (typeof c.goal !== 'string' || c.goal.trim().length === 0)
        errors.push('goal');
    if (!Array.isArray(c.dimensions)) {
        errors.push('dimensions');
    }
    else if (c.dimensions.length === 0 ||
        !c.dimensions.every((d) => typeof d === 'string' && d.trim().length > 0)) {
        // `dimensions: []` is a valid JSON type but an empty review: it passes
        // `Array.isArray` while selecting zero dimensions to review.
        errors.push('dimensions must be a non-empty array of non-empty strings');
    }
    // ── Optional scalar fields: present ⇒ must be valid ─────────────────────
    if ('language' in c && !isEnum(c.language, ['zh', 'en'])) {
        errors.push('language must be "zh" or "en"');
    }
    if ('max_rounds' in c &&
        (typeof c.max_rounds !== 'number' ||
            !Number.isInteger(c.max_rounds) ||
            c.max_rounds < 1 ||
            c.max_rounds > MAX_MAX_ROUNDS)) {
        errors.push(`max_rounds must be an integer between 1 and ${MAX_MAX_ROUNDS}`);
    }
    if ('reasoning_effort' in c &&
        c.reasoning_effort !== undefined &&
        !isEnum(c.reasoning_effort, REASONING_EFFORTS)) {
        errors.push('reasoning_effort must be "low", "medium", or "high"');
    }
    // ── Sections: absent ⇒ defaults apply; present ⇒ must be a plain object ─
    const section = (key, required = false) => {
        if (!(key in c)) {
            if (required)
                errors.push(key);
            return null;
        }
        // `typeof [] === 'object'` — a YAML sequence in a section's place must not
        // masquerade as an object (it would sail through every `key in v` check).
        if (!isPlainObject(c[key])) {
            errors.push(key);
            return null;
        }
        return c[key];
    };
    const review = section('review');
    if (review && review.scope !== undefined && !isEnum(review.scope, REVIEW_SCOPES)) {
        errors.push('review.scope must be "full" or "changed-only"');
    }
    const atomic = section('atomic');
    if (atomic) {
        if ('max_lines' in atomic &&
            (typeof atomic.max_lines !== 'number' ||
                !Number.isInteger(atomic.max_lines) ||
                atomic.max_lines < 1 ||
                atomic.max_lines > MAX_ATOMIC_MAX_LINES)) {
            errors.push(`atomic.max_lines must be an integer between 1 and ${MAX_ATOMIC_MAX_LINES}`);
        }
        if ('max_adjacent_methods' in atomic &&
            (typeof atomic.max_adjacent_methods !== 'number' ||
                !Number.isInteger(atomic.max_adjacent_methods) ||
                atomic.max_adjacent_methods < 0 ||
                atomic.max_adjacent_methods > MAX_MAX_ADJACENT_METHODS)) {
            errors.push(`atomic.max_adjacent_methods must be an integer between 0 and ${MAX_MAX_ADJACENT_METHODS}`);
        }
    }
    const git = section('git');
    if (git) {
        if ('target_branch' in git && (typeof git.target_branch !== 'string' || git.target_branch.length === 0)) {
            errors.push('git.target_branch must be a non-empty string');
        }
        for (const key of ['use_worktree', 'push_per_round', 'auto_merge']) {
            if (key in git && typeof git[key] !== 'boolean') {
                errors.push(`git.${key} must be a boolean`);
            }
        }
    }
    const reviewer = section('reviewer');
    if (reviewer) {
        for (const key of ['output_schema_validation', 'evidence_validation', 'coverage_validation']) {
            if (key in reviewer && typeof reviewer[key] !== 'boolean') {
                errors.push(`reviewer.${key} must be a boolean`);
            }
        }
        if ('scope_chunk_size' in reviewer &&
            (typeof reviewer.scope_chunk_size !== 'number' ||
                !Number.isInteger(reviewer.scope_chunk_size) ||
                reviewer.scope_chunk_size < 1 ||
                reviewer.scope_chunk_size > MAX_SCOPE_CHUNK_SIZE)) {
            errors.push(`reviewer.scope_chunk_size must be an integer between 1 and ${MAX_SCOPE_CHUNK_SIZE}`);
        }
    }
    const observatory = section('observatory');
    if (observatory) {
        if ('capture' in observatory && typeof observatory.capture !== 'boolean') {
            errors.push('observatory.capture must be a boolean');
        }
        if ('approval' in observatory && observatory.approval !== undefined && !isEnum(observatory.approval, APPROVAL_POLICIES)) {
            errors.push('observatory.approval must be "ask", "deny", or "allow"');
        }
    }
    // ── validation: the allow-list the runtime trusts to execute commands ───
    const v = section('validation', true);
    if (v) {
        if (!Array.isArray(v.command_whitelist)) {
            errors.push('validation.command_whitelist');
        }
        else if (!v.command_whitelist.every((x) => typeof x === 'string')) {
            errors.push('validation.command_whitelist must be an array of strings');
        }
        // `commands` is an allow-list (module → command[]): it must be a mapping
        // whose values are string arrays. `typeof [] === 'object'` used to let
        // `["npm t"]` through, and `flattenCommands` then dropped every
        // non-object entry — a whitelist that read as configured while allowing
        // nothing (fail-closed for execution, but a silent configuration lie).
        if (!('commands' in v) || !isPlainObject(v.commands)) {
            errors.push('validation.commands must be a mapping of module → string[]');
        }
        else if (!Object.values(v.commands).every((arr) => Array.isArray(arr) && arr.every((x) => typeof x === 'string'))) {
            errors.push('validation.commands must be a mapping of module → string[]');
        }
    }
    // ── Unknown top-level keys: reported, never silently ignored ────────────
    for (const key of Object.keys(c)) {
        if (!SUPPORTED_CONFIG_KEYS.includes(key)) {
            errors.push(`${key} is not a supported config key`);
        }
    }
    return errors;
}
/**
 * Sensitive system directories that may never become a project root in the
 * HEADLESS tier (see {@link resolveProjectRoot} tier (b)): the directory
 * itself and its DIRECT children are refused, checked against both the
 * lexical path and its realpath (macOS aliases `/etc` → `/private/etc`, so a
 * realpath'd `/etc/foo` lands under `/private/etc`). Deeper descendants and
 * sibling trees are not swept up — that is what keeps `os.tmpdir()`
 * (`/var/folders/…`, i.e. `/private/var/folders/…`, three levels below
 * `/private`) and `/Users/<me>/project` working. The bare home directory is
 * refused separately (paths INSIDE home are allowed).
 */
const SYSTEM_ROOTS = [
    '/etc', '/usr', '/bin', '/sbin', '/var', '/private', '/System', '/Library',
    '/Applications', '/dev', '/proc', '/sys', '/boot', '/run',
];
/** Memoized realpath (system roots, home) — `realpath` never changes for them. */
const realpathCache = new Map();
function cachedRealpath(path) {
    const memo = realpathCache.get(path);
    if (memo !== undefined)
        return memo;
    let real = path;
    try {
        const r = realpathSync(path);
        if (r)
            real = r;
    }
    catch {
        // Not present on this platform/filesystem — the literal path is all we have.
    }
    realpathCache.set(path, real);
    return real;
}
/** True for the bare home directory itself (lexical or realpath form). */
function isHomeDirectory(candidate) {
    return candidate === homedir() || candidate === cachedRealpath(homedir());
}
/**
 * True for a path the headless tier must refuse because it is a sensitive
 * system root or sits DIRECTLY inside one — checked against both the lexical
 * and the realpath form (macOS aliases `/etc` → `/private/etc`, so a
 * realpath'd `/etc/foo` lands under `/private/etc`, whose parent is the real
 * `/etc`). Pure path inspection — no filesystem mutation.
 */
function isSensitiveSystemPath(candidate) {
    if (!candidate || candidate === sep)
        return true;
    const parent = dirname(candidate);
    for (const sys of SYSTEM_ROOTS) {
        if (candidate === sys || parent === sys)
            return true;
        // macOS: realpath(`/etc/foo`) = `/private/etc/foo` — compare against the
        // real location of the sysroot or the alias slips through.
        if (parent === cachedRealpath(sys))
            return true;
    }
    return false;
}
/**
 * Resolve `sessionCwd` to a containment anchor: the realpath of an EXISTING
 * directory. Returns null when the session cwd is empty, `/`, NUL-bearing, or
 * not an existing directory — a workspace header we cannot bound the session
 * with (stale/bogus cwd) falls back to the headless tier instead.
 */
function sessionAnchor(sessionCwd) {
    if (typeof sessionCwd !== 'string')
        return null;
    const raw = sessionCwd.trim();
    if (!raw || raw === sep || raw.includes('\0'))
        return null;
    const abs = resolve(raw);
    if (abs === sep)
        return null;
    try {
        if (!statSync(abs).isDirectory())
            return null;
    }
    catch {
        return null; // does not exist / unreadable — cannot anchor containment
    }
    try {
        const real = realpathSync(abs);
        if (real && real !== sep)
            return real;
    }
    catch {
        // Exists but realpath is fenced — the lexical absolute path still bounds it.
    }
    return abs;
}
/**
 * Realpath `p` for CONTAINMENT comparisons: realpath directly when it exists,
 * otherwise realpath the deepest existing ancestor and re-append the tail.
 * A not-yet-created target can't be realpath'd as a whole, and on macOS
 * `/var/folders/…` (lexical) vs `/private/var/folders/…` (anchor) would never
 * match — likewise a symlinked parent must contribute its REAL destination,
 * or "create a new dir through this link" would escape the workspace. Falls
 * back to the lexical path when nothing along the way can be resolved.
 */
function realpathForContainment(p) {
    try {
        if (existsSync(p))
            return realpathSync(p);
    }
    catch {
        return p;
    }
    let cur = p;
    const tail = [];
    for (;;) {
        const parent = dirname(cur);
        if (parent === cur)
            return p; // walked to the fs root without an ancestor
        tail.unshift(basename(cur));
        try {
            if (existsSync(parent))
                return join(realpathSync(parent), ...tail);
        }
        catch {
            return p;
        }
        cur = parent;
    }
}
/**
 * Resolve a caller-supplied project root to a safe absolute path.
 *
 * Every tool accepts a model-controlled `path` argument; before it is used in
 * any file read/write or as a command `cwd`, it must be sanitized. Two-tier
 * contract (checked AFTER the common steps below):
 *
 *   Resolution order for the default (no explicit `path`) case:
 *     1. `sessionCwd` — the absolute working directory the calling DSH session
 *        was created in (`exec.agent.session.header.cwd`). Authoritative
 *        workspace for the conversation, immune to where the process started;
 *        an empty session cwd or `/` is refused, everything else (including
 *        the home directory itself) is honored.
 *     2. the process cwd, when it is a usable directory (not `/` or the home
 *        dir — launchd/daemon-managed servers start with cwd=`/`);
 *     3. the session workspace decoded from `DSH_SESSION_JSONL`.
 *
 *   Common steps: an empty/missing `path` falls back to the step above; the
 *   path is resolved to an absolute path (collapsing `..` and symlinks —
 *   realpath-aware so a symlinked session cwd and its target share one root);
 *   the filesystem root `/` is always refused.
 *
 *   Tier (a) — a USABLE session cwd is known (an existing directory):
 *     an EXPLICIT `path` must resolve to the session cwd or something INSIDE
 *     it; otherwise `{ ok: false, reason }` (structured — callers
 *     short-circuit on it). This keeps the legitimate "scope to a
 *     subdirectory" use while blocking escapes to `/etc` or sibling trees
 *     (the path alone could never smuggle the model out of its workspace).
 *
 *   Tier (b) — no usable session cwd (headless/tests):
 *     additionally refuse the sensitive system roots and their direct children
 *     (see {@link SYSTEM_ROOTS}) plus the bare home directory itself. Paths
 *     INSIDE home (`/Users/me/project`) and the transient tmpdir tree remain
 *     allowed, as does any ordinary project directory.
 *
 * Returns `{ ok: true, root }` on success, or `{ ok: false, reason }` when the
 * path is unsafe; callers must short-circuit on the failure and return a
 * structured error instead of proceeding.
 */
export function resolveProjectRoot(input, sessionCwd) {
    // A non-string input (number, array, …) from a hostile tool invocation must
    // be treated as "no explicit path" instead of crashing on `.trim()`.
    const raw = (typeof input === 'string' ? input : '').trim();
    // A NUL byte can never name a real path and makes `resolve()` (and every
    // downstream fs call) throw — treat it as unsafe input, not a throw path.
    if (raw.includes('\0')) {
        return { ok: false, reason: 'Refusing project root containing NUL bytes.' };
    }
    const explicit = raw.length > 0;
    const rootLexical = explicit ? resolve(raw) : resolve(effectiveCwd(sessionCwd));
    // Collapse symlinks (documented contract: "collapsing `..` and symlinks") —
    // a path through a symlinked directory must resolve to its REAL location so
    // two aliases of the same project share one `.iterate/` state, and tools can
    // never read outside the resolved root via a link. Only when the path
    // exists: a not-yet-created target (dirs created through the tools) keeps
    // the lexical path so the caller can still write into it. The filesystem
    // root check runs against the NORMALIZED path, so a symlink to `/` is
    // refused too.
    let root = rootLexical;
    try {
        if (existsSync(rootLexical)) {
            const real = realpathSync(rootLexical);
            if (real)
                root = real;
        }
    }
    catch {
        // realpath can throw on a broken link or a permission fence — keep the
        // lexical path (existing behavior) rather than failing the resolution.
    }
    if (!root || root === sep) {
        return { ok: false, reason: 'Refusing filesystem root as project root.' };
    }
    // `.iterate` must stay INSIDE the resolved root: it is the state directory
    // every tool writes through (checkpoint, decision log, fixes, backups). When
    // it exists and is a symlink — or is reached through one — whose REAL target
    // escapes the REAL project root, artifacts would be created/removed outside
    // the workspace while the tools still believe they are under the root. Only
    // the project ROOT used to be realpath'd, so a symlinked `.iterate` quietly
    // redirected every product out of the tree. Refuse the root (structured —
    // callers short-circuit) instead of following the link; an `.iterate` that
    // stays within the root (a real dir, or a link to one inside) is accepted.
    const iterateLexical = join(root, '.iterate');
    if (existsSync(iterateLexical)) {
        try {
            const realRoot = realpathForContainment(root);
            const realIterate = realpathForContainment(iterateLexical);
            if (realIterate !== realRoot && !realIterate.startsWith(realRoot + sep)) {
                return {
                    ok: false,
                    reason: `Refusing project root: \`.iterate\` resolves outside the project (symlink escape): ` +
                        `\`${realIterate}\` is not inside \`${realRoot}\`.`,
                };
            }
        }
        catch {
            // A realpath failure (permission fence, race) keeps the lexical
            // behavior — the state dir itself still surfaces any real I/O problem
            // as a structured tool error later.
        }
    }
    const anchor = sessionAnchor(sessionCwd);
    if (anchor) {
        // Tier (a): the session workspace bounds every explicit path (realpath on
        // both sides — including the deepest-existing-ancestor form for a
        // not-yet-created path, so `/var/…` vs `/private/var/…` and symlinked
        // parents agree with the anchor).
        if (explicit) {
            const contained = realpathForContainment(root);
            if (contained !== anchor && !contained.startsWith(anchor + sep)) {
                return {
                    ok: false,
                    reason: `Refusing project root outside the session workspace: \`${root}\` is not inside \`${anchor}\`.`,
                };
            }
        }
        return { ok: true, root };
    }
    // Tier (b): headless — no session workspace to contain the path. Refuse the
    // bare home directory (paths INSIDE home stay allowed) and sensitive system
    // roots — checked on both forms: `/etc/foo` only shows its `/etc` parent
    // lexically, while its realpath shows `/private/etc`.
    if (isHomeDirectory(root) || isHomeDirectory(rootLexical)) {
        return {
            ok: false,
            reason: 'Refusing the home directory itself as project root — scope to a subdirectory inside it.',
        };
    }
    if (isSensitiveSystemPath(rootLexical) || isSensitiveSystemPath(root)) {
        return { ok: false, reason: 'Refusing a sensitive system directory as project root.' };
    }
    return { ok: true, root };
}
/**
 * Thin adapter for tool `execute(args, exec)` bodies: pull the session cwd
 * from the DSH run context and hand it to {@link resolveProjectRoot}.
 */
export function resolveProjectRootForExec(exec, input) {
    return resolveProjectRoot(input, exec?.agent?.session?.header?.cwd);
}
/**
 * Resolve the default working directory for tools invoked without an explicit
 * `path`. Prefers the caller-provided session cwd, then the process cwd, then
 * the session workspace encoded in `DSH_SESSION_JSONL`
 * (`…/sessions/<encoded-workspace>/<session-id>/session.jsonl.zstd`), where
 * the workspace directory is `--`-wrapped with `/` → `-` and percent-encoded
 * bytes spelled as `~<hex>` (e.g. `/Volumes/Eng-Dev/iterate-skill` →
 * `--Volumes-Eng-Dev-iterate-skill--`).
 */
function effectiveCwd(sessionCwd) {
    // A session legitimately rooted in the HOME directory must be honored: only
    // an empty session cwd or the filesystem root disqualifies it. (Refusing
    // `homedir()` here substituted the server's own cwd — tools then read/write
    // `.iterate` in the wrong project.)
    if (typeof sessionCwd === 'string' && sessionCwd && sessionCwd !== sep)
        return sessionCwd;
    let cwd = '';
    try {
        cwd = process.cwd();
    }
    catch {
        // cwd may be unreadable (deleted dir) — fall through to session workspace
    }
    if (cwd && cwd !== sep && cwd !== homedir())
        return cwd;
    const session = process.env.DSH_SESSION_JSONL;
    if (session) {
        const m = session.match(/\/sessions\/([^/]+)\//);
        const encoded = m ? m[1] : undefined;
        if (encoded && encoded.startsWith('--') && encoded.endsWith('--')) {
            try {
                const decoded = decodeURIComponent(encoded.slice(2, -2).replace(/~/g, '%'));
                // The workspace encoding drops the leading root separator (`/Volumes/…`
                // → `Volumes-…`), so re-attach it when absent. `~<hex>` → `%<hex>` is
                // the documented percent spelling; '-' doubles as the '/' separator, so
                // literal dashes in a path cannot round-trip — verify the result exists
                // and fall through otherwise.
                const candidate = decoded && !decoded.startsWith(sep) ? sep + decoded : decoded;
                if (candidate && candidate.startsWith(sep) && existsSync(candidate))
                    return candidate;
            }
            catch {
                // malformed encoding — fall through to cwd
            }
        }
    }
    return cwd || sep;
}
