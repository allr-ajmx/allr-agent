/**
 * The SAME-WINDOW composer draft bus.
 *
 * One `CustomEvent` on `window`, and deliberately nothing else: no imports, no
 * state, no storage. Its two jobs are to tell whatever composer is MOUNTED in
 * THIS webview to write its half-typed text into the shared stash (`flush`), and
 * to tell it to re-read that stash after another window wrote to it (`reload`).
 *
 * ── Why it does not live in `store/composer.ts`, where its callers are ───────
 * Because `store/windows.ts` has to flush too. Every window kind it builds boots
 * the app and seeds its drafts from the shared stash as it mounts, so the window
 * that ordered one has to have written its editor down first (MJXHRM-398) — and
 * `windows.ts` cannot reach into `store/composer.ts` for that: since MJXHRM-424
 * the composer store imports the window store (a peer flush is ADDRESSED to a
 * window), so an edge back would close a cycle.
 *
 * That is the mechanical reason; the design one has the same shape. Dispatching
 * this event is not composer STATE — it is a request to whoever is listening,
 * and it depends on nothing. A module with no dependencies can be imported by
 * anybody, which is exactly the property a flush needs to be callable from the
 * place windows are actually created.
 *
 * ── The synchronous guarantee ────────────────────────────────────────────────
 * `requestComposerDraftSync('flush')` is synchronous end to end: `dispatchEvent`
 * runs the mounted composer's listener inline, which stashes, which writes
 * `localStorage` — all before it returns. Every caller leans on that, because
 * every caller is about to create or destroy a window. Nothing here may become
 * async.
 */

/** `flush`: write what is in the editor to the stash NOW, before another window
 *  reads it. `reload`: re-read the stash into a composer whose scope did not
 *  change — otherwise the only thing that makes it re-consult the stash is a
 *  session swap, and a handoff is not one. */
export type ComposerDraftSyncMode = 'flush' | 'reload'

const DRAFT_SYNC_EVENT = 'hermes:composer-draft-sync'

export function requestComposerDraftSync(mode: ComposerDraftSyncMode): void {
  try {
    window.dispatchEvent(new CustomEvent(DRAFT_SYNC_EVENT, { detail: mode }))
  } catch {
    // No DOM — nothing is mounted to answer anyway.
  }
}

export function onComposerDraftSyncRequest(handler: (mode: ComposerDraftSyncMode) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<ComposerDraftSyncMode>).detail)

  window.addEventListener(DRAFT_SYNC_EVENT, listener)

  return () => window.removeEventListener(DRAFT_SYNC_EVENT, listener)
}
