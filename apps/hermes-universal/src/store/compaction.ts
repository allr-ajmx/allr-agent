/**
 * Context compaction, per session.
 *
 * When a turn runs out of headroom the gateway summarizes the conversation
 * mid-turn and carries on. The client has to know, for two reasons:
 *
 *  1. The composer must not try to REDIRECT a compacting turn. There is no live
 *     model request to interrupt — the turn is inside a summarize call — so a
 *     correction typed there has to queue for the next turn instead of being
 *     dropped on the floor (MJXHRM-78 / upstream #69783).
 *  2. Compaction is silent otherwise. It has no `message.start` of its own and
 *     no visible output, so without a flag the chat just sits there.
 *
 * The awkward part is knowing when it ENDS. `status.update{kind:'compacted'}`
 * is not guaranteed — a mid-turn compaction resumes straight into model output
 * — so the first piece of real output after a compaction is treated as proof
 * that summarizing finished. Desktop keeps the same two-part state
 * (`$compactingSessions` + a `compactedTurnRef` set); here the second half
 * lives on the turn record, which already survives a rekey.
 */

import { computed, type ReadableAtom } from 'nanostores'

import { atom } from '@/store/atom'
import { $activeSessionKey, addSessionKeyHooks } from '@/store/session-state-types'
import { observeTurnLifecycle, setTurnCompacting } from '@/store/turn-lifecycle'

/** Session key → compacting. Presence is the flag; there is no other state. */
export const $compactingSessions = atom<Record<string, true>>({})

const perSession = new Map<string, ReadableAtom<boolean>>()

/** Whether ONE session is compacting. Memoized, so a tile's composer can
 *  subscribe without the active session's state bleeding into it. */
export function sessionCompacting(key: null | string | undefined): ReadableAtom<boolean> {
  const id = key?.trim() || ''
  const existing = perSession.get(id)

  if (existing) {
    return existing
  }

  const derived = computed($compactingSessions, sessions => id in sessions)
  perSession.set(id, derived)

  return derived
}

/** The chat on screen. */
export const $activeSessionCompacting = computed(
  [$activeSessionKey, $compactingSessions],
  (key, sessions) => key in sessions
)

export function setSessionCompacting(key: null | string | undefined, active: boolean): void {
  const id = key?.trim()

  if (!id) {
    return
  }

  const current = $compactingSessions.get()

  if (active === id in current) {
    return
  }

  if (active) {
    $compactingSessions.set({ ...current, [id]: true })
  } else {
    const { [id]: _dropped, ...rest } = current
    $compactingSessions.set(rest)
  }

  // Mirror onto the turn record so anything reading turn state (the journal,
  // the steer gate) sees one consistent answer rather than two stores that can
  // disagree.
  setTurnCompacting(id, active)
}

/**
 * Sessions whose CURRENT turn compacted at some point.
 *
 * Kept separately from the live flag because the two answer different
 * questions: the flag is "is it summarizing right now" (which the resume
 * heuristic below clears on the first output), while this is "did this turn
 * compact at all", which stays true until the turn ends. Desktop's
 * `compactedTurnRef`.
 */
const compactedTurns = new Set<string>()

/**
 * Did the session's current turn compact? Read-only; cleared when the turn ends.
 *
 * Exported and tested but UNCONSUMED, deliberately. Desktop's one caller
 * (`use-message-stream`) uses it to skip the stored-session re-hydrate it runs
 * after a completed turn, because a compaction has already rewritten that
 * transcript. Universal has no such re-hydrate — it streams into the session's
 * slice and reads the REST transcript only when opening a cold session — so
 * there is nothing here for this to gate.
 *
 * It stays as the hook for whoever ports that refetch. If they do, it must route
 * through `reconcileLiveTail` rather than replacing the slice outright.
 */
export const turnCompacted = (key: string): boolean => compactedTurns.has(key)

/** Events that prove summarizing finished and the turn is producing again.
 *  Mid-turn compaction emits no second `message.start`, so this is the only
 *  end-signal on that path. */
const COMPACTION_RESUME_EVENT_TYPES = new Set([
  'message.delta',
  'message.interim',
  'moa.aggregating',
  'moa.phase',
  'moa.progress',
  'moa.reference',
  'reasoning.available',
  'reasoning.delta',
  'thinking.delta',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'tool.start'
])

/**
 * Fold a gateway event into compaction state. Called by `store/event-router.ts`
 * for the session that owns the event.
 */
export function routeCompactionEvent(key: string, eventType: string, payload: Record<string, unknown>): void {
  if (eventType === 'status.update') {
    const kind = typeof payload.kind === 'string' ? payload.kind : ''

    if (kind === 'compacting') {
      compactedTurns.add(key)
      setSessionCompacting(key, true)
    } else if (kind === 'compacted') {
      setSessionCompacting(key, false)
    }

    return
  }

  // A fresh turn, or a dead one: neither carries the previous turn's compaction.
  if (eventType === 'message.start' || eventType === 'message.complete' || eventType === 'error') {
    compactedTurns.delete(key)
    setSessionCompacting(key, false)

    return
  }

  // The turn resumed. Clear the live flag but KEEP the "this turn compacted"
  // mark — consumers that care about the whole turn (a post-turn transcript
  // refetch would repaint the summarized history over what the user just
  // watched stream in) still need it until the turn actually ends.
  if (COMPACTION_RESUME_EVENT_TYPES.has(eventType) && compactedTurns.has(key)) {
    setSessionCompacting(key, false)
  }
}

// A turn cannot outlive its session. Settling through any path — a terminal
// frame, a failed submit, reconnect reconciliation deciding the turn is gone —
// releases the flag, so a compaction interrupted by a disconnect can't leave
// the composer permanently refusing to steer.
observeTurnLifecycle(({ key, turn }) => {
  if (!turn || turn.phase === 'settled') {
    compactedTurns.delete(key)
    setSessionCompacting(key, false)
  }
})

/**
 * Compaction state is keyed by SESSION KEY, so it has to make the same key moves
 * the slice makes — the contract `store/session-state-types.ts` documents and
 * that `store/prompts.ts` and `store/turn-lifecycle.ts` already sign up to. This
 * module never did (MJXHRM-308).
 *
 * A rekey happens mid-compaction more often than it looks: a stale-runtime
 * recovery rekeys on the first verb back, and `reconcileSessionTurn` rekeys on
 * every reconnect that finds a restarted gateway. Left stranded under the dead
 * key, the flag says "not compacting" for a session that is — so the composer
 * lets a correction go out as a redirect against a turn with no live model
 * request to redirect, which is exactly what this flag exists to prevent — and
 * the entry itself never expires, because the settle observer below clears the
 * LIVE key.
 */
addSessionKeyHooks({
  drop(key) {
    compactedTurns.delete(key)
    setSessionCompacting(key, false)
    perSession.delete(key)
  },
  rekey(fromKey, toKey) {
    if (compactedTurns.delete(fromKey)) {
      compactedTurns.add(toKey)
    }

    const sessions = $compactingSessions.get()

    if (fromKey in sessions) {
      const { [fromKey]: _moved, ...rest } = sessions
      $compactingSessions.set({ ...rest, [toKey]: true })
    }

    perSession.delete(fromKey)
  }
})

/** Wipe every session's compaction state — profile switch, gateway teardown. */
export function clearAllCompaction(): void {
  compactedTurns.clear()

  if (Object.keys($compactingSessions.get()).length > 0) {
    $compactingSessions.set({})
  }
}
