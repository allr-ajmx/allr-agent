import { translateNow } from '@/i18n'
import { filePathFromMediaPath, mediaName } from '@/lib/media-format'
import { persistentAtom } from '@/lib/persisted'
import { IS_TAURI } from '@/lib/platform'
import { broadcastToPeers, onPeerBroadcast, type PeerBroadcast } from '@/lib/webview-broadcast'
import { WEBVIEW_ID } from '@/lib/webview-id'
import { atom, computed } from '@/store/atom'
import {
  applyDownloadEvent,
  type DownloadEvent,
  type DownloadItem,
  type DownloadKind,
  type DownloadRecord,
  isActive
} from '@/store/downloads-reducer'

// The downloads spine: every gateway file or folder that is being written to
// this device, wherever in the app it was asked for.
//
// Four things shape it.
//
//  * **Rule 2.** The workspace lives on the GATEWAY, and the webview cannot
//    reach the network (`connect-src 'self' ipc:`). Every byte moves in Rust;
//    this module only ever asks and listens.
//  * **Rule 23.** Progress arrives on a per-instance topic,
//    `hermes-download://{id}/progress`, and the listener is registered BEFORE
//    the command is invoked — a download of a small file can finish inside the
//    round trip that registers the listener, and a bar that never moved is
//    indistinguishable from one that never started.
//  * **Rule 21.** Every window is its own WebView with its own copy of this
//    module. A download started from the HUD or a detached tile has to appear
//    in the main window's tray, so the owner rebroadcasts its rows over
//    `lib/webview-broadcast.ts` and peers fold them through the SAME reducer.
//  * **The queue.** Downloads run at most `MAX_CONCURRENT` at a time, so a
//    directory dragged in wholesale cannot open a dozen simultaneous transfers
//    and starve the one the user is actually watching.
//
// Ownership is deliberately narrow. The window that calls `startDownload` runs
// the transfer, subscribes to its topic and is the only one that will ever
// invoke a start command for that id — a peer's tray can watch and cancel, and
// nothing else. Cancel is the one action that works from anywhere without a
// hand-off, because `DownloadState` is Rust MANAGED state and therefore lives
// once per PROCESS, not once per window: `cancel_download(id)` finds the flag
// whichever window asks.

export type { DownloadItem, DownloadKind, DownloadRecord, DownloadStatus } from '@/store/downloads-reducer'
export { downloadFraction, isActive } from '@/store/downloads-reducer'

/** Every download this window knows about, its own and its peers'. */
export const $downloads = atom<DownloadRecord>({})

/** The ones still moving — what decides whether the tray shows a spinner. */
export const $activeDownloads = computed($downloads, record => Object.values(record).filter(isActive))

/**
 * The rows the tray should show, newest first: everything active, plus anything
 * that finished recently enough to still be worth reporting.
 */
export const $recentDownloads = computed($downloads, record =>
  Object.values(record).sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
)

/**
 * False once a gateway has answered 404 for `/api/files/download-archive`;
 * `null` until something has asked. Copies `$projectsRpcAvailable`
 * (`store/projects.ts`) because MJXHRM-511 freezes the gateway backend so
 * `hermes-agent` and `allr-agent` stay interchangeable — the archive route is
 * additive, so a client that hard-depends on it breaks against the other one.
 * `route_missing` from Rust is the only thing that clears this: a missing
 * FOLDER answers `file_not_found` and leaves the capability alone.
 */
export const $folderDownloadAvailable = atom<boolean | null>(null)

// -------------------------------------------------------------------------
// Where downloads land (§6.3)
// -------------------------------------------------------------------------

/**
 * The directory queued and folder downloads are written to.
 *
 * A persisted CLIENT preference, not gateway config. The root `AGENTS.md` sends
 * behavioural settings to `config.yaml`, but that governs what the gateway and
 * the agent do; where a file lands on *this* device is per-device client state
 * — the same category as the terminal font or the skin — and one `config.yaml`
 * can be shared by a phone and a laptop whose download directories have nothing
 * to do with each other.
 *
 * Empty string means "ask the platform", which is the default and what almost
 * everyone will run: `downloadDir()` from `@tauri-apps/api/path`. Storing the
 * empty string rather than the resolved path is what lets the answer follow the
 * user's OS setting instead of freezing whatever it was the first time the app
 * ran.
 *
 * Rust does NOT need this value and no `set_` command pushes it down: the
 * frontend hands Rust a complete `dest` path on every call, so a second copy of
 * the preference over there would be a copy nothing reads (§6.3 step 3 applies
 * only when Rust needs the value, and speculative infrastructure is exactly
 * what the root `AGENTS.md` rejects).
 */
export const $downloadsDir = persistentAtom<string>('hermes.downloadsDir', '', {
  decode: raw => sanitizeDownloadsDir(raw),
  encode: value => (value ? value : null)
})

