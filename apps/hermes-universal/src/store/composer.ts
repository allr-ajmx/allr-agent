import type { StagedAttachment } from '@/app/chat/attachments'
import { requestComposerDraftSync } from '@/lib/composer-draft-bus'
import { deriveDraftTitle } from '@/lib/draft-title'
import { triggerHaptic } from '@/lib/haptics'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_TAURI } from '@/lib/platform'
import { broadcastToPeers, listenToPeers, onPeerBroadcast, type PeerBroadcast } from '@/lib/webview-broadcast'
import { WEBVIEW_ID } from '@/lib/webview-id'
import { atom } from '@/store/atom'
import { addressesThisWindow, type WindowAddress } from '@/store/windows'

// ===========================================================================
// LEGACY LEAN SHIM (pre-port). Kept so the two existing non-composer consumers
// (app/chat/use-file-drop.ts → addStaged; app/chat/chat-screen.tsx →
// enqueue/pushHistory) keep compiling during the desktop-composer port. These
// are migrated to the scope/queue/history model in the mount-wiring phase, then
// this section is removed.
// ===========================================================================

// Composer input history (persisted) + a send-while-busy queue (Gc7).

const MAX_HISTORY = 50

export const $history = persistentAtom<string[]>('hermes.composerHistory', [], Codecs.stringArray)
export const $queue = atom<string[]>([])

// Staged attachments live in a shared store (not composer-local state) so the
// whole-chat file-drop handler and the composer's chips operate on one list.
export const $staged = atom<StagedAttachment[]>([])

// Open flag for the composer context menu / attachment dropdown panel.
export const $attachmentMenuDropdownOpen = atom(false)
export const setAttachmentMenuDropdownOpen = (value: boolean): void => $attachmentMenuDropdownOpen.set(value)

export function addStaged(attachment: StagedAttachment): void {
  $staged.set([...$staged.get(), attachment])
}

export function removeStagedAt(index: number): void {
  $staged.set($staged.get().filter((_, i) => i !== index))
}

export function clearStaged(): void {
  $staged.set([])
}

export function pushHistory(text: string): void {
  const value = text.trim()

  if (!value) {
    return
  }

  const prev = $history.get().filter(h => h !== value)
  $history.set([value, ...prev].slice(0, MAX_HISTORY))
}

export function enqueue(text: string): void {
  $queue.set([...$queue.get(), text])
}

export function dequeue(): string | undefined {
  const q = $queue.get()

  if (q.length === 0) {
    return undefined
  }

  $queue.set(q.slice(1))

  return q[0]
}

/** Remove and return the queued prompt at `index` (queue-panel send-now/delete). */
export function removeQueuedAt(index: number): string | undefined {
  const q = $queue.get()

  if (index < 0 || index >= q.length) {
    return undefined
  }

  const removed = q[index]
  $queue.set([...q.slice(0, index), ...q.slice(index + 1)])

  return removed
}

// ===========================================================================
// PORTED FROM DESKTOP (apps/desktop/src/store/composer.ts). The scoped-
// attachment + per-session draft model the ported ChatBar composer depends on.
// Only seam change vs desktop: `@/lib/haptics` → `@/store/haptics`.
// ===========================================================================

export interface ComposerAttachment {
  id: string
  kind: 'image' | 'file' | 'folder' | 'terminal' | 'url'
  label: string
  detail?: string
  refText?: string
  previewUrl?: string
  path?: string
  attachedSessionId?: string
  /** Set while the file/image bytes are being staged into the session
   * workspace (remote upload or local stage), and 'error' if that failed.
   * Drives the spinner / error state on the composer attachment card. */
  uploadState?: 'uploading' | 'error'
}

export const $composerAttachments = atom<ComposerAttachment[]>([])
export const $composerTerminalSelections = atom<Record<string, string>>({})

// ---------------------------------------------------------------------------
// Composer scopes — one live attachment set PER MOUNTED COMPOSER. The main
// chat's scope wraps the module-level atom above (all existing readers keep
// working); each session tile creates its own so two composers on screen
// never share chips. Draft text needs no scope: it lives in each ChatBar's
// DOM + draftRef and stashes per session key already.
// ---------------------------------------------------------------------------

