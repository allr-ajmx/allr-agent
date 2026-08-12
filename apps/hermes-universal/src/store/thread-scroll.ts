import { atom, computed, type ReadableAtom } from '@/store/atom'

// "Is the thread parked at the bottom" is owned by use-stick-to-bottom inside
// ThreadMessageList (the scroll container). That state lives only in that
// subtree, so ThreadMessageList mirrors it out here for the composer, status
// stack, and floating jump button — all of which render OUTSIDE the thread.
//
// KEYED BY SESSION (MJXHRM-381). These used to be two global booleans, which is
// only correct while one transcript is mounted. Universal mounts a whole
// ChatScreen — thread, composer, status stack, jump button — PER TILE, so a
// global made every other tile's composer and status stack dim (and re-render)
// when you scrolled up in one of them, closing a tile un-dimmed a tile that was
// still scrolled up, and one tile's jump button fired every mounted thread's
// `scrollToBottom`. Session-scoped is the same shape the blocking prompts
// already moved to (`store/prompts.ts` → `sessionApprovalRequest`), and for the
// same reason.
//
// "Scrolled up" dims the composer / status stack; "jump button visible" shows
// the floating jump control. Both track `!isAtBottom` today, but stay separate
// so their thresholds can diverge again without touching consumers.

/** A session with no runtime key yet (a draft the store has not keyed) shares
 *  one slot. Only one un-keyed transcript can be mounted, so it cannot collide. */
const keyOf = (sessionKey: null | string | undefined) => sessionKey ?? ''

/**
 * A per-session boolean flag held as a PRESENCE map: `true` means the key is in
 * the record. Presence keeps `false` free of storage (a settled thread leaves
 * nothing behind) and makes the per-key `computed` collapse to a boolean, which
 * nanostores dedupes by `===` — so one session's scroll never notifies another
 * session's subscriber.
 */
function keyedFlag() {
  const $all = atom<Record<string, true>>({})
  const perKey = new Map<string, ReadableAtom<boolean>>()

  return {
    forKey(sessionKey: null | string | undefined): ReadableAtom<boolean> {
      const key = keyOf(sessionKey)
      const existing = perKey.get(key)

      if (existing) {
        return existing
      }

      const derived = computed($all, all => key in all)
      perKey.set(key, derived)

      return derived
    },
    set(sessionKey: null | string | undefined, on: boolean) {
      const key = keyOf(sessionKey)
      const current = $all.get()

      // Skip no-op writes so subscribers don't churn on every scroll tick.
      if (on === key in current) {
        return
      }

      if (on) {
        $all.set({ ...current, [key]: true })

        return
      }

      const { [key]: _cleared, ...rest } = current
      $all.set(rest)
    }
  }
}

const scrolledUp = keyedFlag()
const jumpVisible = keyedFlag()

/** Does THIS session's thread sit away from the bottom (dim its composer)? */
export const sessionThreadScrolledUp = (sessionKey: null | string | undefined): ReadableAtom<boolean> =>
  scrolledUp.forKey(sessionKey)

/** Should THIS session's floating jump control be showing? */
export const sessionThreadJumpVisible = (sessionKey: null | string | undefined): ReadableAtom<boolean> =>
  jumpVisible.forKey(sessionKey)

export const setThreadAtBottom = (sessionKey: null | string | undefined, isAtBottom: boolean) => {
  scrolledUp.set(sessionKey, !isAtBottom)
  jumpVisible.set(sessionKey, !isAtBottom)
}

export const resetThreadScroll = (sessionKey: null | string | undefined) => setThreadAtBottom(sessionKey, true)

// Cross-component bridge: the jump button lives by the composer, the viewport's
// `scrollToBottom` lives inside the thread. The bridge registers a handler; the
// button fires it. Mirrors the composer focus/insert emitter pattern — and is
// keyed by session for the same reason as the flags above, so a tile's button
// pins ITS transcript rather than every mounted one.
const handlers = new Map<string, Set<() => void>>()

export const onScrollToBottomRequest = (sessionKey: null | string | undefined, handler: () => void) => {
  const key = keyOf(sessionKey)
  const forKey = handlers.get(key) ?? new Set<() => void>()
  forKey.add(handler)
  handlers.set(key, forKey)

  return () => {
    forKey.delete(handler)

    if (forKey.size === 0) {
      handlers.delete(key)
    }
  }
}

export const requestScrollToBottom = (sessionKey: null | string | undefined) =>
  handlers.get(keyOf(sessionKey))?.forEach(handler => handler())

// Inline edit grows a sticky human bubble. Fire on pointerdown so the viewport
// escapes stick-to-bottom before focus/layout; close clears the edit flag when
// the inline composer unmounts.
//
// FLAG(chat-port): inline message edit needs the branching runtime (blocked in
// universal), so these edit-hold emitters have no producer today — the sticky
// list still registers the handlers so the mechanism lights up once edit lands.
const editOpenHandlers = new Set<() => void>()
const editCloseHandlers = new Set<() => void>()

export const onThreadEditOpen = (handler: () => void) => {
  editOpenHandlers.add(handler)

  return () => void editOpenHandlers.delete(handler)
}

export const notifyThreadEditOpen = () => editOpenHandlers.forEach(handler => handler())

export const onThreadEditClose = (handler: () => void) => {
  editCloseHandlers.add(handler)

  return () => void editCloseHandlers.delete(handler)
}

export const notifyThreadEditClose = () => editCloseHandlers.forEach(handler => handler())