/**
 * Keep only something that could plausibly be a directory to write into.
 *
 * Read back from localStorage, which anything on the device can write, and
 * handed to a native file write — so a relative path (which would resolve
 * against the process's working directory, wherever that happens to be) and a
 * `..` traversal both fall back to the platform default rather than being
 * honoured.
 */
export function sanitizeDownloadsDir(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }

  const trimmed = raw.trim()

  if (!trimmed || trimmed.includes('\0') || trimmed.split(/[\\/]/).includes('..')) {
    return ''
  }

  // Absolute POSIX (`/x`), Windows (`C:\x`), or a UNC share.
  return /^([/\\]|[A-Za-z]:[\\/])/.test(trimmed) ? trimmed : ''
}

/** The configured directory, or whatever the OS calls "Downloads". */
async function resolveDownloadsDir(): Promise<string> {
  const configured = $downloadsDir.get()

  if (configured) {
    return configured
  }

  const { downloadDir } = await import('@tauri-apps/api/path')

  return downloadDir()
}

/**
 * Join a directory and a filename with the separator the directory already uses.
 *
 * `@tauri-apps/api/path`'s `join` is a round trip through Rust for something
 * decidable from the string, and this runs once per queued download.
 */
export function joinDownloadPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'

  return `${dir.replace(/[\\/]+$/, '')}${separator}${name}`
}

// -------------------------------------------------------------------------
// Cross-WebView broadcast (rule 21)
// -------------------------------------------------------------------------

const DOWNLOADS_EVENT = 'downloads://changed'

interface DownloadChangedPayload extends PeerBroadcast {
  item: DownloadItem
}

function publish(event: DownloadEvent, broadcast = true): void {
  const before = $downloads.get()
  const after = applyDownloadEvent(before, event)

  if (after === before) {
    return
  }

  $downloads.set(after)

  // Only the owner broadcasts, and only rows it owns. A peer echoing a row back
  // would double the traffic and, worse, could re-assert a snapshot older than
  // the owner's next one.
  const id = event.type === 'queued' || event.type === 'merged' ? event.item.id : event.id
  const item = after[id]

  if (broadcast && item && item.owner === WEBVIEW_ID) {
    broadcastToPeers<DownloadChangedPayload>(DOWNLOADS_EVENT, { item })
  }
}

let stopPeerSync: (() => void) | undefined

/**
 * Start hearing other WebViews' downloads. Idempotent.
 *
 * Called once from `main.tsx`, which is where every other cross-WebView sync in
 * this app is armed (`themes/appearance-sync`, `store/gateway-switch-sync`,
 * `store/agent-read-requests`). It is deliberately NOT a module-scope
 * registration: `downloads-tray.tsx` imports this module, the tray is in the
 * titlebar, and the titlebar is reachable from a large part of the app — so a
 * subscription at module scope would be established by any file that merely
 * touches that graph, including every test file that renders a shell. A store
 * that is imported should hold state, not start listening.
 *
 * Not gated by `ownsPersistedAppState()`, unlike the tray/background wiring
 * beside it: a satellite or activity window is exactly the kind of surface a
 * download gets started from, and every window needs a complete tray.
 */
export function initDownloadSync(): void {
  if (stopPeerSync) {
    return
  }

  // A peer's row folds through the same reducer as an owned one — see the note
  // at the top of `downloads-reducer.ts`. `onPeerBroadcast` has already dropped
  // this window's own echo (`emit` is global).
  stopPeerSync = onPeerBroadcast<DownloadChangedPayload>(DOWNLOADS_EVENT, payload => {
    if (payload.item?.id) {
      publish({ item: payload.item, type: 'merged' }, false)
    }
  })
}

/** Stop hearing peers. Exported for the teardown half of `__resetDownloads`. */
export function stopDownloadSync(): void {
  stopPeerSync?.()
  stopPeerSync = undefined
}

/** Is the peer subscription live? Test seam. */
export function __downloadSyncActive(): boolean {
  return stopPeerSync !== undefined
}

// -------------------------------------------------------------------------
// The queue
// -------------------------------------------------------------------------

/**
 * How many transfers run at once IN THIS WINDOW.
 *
 * Two rather than one so a large download does not block a small one behind it
 * for minutes, and not more than two because every extra one is another
 * concurrent read on the same gateway process that is also serving the chat
 * socket.
 */
const MAX_CONCURRENT = 2

/** Ids this window has started and not yet seen end. */
const running = new Set<string>()

/** Ids this window has queued, in the order they were asked for. */
const pending: string[] = []