export interface ComposerAttachmentScope {
  $attachments: ReturnType<typeof atom<ComposerAttachment[]>>
  add(attachment: ComposerAttachment): void
  clear(): void
  remove(id: string): ComposerAttachment | null
  setUploadState(id: string, uploadState?: ComposerAttachment['uploadState']): void
  update(attachment: ComposerAttachment): boolean
}

export function createComposerAttachmentScope($attachments = atom<ComposerAttachment[]>([])): ComposerAttachmentScope {
  return {
    $attachments,
    add(attachment) {
      const previous = $attachments.get()
      const next = upsertAttachment(previous, attachment)
      $attachments.set(next)

      if (next.length > previous.length && attachment.kind !== 'url') {
        triggerHaptic('selection')
      }
    },
    clear() {
      $attachments.set([])
    },
    remove(id) {
      const current = $attachments.get()
      const removed = current.find(attachment => attachment.id === id) || null
      $attachments.set(current.filter(attachment => attachment.id !== id))

      return removed
    },
    setUploadState(id, uploadState) {
      const current = $attachments.get()
      const index = current.findIndex(attachment => attachment.id === id)

      if (index < 0) {
        return
      }

      const next = [...current]
      next[index] = { ...next[index]!, uploadState }
      $attachments.set(next)
    },
    update(attachment) {
      const current = $attachments.get()
      const index = current.findIndex(item => item.id === attachment.id)

      if (index < 0) {
        return false
      }

      const next = [...current]
      next[index] = attachment
      $attachments.set(next)

      return true
    }
  }
}

/** The main chat's scope — the module-level atom, so every existing
 *  `$composerAttachments` reader/writer IS this scope. */
export const mainComposerScope = createComposerAttachmentScope($composerAttachments)

// Per-thread draft stash for the decoupled composer. Session lifecycle never
// touches this — only ChatBar's scope swap reads/writes it. Text mirrors to
// localStorage; attachments are memory-only (blobs, upload state).
export const SESSION_DRAFTS_STORAGE_KEY = 'hermes:composer-drafts:v3'

const NEW_SESSION_DRAFT_KEY = '__new__'
const MAX_PERSISTED_DRAFTS = 50
const EMPTY_SESSION_DRAFT: SessionDraft = { attachments: [], text: '' }

export interface SessionDraft {
  attachments: ComposerAttachment[]
  text: string
}

const draftKey = (scope: string | null | undefined) => scope?.trim() || NEW_SESSION_DRAFT_KEY

const cloneDraft = (draft: SessionDraft): SessionDraft => ({
  attachments: draft.attachments.map(attachment => ({ ...attachment })),
  text: draft.text
})

function loadPersistedDraftTexts(): [string, SessionDraft][] {
  try {
    const raw = window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY)

    if (!raw) {
      return []
    }

    return Object.entries(JSON.parse(raw) as Record<string, string>).map(([key, text]) => [
      key,
      { attachments: [], text }
    ])
  } catch {
    return []
  }
}

const draftsBySession = new Map<string, SessionDraft>(loadPersistedDraftTexts())

// --------------------------------------------------------------------------
// Draft naming
//
// A draft has no session, so it has no title to look up — and a tab holding a
// half-typed message reading "New session" says less than the message does. The
// name lives beside the text and moves with it: every debounced stash
// republishes it.
//
// An atom rather than a value threaded through the tab registration, because
// re-registering the contribution at typing cadence would re-render the whole
// panes area. `SessionDraftTitle` subscribes to its own key and nothing else.
// --------------------------------------------------------------------------

export const $draftTitles = atom<Record<string, string>>(
  Object.fromEntries(
    [...draftsBySession].map(([key, draft]) => [key, deriveDraftTitle(draft.text)]).filter(([, title]) => title)
  )
)

/** Read one scope's draft title out of a snapshot already in hand — the shape
 *  `useStoreSelector` wants, so another draft's rename bails out here. */
export function draftTitleIn(titles: Record<string, string>, scope: null | string | undefined): string {
  return titles[draftKey(scope)] ?? ''
}

export function draftTitleFor(scope: null | string | undefined): string {
  return draftTitleIn($draftTitles.get(), scope)
}

