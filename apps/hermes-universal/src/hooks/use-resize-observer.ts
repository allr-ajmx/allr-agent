import { type RefObject, useLayoutEffect, useRef } from 'react'

import { throttleDuringResize } from '@/lib/resize-gesture'

/**
 * Observe element resizes. The callback receives the ResizeObserver entries
 * (empty only in non-RO environments) so callers can read the observed size
 * off the entry instead of forcing a fresh layout read.
 *
 * The initial measurement rides the observer's spec-guaranteed first delivery
 * (same frame, after layout, before paint) instead of a synchronous call from
 * the layout effect. A sync call here runs while the commit's layout is still
 * dirty, so any size read in the callback forces a full reflow — and with many
 * instances mounting at once (every user bubble on a session switch), the
 * interleaved read→write→read pattern cascades into seconds of layout thrash.
 * Inside RO timing, layout is already clean and the same reads are ~free.
 *
 * ONE observer is shared by every caller. A private `new ResizeObserver` per
 * hook instance means the browser delivers one callback PER CONSUMER when a
 * common ancestor resizes, and each of those is a separate trip through the
 * observer machinery. A single shared observer batches the same work into one
 * delivery carrying many entries.
 *
 * Measured on a sash drag with five mounted session tiles (~100 user bubbles):
 * 2,600 callbacks across 40 pointermoves — 65 separate callbacks per frame,
 * each carrying exactly one entry — and 977ms of script time attributed to
 * this file. Batching collapses that to one callback per frame.
 *
 * Batching fixed the DELIVERY count, not the work: one callback a frame still
 * fans out to every handler, so ~100 bubbles is ~100 measure-and-setState passes
 * per frame of a drag. So deliveries are additionally THROTTLED while a resize
 * gesture is running (lib/resize-gesture.ts) — untouched at every other time, so
 * mount measurement and a composer growing as you type behave exactly as before.
 */

type Handler = (entries: readonly ResizeObserverEntry[]) => void

/** Live target → handler routing for the shared observer. */
const handlers = new WeakMap<Element, Set<Handler>>()

let shared: null | ResizeObserver = null

/**
 * Entries awaiting delivery, keyed by target so a throttled flush carries the
 * LATEST size per element. Without this, a deferred delivery would replay a
 * stale rect — and mid-drag every rect but the last one is stale.
 */
const queued = new Map<Element, ResizeObserverEntry>()

/** Fan the queued entries out, grouped so a caller observing several elements is
 *  invoked once with all of its entries — the contract a private observer gave. */
const deliver = () => {
  if (queued.size === 0) {
    return
  }

  const entries = [...queued.values()]

  queued.clear()

  const byHandler = new Map<Handler, ResizeObserverEntry[]>()

  for (const entry of entries) {
    const targets = handlers.get(entry.target)

    if (!targets) {
      continue
    }

    for (const handler of targets) {
      const list = byHandler.get(handler)

      if (list) {
        list.push(entry)
      } else {
        byHandler.set(handler, [entry])
      }
    }
  }

  for (const [handler, group] of byHandler) {
    handler(group)
  }
}

// 'chat' because the dominant consumer by count is the transcript's per-bubble
// clamp measurement; the category is what a future optimization profile keys on.
const deliverThrottled = throttleDuringResize('chat', deliver)

function sharedObserver(): null | ResizeObserver {
  if (typeof ResizeObserver === 'undefined') {
    return null
  }

  if (!shared) {
    shared = new ResizeObserver(entries => {
      for (const entry of entries) {
        queued.set(entry.target, entry)
      }

      deliverThrottled()
    })
  }

  return shared
}

export function useResizeObserver(
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
  ...refs: readonly RefObject<Element | null>[]
) {
  const refsRef = useRef(refs)
  refsRef.current = refs

  useLayoutEffect(() => {
    const observer = sharedObserver()

    if (!observer) {
      onResize([])

      return
    }

    const observed: Element[] = []

    for (const ref of refsRef.current) {
      const element = ref.current

      if (!element) {
        continue
      }

      const existing = handlers.get(element)

      if (existing) {
        existing.add(onResize)
      } else {
        handlers.set(element, new Set([onResize]))
        // Only the first handler for an element needs to register it; the
        // observer fires once per element regardless of how many care.
        observer.observe(element)
      }

      observed.push(element)
    }

    if (observed.length === 0) {
      return
    }

    return () => {
      for (const element of observed) {
        const set = handlers.get(element)

        if (!set) {
          continue
        }

        set.delete(onResize)

        if (set.size === 0) {
          handlers.delete(element)
          observer.unobserve(element)
        }
      }
    }
  }, [onResize])
}