function nextId(): string {
  try {
    return `dl-${crypto.randomUUID()}`
  } catch {
    return `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/**
 * Start whatever the concurrency budget allows.
 *
 * Only ever walks THIS window's `pending`, so two windows downloading at once
 * each run their own budget — which is the honest shape: a window cannot start
 * a transfer on another window's behalf without inventing a hand-off protocol
 * nobody needs.
 */
function pump(): void {
  while (running.size < MAX_CONCURRENT && pending.length > 0) {
    const id = pending.shift()

    if (!id) {
      return
    }

    const item = $downloads.get()[id]

    // Cancelled while queued: it never became a transfer, so there is nothing
    // in Rust to stop and nothing to start.
    if (!item || item.status !== 'queued') {
      continue
    }

    running.add(id)
    void run(item).finally(() => {
      running.delete(id)
      pump()
    })
  }
}

/** Subscribe to the topic, invoke the command, fold the answer. */
async function run(item: DownloadItem): Promise<void> {
  let unlisten: (() => void) | undefined

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    // BEFORE the invoke (rule 23). `listen` is a round trip through Rust, and a
    // small file can be written before it returns.
    unlisten = await listen<{ received: number; total: null | number }>(
      `hermes-download://${item.id}/progress`,
      event => {
        publish({
          id: item.id,
          received: event.payload.received,
          total: event.payload.total ?? null,
          type: 'progress'
        })
      }
    )

    publish({ id: item.id, type: 'started' })

    const received = await invoke<number>(item.kind === 'folder' ? 'download_folder' : 'download_file', {
      dest: item.dest,
      id: item.id,
      path: item.srcPath
    })

    if (item.kind === 'folder') {
      $folderDownloadAvailable.set(true)
    }

    publish({ id: item.id, received, type: 'finished' })
  } catch (err) {
    // Rule 9 from the caller's side: a row must never be left mid-transfer
    // because something OTHER than the command failed. The `try` covers the
    // dynamic imports and the `listen` too, so a native side that is not there
    // ends the row rather than leaving a bar that will never move again.
    const code = errorCode(err)

    // Not an error the user did not ask for — they asked for exactly this.
    if (code === 'download_cancelled') {
      publish({ id: item.id, type: 'cancelled' })
    } else if (code === 'route_missing') {
      // The gateway predates the archive route (MJXHRM-511). Hide the
      // affordance for the rest of the session rather than leaving a failed row
      // the user cannot do anything about.
      $folderDownloadAvailable.set(false)
      publish({ id: item.id, type: 'dismissed' })
    } else {
      publish({ error: code, id: item.id, type: 'failed' })
    }
  } finally {
    unlisten?.()
  }
}

function errorCode(err: unknown): string {
  const code = typeof err === 'string' ? err : (err as Error)?.message

  return code ?? 'download_failed'
}

// -------------------------------------------------------------------------
// Destination policy
// -------------------------------------------------------------------------

export interface DownloadOptions {
  /** Override the destination entirely; skips the dialog and the directory. */
  dest?: string
  /** Open the native save dialog — what "Save as…" is. Off by default. */
  prompt?: boolean
}

/**
 * Where the bytes go.
 *
 * A plain download NEVER opens a dialog, for the same reason a browser's does
 * not: the answer is almost always "the downloads folder", and a modal in front
 * of it turns a one-click action into a two-step one — and a queue of five
 * files into five stacked modals. The dialog is an explicit action instead
 * (`{ prompt: true }`, the "Save as…" row in the file menu), which is also why
 * there is no session latch here any more: nothing opens a dialog the user did
 * not ask for by name.
 */
async function chooseDest(name: string, opts: DownloadOptions): Promise<null | string> {
  if (opts.dest) {
    return opts.dest
  }

  if (opts.prompt ?? false) {
    const { save } = await import('@tauri-apps/plugin-dialog')

    // `null` — the user dismissed the dialog. Not an error; not a download.
    return await save({ defaultPath: name })
  }

  return joinDownloadPath(await resolveDownloadsDir(), name)
}

// -------------------------------------------------------------------------
// The public contract (consumed by the artifacts page and the files pane)
// -------------------------------------------------------------------------

/**
 * Queue one gateway FILE for download.
 *
 * Resolves to the download's id once it is queued — NOT when the bytes have
 * landed. That is the whole point of the spine: a 4 GB file must not hold a
 * click handler open for twenty minutes. Watch `$downloads[id]` for the outcome.
 *
 * Resolves to `null` when there is nothing to watch: the user dismissed the save
 * dialog, or this is not a Tauri build.
 */
export async function downloadPath(path: string, opts: DownloadOptions = {}): Promise<null | string> {
  return enqueue(path, 'file', opts)
}