function publishDraftTitle(key: string, title: string): void {
  const current = $draftTitles.get()

  if ((current[key] ?? '') === title) {
    return
  }

  const next = { ...current }

  if (title) {
    next[key] = title
  } else {
    delete next[key]
  }

  $draftTitles.set(next)
}

/** What this window last wrote to the shared stash, so an unchanged write is not
 *  repeated and — the part that matters — is not announced.
 *
 *  `null` rather than `''` until the first write: an empty stash is a real value,
 *  and starting out equal to it would skip the `removeItem` that clears drafts
 *  left behind by the previous run. */
let lastPersistedDrafts: null | string = null

function persistDraftTexts() {
  const entries = [...draftsBySession]
    .filter(([, draft]) => draft.text)
    .slice(-MAX_PERSISTED_DRAFTS)
    .map(([key, draft]) => [key, draft.text] as const)

  const serialized = entries.length === 0 ? '' : JSON.stringify(Object.fromEntries(entries))

  // Nothing changed, so there is nothing to say. This is what keeps the
  // announcement below from ping-ponging: a peer that reloads paints its
  // composer, and painting schedules that composer's OWN debounced stash of the
  // very text it was just handed — which serializes identically and stops here
  // instead of being announced back.
  if (serialized === lastPersistedDrafts) {
    return
  }

  try {
    if (serialized === '') {
      window.localStorage.removeItem(SESSION_DRAFTS_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, serialized)
    }
  } catch {
    // Best-effort only — quota/private-mode must never break typing. Leaving
    // `lastPersistedDrafts` alone means the next keystroke retries, and
    // returning before the announcement means no peer is sent to read a write
    // that did not happen.
    return
  }

  lastPersistedDrafts = serialized

  // AFTER the write, always. A peer told about a stash it cannot read yet would
  // reload the PREVIOUS contents and paint them over the user's text.
  broadcastToPeers<ComposerDraftStashPayload>(DRAFT_STASH_EVENT, {})
}

export function stashSessionDraft(scope: string | null | undefined, text: string, attachments: ComposerAttachment[]) {
  const key = draftKey(scope)

  // Delete-then-set keeps MRU order for MAX_PERSISTED_DRAFTS eviction.
  draftsBySession.delete(key)

  if (text.trim() || attachments.length > 0) {
    draftsBySession.set(key, cloneDraft({ attachments, text }))
  }

  // The single funnel every composer's text flows through, so it is the one
  // place the draft's name has to be kept current.
  publishDraftTitle(key, deriveDraftTitle(text))
  persistDraftTexts()
}

export function takeSessionDraft(scope: string | null | undefined): SessionDraft {
  const stashed = draftsBySession.get(draftKey(scope))

  return stashed ? cloneDraft(stashed) : EMPTY_SESSION_DRAFT
}

export const clearSessionDraft = (scope: string | null | undefined) => stashSessionDraft(scope, '', [])

// --------------------------------------------------------------------------
// Cross-window drafts (MJXHRM-213; transport replaced in MJXHRM-424)
//
// A half-typed message has to survive moving between windows: summon the HUD
// mid-sentence and the sentence should be there; dismiss it and the main
// composer should have whatever you added. Every window here is its own webview
// with its own JS heap, and the TEXT travels through `localStorage`, which
// windows of one origin share.
//
// What does not travel through `localStorage` is the NEWS that it changed. The
// original port took desktop's `window.addEventListener('storage', …)`, which is
// sound in Electron — Chromium renderers of one origin all get it — and is a bet
// everywhere else: cross-process `storage` delivery is a WebKitGTK / WebView2 /
// Android-WebView implementation detail, and on Android the "windows" are
// activities in one process (MJXHRM-141) with no second renderer to notify. A
// bet that loses is silent — `reloadPersistedDrafts` simply never runs and the
// other surface keeps the copy it read at module init.
//
// So under Tauri the news rides the event bus (lib/webview-broadcast.ts), the
// same shape themes/appearance-sync.ts and terminal-font-sync.ts already use for
// "one webview changed something global". `storage` stays as the WEB fallback
// and ONLY there: running both would make "did the new transport work?"
// unanswerable, which is exactly how the old one shipped unverified.
//
// Two directions, because the two moments of a handoff are not symmetric:
//
//   • CHANGED is an announcement. It needs no acknowledgement — the text is on
//     disk, so a peer that misses the news still picks it up the next time it
//     consults the stash. Missing it costs a repaint, not a draft.
//   • FLUSH is a request, and it is the one that can lose text: a window another
//     window tears down runs no JS on the way out (see store/windows.ts — that
//     is why both the satellite and the tile close signals come from Rust), so
//     nothing writes down what was typed since its last debounce unless it is
//     ASKED to, and asked in time. Hence the acknowledgement:
//     `requestPeerComposerFlush` can tell "that window wrote its draft down"
//     from "nobody answered", and says which. Two callers today: dismissing the
//     HUD, and reattaching a detached tile.
//
// What this does NOT promise on Android: a webview whose activity Kotlin has
// already finished runs nothing, so an event cannot reach it and a draft held
// only in that heap is gone before any transport is involved. The guarantee here
// is between LIVE webviews of one process, which is what the desktop `storage`
// listener never gave at all.
//
// Attachments do not travel either way. They are blobs and upload state held in
// memory, and only draft TEXT is mirrored to storage.
// --------------------------------------------------------------------------

