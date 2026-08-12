/**
 * Structural sharing for polled server snapshots (MJXHRM-383).
 *
 * Every sidebar list is re-fetched wholesale — `refreshSessions`,
 * `refreshMessagingSessions`, `refreshProjectTree`, `fetchProjectSessions` all
 * run on a settle/broadcast/focus cadence and hand back JSON that was parsed
 * fresh. Storing that verbatim mints a NEW object for every row on every poll,
 * even when not one byte changed.
 *
 * That is what actually defeated the sidebar's memoization. `SidebarSessionRow`
 * is `memo(…, rowPropsEqual)` and its comparator resolves the whole row down to
 * `Object.is(prev.session, next.session)` — the handler props are deliberately
 * ignored. So the boundary can only bail when the row OBJECT survives the
 * refresh, and it never did: a poll every ~10s re-rendered every mounted row in
 * every lane for nothing. Stabilizing the handlers above it (PR #132) could not
 * reach this, because handler identity is not what the comparator reads.
 *
 * Upstream desktop hit the same thing and gates its swap on a row signature
 * (`sameCronSignature` in `lib/session-signatures.ts`, used by
 * `use-session-list-actions.ts`): "a refresh that returns content-identical rows
 * must keep the previous array identity, or every sidebar memo keyed on
 * $sessions recomputes". Universal's port dropped the gate. This is that idea,
 * generalized two ways it needs to be here:
 *
 *  - PER ROW, not per array. Upstream swaps the entire array when any row moved,
 *    so one streaming session's `last_active` tick still re-renders every other
 *    row. Reusing unchanged rows individually is what makes an update to session
 *    A leave row B alone.
 *  - KEYED BY `id`, not by index. The recents list is recency-ordered, so a
 *    session that gets a message jumps to the head and shifts everything below
 *    it. Index-aligned comparison would call all of those changed.
 *
 * Returning the PREVIOUS array (not a copy) when nothing moved matters on its
 * own: `nanostores`' `atom.set` skips notification entirely when the new value
 * is `===` the old one, so an idle poll stops re-rendering the subscriber too.
 *
 * Only for JSON-shaped data: plain objects, arrays and primitives. Anything else
 * (Date, Map, class instance, function) is passed through unexamined, so it can
 * never be reported equal by mistake.
 */

/** Plain-object test that rejects class instances, Date, Map, … */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

/** The `id` an array element is matched by, when it has one. */
function keyOf(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.id === 'string' ? value.id : undefined
}

function reuseArray(previous: readonly unknown[], incoming: readonly unknown[]): readonly unknown[] {
  const byId = new Map<string, unknown>()

  for (const item of previous) {
    const key = keyOf(item)

    // First wins: a duplicate id is already a React key collision upstream of
    // here, and either copy is equally valid to reuse.
    if (key !== undefined && !byId.has(key)) {
      byId.set(key, item)
    }
  }

  let unmoved = previous.length === incoming.length
  let borrowed = false

  const merged = incoming.map((item, index) => {
    const key = keyOf(item)
    // Keyed when the element carries an id, positional otherwise (worktree
    // lists, string arrays) — a reorder must not cost every row its identity.
    const candidate = key !== undefined && byId.has(key) ? byId.get(key) : previous[index]
    const shared = reuse(candidate, item)

    if (!Object.is(shared, previous[index])) {
      unmoved = false
    }

    if (!Object.is(shared, item)) {
      borrowed = true
    }

    return shared
  })

  if (unmoved) {
    return previous
  }

  // Nothing was borrowed, so `merged` is an element-wise copy of `incoming` —
  // hand back the original rather than an equivalent new array.
  return borrowed ? merged : incoming
}

function reuseObject(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(incoming)
  // A differing key SET is a real difference even when every shared value
  // matches — `{a: 1}` and `{a: 1, b: undefined}` spread differently.
  let unchanged = keys.length === Object.keys(previous).length
  let borrowed = false
  const merged: Record<string, unknown> = {}

  for (const key of keys) {
    if (!Object.hasOwn(previous, key)) {
      unchanged = false
    }

    const shared = reuse(previous[key], incoming[key])
    merged[key] = shared

    if (!Object.is(shared, previous[key])) {
      unchanged = false
    }

    if (!Object.is(shared, incoming[key])) {
      borrowed = true
    }
  }

  if (unchanged) {
    return previous
  }

  // Nothing under this node survived, so `merged` is a plain copy of `incoming`.
  return borrowed ? merged : incoming
}

function reuse(previous: unknown, incoming: unknown): unknown {
  if (Object.is(previous, incoming)) {
    return previous
  }

  if (Array.isArray(incoming)) {
    return Array.isArray(previous) ? reuseArray(previous, incoming) : incoming
  }

  if (isPlainObject(incoming) && isPlainObject(previous)) {
    return reuseObject(previous, incoming)
  }

  return incoming
}

/**
 * Return `incoming` with every part that is deep-equal to `previous` replaced by
 * the object `previous` already held — so an unchanged snapshot comes back as
 * literally the same reference, and a snapshot with one changed row comes back
 * with exactly one new object.
 *
 * The result is always structurally equal to `incoming`; only identities are
 * borrowed. Never mutates either argument.
 */
export function reuseUnchanged<T>(previous: unknown, incoming: T): T {
  return reuse(previous, incoming) as T
}