/**
 * Queue one gateway FOLDER for download, as a zip the gateway builds as it
 * sends it.
 *
 * Lands in the downloads directory unless the caller asks for a dialog with
 * `{ prompt: true }` — the zip is an ordinary destination like any other.
 * Callers must gate the affordance on `$folderDownloadAvailable !== false`, because
 * MJXHRM-511 freezes the gateway backend and an older one has no archive route;
 * calling anyway is safe (it flips the atom and drops the row) but shows the
 * user an affordance that does nothing.
 */
export async function downloadFolder(path: string, opts: DownloadOptions = {}): Promise<null | string> {
  return enqueue(path, 'folder', opts)
}

async function enqueue(path: string, kind: DownloadKind, opts: DownloadOptions): Promise<null | string> {
  if (!IS_TAURI) {
    return null
  }

  // Callers hand us whatever they hold — a bare gateway path from the file
  // tree, or a `file://` URL from a transcript attachment. The gateway's
  // `?path=` wants the former.
  const srcPath = filePathFromMediaPath(path)
  const base = mediaName(srcPath) || 'download'
  const name = kind === 'folder' ? `${base}.zip` : base
  const dest = await chooseDest(name, opts)

  if (!dest) {
    return null
  }

  const id = nextId()

  publish({
    item: {
      dest,
      id,
      kind,
      name,
      owner: WEBVIEW_ID,
      received: 0,
      srcPath,
      startedAt: Date.now(),
      status: 'queued',
      total: null
    },
    type: 'queued'
  })

  pending.push(id)
  pump()

  return id
}

/**
 * Stop a download, from any window.
 *
 * Works cross-window without a hand-off because the cancel registry is Rust
 * MANAGED state, which is per process rather than per WebView — see the note at
 * the top of this file. A queued download that has not reached Rust yet is
 * cancelled here instead, and `pump` skips it when its turn comes.
 */
export async function cancelDownload(id: string): Promise<void> {
  const item = $downloads.get()[id]

  if (!item || !isActive(item)) {
    return
  }

  if (item.status === 'queued') {
    publish({ id, type: 'cancelled' })

    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    await invoke<boolean>('cancel_download', { id })
  } catch {
    // A cancel that could not be delivered is not worth a toast: the transfer
    // either already ended (in which case its own terminal event is on the way)
    // or the native side is gone, which the user has bigger signals for.
  }
}

/**
 * Take a finished row out of THIS window's tray.
 *
 * Deliberately not broadcast: tidying a list is a view action, and a peer
 * window's tray is a different view of the same transfers. The transfer itself
 * is already over — there is no state left to diverge on.
 */
export function dismissDownload(id: string): void {
  publish({ id, type: 'dismissed' })
}

/** Every finished row, gone. Leaves anything still transferring alone. */
export function clearFinishedDownloads(): void {
  for (const item of Object.values($downloads.get())) {
    if (!isActive(item)) {
      publish({ id: item.id, type: 'dismissed' })
    }
  }
}

/**
 * Show a finished download in the OS file manager.
 *
 * Desktop-only in effect — `reveal_in_file_manager` has no mobile counterpart —
 * and deliberately silent when it cannot: a file manager that did not open is a
 * cosmetic native failure (§6.2), not something to interrupt the user over.
 */
export async function revealDownload(id: string): Promise<void> {
  const item = $downloads.get()[id]

  if (!item || item.status !== 'done') {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    await invoke('reveal_in_file_manager', { path: item.dest })
  } catch {
    // See above.
  }
}

/** Open a finished download in whatever the OS uses for its type. */
export async function openDownload(id: string): Promise<void> {
  const item = $downloads.get()[id]

  if (!item || item.status !== 'done') {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    await invoke('open_external', { url: `file://${item.dest}` })
  } catch {
    // See above.
  }
}

// Codes Rust returns, mapped to the localized strings the tray shows. Rust
// answers in codes rather than prose so the only English in a translated UI is
// not coming from the native layer.
const DOWNLOAD_ERROR_KEYS: Record<string, string> = {
  download_failed: 'failed',
  file_forbidden: 'forbidden',
  file_not_found: 'notFound',
  file_too_large: 'tooLarge',
  gateway_unreachable: 'unreachable',
  no_gateway: 'noGateway',
  route_missing: 'failed',
  unauthorized: 'unauthorized',
  write_failed: 'writeFailed'
}

/** The sentence to show for a failed download. */
export function downloadErrorMessage(code: string | undefined): string {
  return translateNow(`common.fileDownload.${DOWNLOAD_ERROR_KEYS[code ?? ''] ?? 'failed'}`)
}

/**
 * Test seam: drop every row, forget the queue, and tear down the peer
 * subscription so a test leaves no module-scope residue behind it.
 */
export function __resetDownloads(): void {
  $downloads.set({})
  $folderDownloadAvailable.set(null)
  running.clear()
  pending.length = 0
  stopDownloadSync()
}