/** Announced when THIS webview changes the shared stash. Carries no draft: the
 *  text is already on disk, and a copy in the payload could only disagree with
 *  it. */
const DRAFT_STASH_EVENT = 'composer-draft://changed'

/** Asks ONE named window to write its editor down, and hears back.
 *
 *  Addressed rather than broadcast, even though the bus is global: several
 *  windows routinely hold the SAME draft scope — the HUD opens on the very
 *  conversation the summoning window is showing, and a detached tile IS the one
 *  its slot in the main window is holding — so asking all of them to flush would
 *  race their copies and let a stale one land last. */
const DRAFT_FLUSH_EVENT = 'composer-draft://flush'
const DRAFT_FLUSHED_EVENT = 'composer-draft://flushed'

type ComposerDraftStashPayload = PeerBroadcast

/** The address travels FLAT in the payload rather than nested, so the wire shape
 *  is one object and a receiver can hand the whole payload to
 *  `addressesThisWindow`. */
interface ComposerDraftFlushPayload extends PeerBroadcast, WindowAddress {
  /** Ties an answer to its question, so an unrelated flush cannot be mistaken
   *  for this one having been served. */
  nonce: string
}

interface ComposerDraftFlushedPayload extends PeerBroadcast {
  nonce: string
}

/** Merge whatever another window persisted back into this window's map. A
 *  merge, not a replace: locally-held attachments have to survive it. */
export function reloadPersistedDrafts(): void {
  const persisted = new Map(loadPersistedDraftTexts())

  // This window is no longer the last writer, so its dedupe baseline is stale:
  // without this, retyping exactly what we ourselves last wrote would compare
  // equal and silently skip the write, leaving storage on the PEER's newer text
  // while this composer shows something else.
  lastPersistedDrafts = null

  for (const [key, draft] of persisted) {
    const local = draftsBySession.get(key)

    // Delete-then-set to keep the MRU ordering the eviction rule depends on.
    draftsBySession.delete(key)
    draftsBySession.set(key, { attachments: local?.attachments ?? [], text: draft.text })
    publishDraftTitle(key, deriveDraftTitle(draft.text))
  }

  // A key that vanished from storage was sent or cleared in the other window.
  // Keep it here only while this window still holds attachments for it.
  for (const [key, draft] of [...draftsBySession]) {
    if (!persisted.has(key) && draft.attachments.length === 0) {
      draftsBySession.delete(key)
      publishDraftTitle(key, '')
    }
  }
}

// The same-window half of the draft sync — `requestComposerDraftSync` and
// `onComposerDraftSyncRequest` — lives in `lib/composer-draft-bus.ts`. It has no
// dependencies at all, which is what lets `store/windows.ts` flush before it
// builds a window without importing this module back (MJXHRM-398).

/** How long `requestPeerComposerFlush` waits for the window it asked.
 *
 *  Bounded because the caller is usually about to destroy that window and the
 *  user is watching: a peer that has gone away must not make dismissing the HUD
 *  feel stuck. Generous next to the round trip it covers (an `emit`, a
 *  synchronous stash, an `emit` back — single-digit milliseconds), so a timeout
 *  really does mean nobody was there. */
