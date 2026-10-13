/**
 * src/working-directory.ts — follow dsh's mutable session working directory.
 *
 * Upstream history:
 *   - through dsh 0.2.1-alpha.1 the session's working directory WAS the
 *     immutable `Session.header.cwd`, so reading `exec.agent.session.header.cwd`
 *     was authoritative;
 *   - dsh 0.2.1-alpha.2 added the `working_directory` tool and the
 *     `WorkingDirectoryService` (`@deepseek-ai/dsh-working-directory`), whose
 *     contract explicitly states "the immutable Session header retains the
 *     ORIGINAL project" while `working-directory/change` events record the
 *     current one. After a model/user switches directories mid-session,
 *     `header.cwd` is therefore stale BY DESIGN.
 *
 * The iterate plugin resolves the project root (where `.iterate/` lives, where
 * fixes are written, and — critically — which workspace the F8 approval policy
 * is read from) from the session cwd. Sticking to `header.cwd` on a host that
 * supports directory switches would silently operate on the wrong project:
 * reviews would anchor to the original checkout while the model edits files
 * elsewhere, and a `deny` policy in the active workspace would be read from
 * the original one.
 *
 * So the effective directory is resolved through the host's service when it
 * exists, and degrades to `header.cwd` otherwise:
 *   - feature-detected (`ctx.get('workingDirectory')`) — hosts older than
 *     0.2.1-alpha.2 simply have no such service and keep the old behavior;
 *   - `service.get(session)` is the service's synchronous, I/O-free read of
 *     the committed directory, so this stays safe on the approval path;
 *   - every failure mode (no service, service throws, hostile getters, a
 *     non-string result) falls back to `header.cwd`, never to `undefined`
 *     where a header cwd exists.
 *
 * The service object is fetched lazily on every call, not once at plugin
 * apply: dsh may register the service after this plugin loads, and a disposed
 * context must degrade rather than cache a dead handle.
 */

/** Minimal structural view of dsh's `WorkingDirectoryService` (0.2.1-alpha.2+). */
interface WorkingDirectoryServiceLike {
  get(session: unknown): string
}

/** Minimal structural view of the cordis context surface this module uses. */
interface ContextLike {
  get?(name: string, strict?: boolean): unknown
}

/** The plugin context, installed once by `apply()`; null on hosts without it. */
let installedContext: ContextLike | null = null

/** True when `value` looks like a cordis context carrying `ctx.get`. */
function isContextLike(value: unknown): value is ContextLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ContextLike).get === 'function'
  )
}

/**
 * Install the plugin context used to look up the `workingDirectory` service.
 * Passing anything without a callable `get` clears the installation (tests and
 * hosts that load the plugin into a degraded context).
 */
export function installWorkingDirectoryContext(ctx: unknown): void {
  installedContext = isContextLike(ctx) ? ctx : null
}

/** Forget the installed context (test isolation / unload). */
export function resetWorkingDirectoryContext(): void {
  installedContext = null
}

/**
 * Read the host's committed working directory for `session`, if the host
 * provides the service and it answers with a usable absolute path.
 *
 * Returns `undefined` for every degradation path so callers keep their
 * previous `header.cwd` behavior.
 */
function serviceWorkingDirectory(session: unknown): string | undefined {
  if (session === undefined || session === null) return undefined
  const ctx = installedContext
  if (!ctx) return undefined
  try {
    const service = ctx.get?.('workingDirectory')
    if (!service || typeof (service as WorkingDirectoryServiceLike).get !== 'function') return undefined
    const dir = (service as WorkingDirectoryServiceLike).get(session)
    // A relative or empty directory would move the project root somewhere
    // unspecified — refuse it and keep the header value instead.
    if (typeof dir !== 'string' || dir.length === 0) return undefined
    return dir
  } catch {
    // Missing/disposed service, unpublished session, or a throwing getter —
    // degrade to the historical source rather than failing the tool call.
    return undefined
  }
}

/**
 * The effective working directory of a session: the host's committed
 * directory when available, else the immutable session header cwd.
 *
 * Returns `undefined` only when neither source yields a usable path.
 */
export function effectiveSessionCwd(session: unknown, headerCwd?: string): string | undefined {
  const fromService = serviceWorkingDirectory(session)
  if (fromService !== undefined) return fromService
  return typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : undefined
}

/**
 * Extract the effective cwd from a tool execution (`exec.agent.session`),
 * reading every property defensively: a hostile/proxied exec must degrade to
 * the fallback path, never throw out of an approval or capture hook.
 */
export function sessionCwdOf(exec: unknown): string | undefined {
  try {
    const agent = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | null | undefined)?.agent
    const session = agent?.session
    const headerCwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined
    return effectiveSessionCwd(session, headerCwd)
  } catch {
    return undefined
  }
}