export const DRAFT_FLUSH_ACK_TIMEOUT_MS = 250

let flushRequestSeq = 0

/**
 * Ask the window at `address` to write its editor's text into the shared stash,
 * and wait until it says it has.
 *
 * Resolves `true` only when that window answered — which, because the flush it
 * runs is synchronous, means the text is on disk by the time this returns. `false`
 * means nobody answered: no such window, no event bus, or it died first. The
 * distinction is the point. A draft sync that emitted into a void and returned
 * cleanly would be indistinguishable from one that worked, and the caller here is
 * about to tear that window down.
 *
 * What it cannot tell you is whether the window that answered had a composer
 * MOUNTED. `requestComposerDraftSync` dispatches to whoever is listening, and a
 * window showing something else answers just the same. That is the honest limit
 * of this signal, and it is fine for both callers: a HUD or a detached terminal
 * tile with no composer has no draft to lose.
 *
 * Call it AFTER flushing this window (which is synchronous), so the peer's copy
 * of a shared scope lands on top of ours rather than under it.
 */
export async function requestPeerComposerFlush(
  address: WindowAddress,
  timeoutMs: number = DRAFT_FLUSH_ACK_TIMEOUT_MS
): Promise<boolean> {
  if (!IS_TAURI) {
    return false
  }

  flushRequestSeq += 1
  const nonce = `${WEBVIEW_ID}:${flushRequestSeq}`

  let settle: (heard: boolean) => void = () => undefined

  const answered = new Promise<boolean>(resolve => {
    settle = resolve
  })

  // Awaited, so the listener is registered BEFORE the request goes out. The
  // answer to a flush that finishes in a microsecond would otherwise arrive
  // before anything was listening for it, and a missed acknowledgement is
  // indistinguishable from a window that never wrote.
  const stop = await listenToPeers<ComposerDraftFlushedPayload>(DRAFT_FLUSHED_EVENT, payload => {
    if (payload.nonce === nonce) {
      settle(true)
    }
  })

  const timer = window.setTimeout(() => settle(false), timeoutMs)

  try {
    broadcastToPeers<ComposerDraftFlushPayload>(DRAFT_FLUSH_EVENT, { nonce, ...address })

    if (!(await answered)) {
      return false
    }
  } finally {
    window.clearTimeout(timer)
    stop()
  }

  // Take what it just wrote, so the caller can act on the draft without waiting
  // for the CHANGED announcement to come round separately.
  reloadPersistedDrafts()

  return true
}

// The receiving halves. Both are wired at module load, in every webview — a
// draft can move in either direction and neither window knows in advance which
// one it will be.

// A peer changed the shared stash. Pick it up and tell any mounted composer to
// repaint; without this the text only appears after the next session swap, which
// is to say usually never. Deliberately does NOT re-announce: a receiver that
// broadcast would circulate the event forever, and the dedupe in
// `persistDraftTexts` is what stops the repaint's own debounced re-stash from
// doing it by the back door.
onPeerBroadcast<ComposerDraftStashPayload>(DRAFT_STASH_EVENT, () => {
  reloadPersistedDrafts()
  requestComposerDraftSync('reload')
})

// A peer is about to destroy this window and wants what is in the editor first.
onPeerBroadcast<ComposerDraftFlushPayload>(DRAFT_FLUSH_EVENT, payload => {
  if (!addressesThisWindow(payload)) {
    return
  }

  // Synchronous by construction: the dispatch below reaches the mounted composer
  // inline, it stashes, and `persistDraftTexts` writes — all before the answer
  // goes out. So "acknowledged" means "the text is on disk", not "the message
  // arrived".
  requestComposerDraftSync('flush')
  broadcastToPeers<ComposerDraftFlushedPayload>(DRAFT_FLUSHED_EVENT, { nonce: payload.nonce })
})

// The WEB fallback, and only there. In a browser the app is one page per tab
// with no event bus to ride, and `storage` is exactly the right mechanism; under
// Tauri it is a bet on cross-process delivery that this module no longer makes.
// Registering both would also make the runtime check unfalsifiable — with two
// transports in play, a passing handoff says nothing about which one carried it.
if (!IS_TAURI) {
  try {
    window.addEventListener('storage', event => {
      if (event.key === SESSION_DRAFTS_STORAGE_KEY) {
        reloadPersistedDrafts()
        requestComposerDraftSync('reload')
      }
    })
  } catch {
    // No DOM — the module still imports cleanly under unit tests.
  }
}

// There is deliberately no `$composerDraft` atom or set/append/clear helpers
// over one. A composer's live text lives in its own contentEditable plus
// `draftRef`, stashed per session key via `stashSessionDraft` — see
// app/chat/composer/hooks/use-composer-draft.ts. The atom that used to sit here
// looked like the draft API and was read by nothing, so everything written to it
// (the `/undo` prefill, the degenerate-slash restore) was silently discarded
// (MJXHRM-419). To put text into a composer from outside, address one on the
// insert bus: `requestComposerInsert(text, { target })`.

// Main-scope conveniences — the names the app has always used.
export const addComposerAttachment = (attachment: ComposerAttachment) => mainComposerScope.add(attachment)
export const removeComposerAttachment = (id: string) => mainComposerScope.remove(id)

/** Replace an existing attachment in place by id. No-op (returns false) when the
 * id is gone — e.g. the user removed the chip while an eager upload was still in
 * flight, so a late success must NOT resurrect it. Use this instead of
 * addComposerAttachment for async results that may land after a removal. */
export const updateComposerAttachment = (attachment: ComposerAttachment) => mainComposerScope.update(attachment)

export const clearComposerAttachments = () => mainComposerScope.clear()

/** Update only the upload state of an existing attachment (no-op if it's gone,
 * e.g. the user removed it mid-upload). Pass `undefined` to clear it. */
export const setComposerAttachmentUploadState = (id: string, uploadState?: ComposerAttachment['uploadState']) =>
  mainComposerScope.setUploadState(id, uploadState)

const TERMINAL_REF_RE = /@terminal:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g

function unquoteRefValue(raw: string) {
  const head = raw[0]
  const tail = raw[raw.length - 1]
  const quoted = (head === '`' && tail === '`') || (head === '"' && tail === '"') || (head === "'" && tail === "'")

  return (quoted ? raw.slice(1, -1) : raw).replace(/[,.;!?]+$/, '').trim()
}

function terminalLabelsFromDraft(draft: string) {
  const labels: string[] = []
  const seen = new Set<string>()

  for (const match of draft.matchAll(TERMINAL_REF_RE)) {
    const label = unquoteRefValue(match[1] || '')

    if (!label || seen.has(label)) {
      continue
    }

    seen.add(label)
    labels.push(label)
  }

  return labels
}

export function setComposerTerminalSelection(label: string, text: string) {
  const nextLabel = label.trim()
  const nextText = text.trim()

  if (!nextLabel || !nextText) {
    return
  }

  const current = $composerTerminalSelections.get()

  if (current[nextLabel] === nextText) {
    return
  }

  $composerTerminalSelections.set({
    ...current,
    [nextLabel]: nextText
  })
}

export function reconcileComposerTerminalSelections(draft: string) {
  const current = $composerTerminalSelections.get()
  const labels = new Set(terminalLabelsFromDraft(draft))
  let changed = false
  const next: Record<string, string> = {}

  for (const [label, text] of Object.entries(current)) {
    if (!labels.has(label)) {
      changed = true

      continue
    }

    next[label] = text
  }

  if (changed) {
    $composerTerminalSelections.set(next)
  }
}

export function terminalContextBlocksFromDraft(draft: string) {
  const labels = terminalLabelsFromDraft(draft)

  if (labels.length === 0) {
    return []
  }

  const selections = $composerTerminalSelections.get()

  return labels.flatMap(label => {
    const text = selections[label]?.trim()

    if (!text) {
      return []
    }

    return `\`\`\`terminal\n${text}\n\`\`\``
  })
}

export function clearComposerTerminalSelections() {
  if (Object.keys($composerTerminalSelections.get()).length === 0) {
    return
  }

  $composerTerminalSelections.set({})
}

function upsertAttachment(attachments: ComposerAttachment[], attachment: ComposerAttachment) {
  const index = attachments.findIndex(item => item.id === attachment.id)

  if (index < 0) {
    return [...attachments, attachment]
  }

  const next = [...attachments]
  next[index] = attachment

  return next
}
