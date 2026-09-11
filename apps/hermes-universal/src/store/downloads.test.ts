import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The impure half: the queue, the destination policy, the Tauri plumbing and the
 * cross-WebView broadcast. Everything about WHAT a row should say lives in
 * `downloads-reducer.test.ts`; this file is about ORDER — what is invoked, when,
 * and what is not invoked at all.
 */

const invoke = vi.fn()
const listen = vi.fn()
const emit = vi.fn(async (_name: string, _payload: unknown) => undefined)
const save = vi.fn(async (_options: unknown): Promise<null | string> => '/picked/report.pdf')
const downloadDir = vi.fn(async () => '/home/me/Downloads')

/** Everything the module does is gated on being a Tauri build. */
vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_TAURI: true
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: (name: string, payload: unknown) => emit(name, payload),
  listen: (name: string, handler: unknown) => listen(name, handler)
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (options: unknown) => save(options) }))
vi.mock('@tauri-apps/api/path', () => ({ downloadDir: () => downloadDir() }))

const {
  $downloads,
  $folderDownloadAvailable,
  __resetDownloads,
  __downloadSyncActive,
  cancelDownload,
  downloadErrorMessage,
  downloadFolder,
  downloadPath,
  joinDownloadPath,
  sanitizeDownloadsDir
} = await import('./downloads')

/** A promise a test resolves by hand, so a transfer can be held mid-flight. */
function deferred<T>() {
  let settle!: (value: T) => void
  let fail!: (reason: unknown) => void

  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  return { fail, promise, settle }
}

/**
 * Let the module's own awaits drain — macrotasks included, because the store
 * reaches Tauri through dynamic `import()` and a microtask flush does not
 * resolve one.
 */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

beforeEach(async () => {
  const { $downloadsDir } = await import('./downloads')

  $downloadsDir.set('')
  __resetDownloads()
  invoke.mockReset()
  invoke.mockResolvedValue(1024)
  listen.mockReset()
  listen.mockResolvedValue(() => undefined)
  emit.mockClear()
  save.mockReset()
  save.mockResolvedValue('/picked/report.pdf')
  downloadDir.mockReset()
  downloadDir.mockResolvedValue('/home/me/Downloads')
  window.localStorage.clear()
})

describe('the progress subscription', () => {
  /**
   * Rule 23, and the reason it is a rule: `listen` is a round trip through Rust,
   * and a small file can be written and the command resolved before it returns.
   * Registering after the invoke means the bar never moves — which is
   * indistinguishable from a download that never started.
   */
  it('subscribes to the download topic BEFORE the start command is invoked', async () => {
    const order: string[] = []

    listen.mockImplementation(async (name: string) => {
      order.push(`listen:${name}`)

      return () => undefined
    })
    invoke.mockImplementation(async (cmd: string) => {
      order.push(`invoke:${cmd}`)

      return 1024
    })

    const id = await downloadPath('/work/out/report.pdf')

    await settle()

    expect(order).toEqual([`listen:hermes-download://${id}/progress`, 'invoke:download_file'])
  })

  it('carries the id Rust emits on, so the two halves of the topic agree', async () => {
    const id = await downloadPath('/work/out/report.pdf')

    await settle()

    expect(listen).toHaveBeenCalledWith(`hermes-download://${id}/progress`, expect.any(Function))
    // §6.2: the COMMAND name stays snake_case; the ARGUMENTS are what Tauri
    // camelCases, and these three are single words either way.
    expect(invoke).toHaveBeenCalledWith('download_file', {
      dest: '/home/me/Downloads/report.pdf',
      id,
      path: '/work/out/report.pdf'
    })
  })

  it('folds progress events into the row', async () => {
    let push: ((event: { payload: { received: number; total: null | number } }) => void) | undefined
    const held = deferred<number>()

    listen.mockImplementation(async (_name: string, handler: (event: unknown) => void) => {
      push = handler as typeof push

      return () => undefined
    })
    invoke.mockReturnValue(held.promise)

    const id = await downloadPath('/work/out/report.pdf')

    await settle()
    push?.({ payload: { received: 4096, total: 8192 } })

    expect($downloads.get()[id!]).toMatchObject({ received: 4096, status: 'running', total: 8192 })

    held.settle(8192)
    await settle()

    expect($downloads.get()[id!]?.status).toBe('done')
  })
})

describe('the destination policy', () => {
  /**
   * A browser does not ask where a download goes, and neither does this. The
   * answer is almost always the downloads directory; a modal in front of it
   * turns one click into two, and a queue of five files into five stacked
   * modals. Choosing a destination is a separate, named action — see below.
   */
  it('never opens a dialog for a plain download', async () => {
    await downloadPath('/work/out/report.pdf')
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith(
      'download_file',
      expect.objectContaining({ dest: '/home/me/Downloads/report.pdf' })
    )
  })

  /**
   * There used to be a synchronous latch here, because the FIRST download of a
   * session opened a dialog and five queued in a loop would all read an empty
   * table and open five. With no default dialog there is nothing to latch — but
   * the property it protected still has to hold.
   */
  it('opens no dialog for a batch queued in a loop', async () => {
    const { $downloadsDir } = await import('./downloads')

    // Pinned rather than left to `downloadDir()`, so what this test measures is
    // the number of dialogs and nothing else.
    $downloadsDir.set('/home/me/Downloads')

    await Promise.all([downloadPath('/work/a.pdf'), downloadPath('/work/b.pdf'), downloadPath('/work/c.pdf')])
    await settle()

    expect(save).not.toHaveBeenCalled()
    // Every one of them got the directory, including the one still queued
    // behind MAX_CONCURRENT — the destination is decided at enqueue time.
    expect(
      Object.values($downloads.get())
        .map(row => row.dest)
        .sort()
    ).toEqual(['/home/me/Downloads/a.pdf', '/home/me/Downloads/b.pdf', '/home/me/Downloads/c.pdf'])
  })

  it('names a folder download after the folder', async () => {
    await downloadFolder('/work/project')
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('download_folder', {
      dest: '/home/me/Downloads/project.zip',
      id: expect.any(String),
      path: '/work/project'
    })
  })

  /** "Save as…": the dialog is now something the user asks for by name. */
  it('opens the dialog when the caller asks for one', async () => {
    await downloadPath('/work/out/report.pdf', { prompt: true })
    await settle()

    expect(save).toHaveBeenCalledWith({ defaultPath: 'report.pdf' })
    expect(invoke).toHaveBeenCalledWith('download_file', expect.objectContaining({ dest: '/picked/report.pdf' }))
  })

  /**
   * A folder zip used to be documented as never reaching a dialog. Nothing but
   * the doc comment enforced that, and Save as… on a directory has to work —
   * so this pins that `prompt` is honoured for a folder exactly as for a file.
   */
  it('opens the dialog for a FOLDER that asks for one', async () => {
    save.mockResolvedValue('/picked/project.zip')

    await downloadFolder('/work/project', { prompt: true })
    await settle()

    expect(save).toHaveBeenCalledWith({ defaultPath: 'project.zip' })
    expect(invoke).toHaveBeenCalledWith('download_folder', expect.objectContaining({ dest: '/picked/project.zip' }))
  })

  it('reports a dismissed dialog as "not downloaded" rather than an error', async () => {
    save.mockResolvedValue(null)

    await expect(downloadPath('/work/out/report.pdf', { prompt: true })).resolves.toBeNull()
    await settle()

    expect(invoke).not.toHaveBeenCalled()
    expect(Object.keys($downloads.get())).toHaveLength(0)
  })

  /** An explicit destination beats both the dialog and the directory. */
  it('honours an explicit dest and asks nothing', async () => {
    await downloadPath('/work/out/report.pdf', { dest: '/elsewhere/renamed.pdf', prompt: true })
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('download_file', expect.objectContaining({ dest: '/elsewhere/renamed.pdf' }))
  })
})

describe('the downloads directory preference (§6.3)', () => {
  /**
   * The default is "ask the platform", NOT a resolved path: storing the resolved
   * one would freeze whatever it happened to be the first time the app ran, and
   * stop following the user's OS setting.
   */
  it('defaults to the empty string, which means downloadDir()', async () => {
    const { $downloadsDir } = await import('./downloads')

    expect($downloadsDir.get()).toBe('')

    await downloadFolder('/work/project')
    await settle()

    expect(downloadDir).toHaveBeenCalled()
  })

  /**
   * Read back from localStorage, which anything on the device can write, and
   * handed straight to a native file write.
   */
  it('refuses anything that is not an absolute directory', () => {
    expect(sanitizeDownloadsDir('/home/me/Downloads')).toBe('/home/me/Downloads')
    expect(sanitizeDownloadsDir('C:\\Users\\me\\Downloads')).toBe('C:\\Users\\me\\Downloads')
    expect(sanitizeDownloadsDir('  /home/me/Downloads  ')).toBe('/home/me/Downloads')

    expect(sanitizeDownloadsDir('relative/path')).toBe('')
    expect(sanitizeDownloadsDir('/home/me/../../etc')).toBe('')
    expect(sanitizeDownloadsDir('/home/me/\0evil')).toBe('')
    expect(sanitizeDownloadsDir('')).toBe('')
    expect(sanitizeDownloadsDir(42)).toBe('')
    expect(sanitizeDownloadsDir(null)).toBe('')
  })

  it('joins with the separator the directory already uses', () => {
    expect(joinDownloadPath('/home/me/Downloads', 'a.pdf')).toBe('/home/me/Downloads/a.pdf')
    expect(joinDownloadPath('/home/me/Downloads/', 'a.pdf')).toBe('/home/me/Downloads/a.pdf')
    expect(joinDownloadPath('C:\\Users\\me', 'a.pdf')).toBe('C:\\Users\\me\\a.pdf')
  })
})

// NOTE: not "cancelling" — `scripts/i18n-audit.mjs` harvests reachability from
// bare string literals, and that one word would make the orphaned key
// `install.cancelling` look live again and fail R1.
describe('stopping a download', () => {
  /** Rule 9's shape from the other side: cancelled is not failed. */
  it('records a user cancel as cancelled, not as an error', async () => {
    const held = deferred<number>()

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'download_file') {
        return held.promise
      }

      return true
    })

    const id = await downloadPath('/work/out/report.pdf')

    await settle()
    void cancelDownload(id!)
    await settle()

    expect(invoke).toHaveBeenCalledWith('cancel_download', { id })

    held.fail('download_cancelled')
    await settle()

    expect($downloads.get()[id!]).toMatchObject({ error: undefined, status: 'cancelled' })
  })

  /**
   * A queued download has not reached Rust, so there is no flag over there to
   * flip — asking anyway would make `cancel_download` answer `false` and leave
   * the row queued, and `pump` would then start a transfer the user cancelled.
   */
  it('cancels a queued download without going to Rust at all', async () => {
    const held = deferred<number>()

    invoke.mockReturnValue(held.promise)

    // MAX_CONCURRENT is 2, so the third is still queued.
    const first = await downloadPath('/work/a.bin')
    const second = await downloadPath('/work/b.bin')
    const third = await downloadPath('/work/c.bin')

    await settle()

    expect($downloads.get()[third!]?.status).toBe('queued')
    expect(invoke).toHaveBeenCalledTimes(2)

    await cancelDownload(third!)

    expect($downloads.get()[third!]?.status).toBe('cancelled')
    expect(invoke).not.toHaveBeenCalledWith('cancel_download', { id: third })

    held.settle(1)
    await settle()

    // And the cancelled row is never started when its turn comes.
    expect(invoke).not.toHaveBeenCalledWith('download_file', expect.objectContaining({ id: third }))
    expect($downloads.get()[first!]?.status).toBe('done')
    expect($downloads.get()[second!]?.status).toBe('done')
  })

  it('does nothing for an id that already finished', async () => {
    const id = await downloadPath('/work/out/report.pdf')

    await settle()
    invoke.mockClear()
    await cancelDownload(id!)

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('the backend freeze (MJXHRM-511)', () => {
  /**
   * The archive route is additive, so a gateway that predates it must make the
   * affordance DISAPPEAR rather than fail. `route_missing` is the only code that
   * clears the capability — a missing folder answers `file_not_found` and leaves
   * it alone, or one deleted directory would hide folder downloads for the rest
   * of the session.
   */
  it('hides folder downloads when the gateway has no archive route', async () => {
    invoke.mockRejectedValue('route_missing')

    const id = await downloadFolder('/work/project')

    await settle()

    expect($folderDownloadAvailable.get()).toBe(false)
    // No failed row left behind: there is nothing the user could do about it.
    expect($downloads.get()[id!]).toBeUndefined()
  })

  it('leaves the capability alone when it is the FOLDER that is missing', async () => {
    invoke.mockRejectedValue('file_not_found')

    const id = await downloadFolder('/work/gone')

    await settle()

    expect($folderDownloadAvailable.get()).toBeNull()
    expect($downloads.get()[id!]).toMatchObject({ error: 'file_not_found', status: 'failed' })
  })

  it('marks the route available once one archive download succeeds', async () => {
    await downloadFolder('/work/project')
    await settle()

    expect($folderDownloadAvailable.get()).toBe(true)
  })
})

describe('cross-WebView broadcast (rule 21)', () => {
  /**
   * Importing a store must not start anything. The tray lives in the titlebar,
   * so this module is reachable from a large part of the app — a module-scope
   * `onPeerBroadcast` would be established by every file that merely touches
   * that graph, including every test that renders a shell. The subscription is
   * armed once from `main.tsx`, next to the other cross-WebView syncs.
   */
  it('registers no listener merely by being imported', () => {
    expect(__downloadSyncActive()).toBe(false)
    expect(listen).not.toHaveBeenCalled()
  })

  it('arms once, is idempotent, and tears down on reset', async () => {
    const { initDownloadSync } = await import('./downloads')

    initDownloadSync()
    expect(__downloadSyncActive()).toBe(true)

    initDownloadSync()
    expect(__downloadSyncActive()).toBe(true)

    __resetDownloads()
    expect(__downloadSyncActive()).toBe(false)
  })

  /**
   * Every window is its own WebView with its own copy of this module, so a
   * download started in the HUD is invisible in the main window's tray unless it
   * is broadcast. Only the OWNER broadcasts — a peer echoing a row back would
   * double the traffic and could re-assert a snapshot older than the owner's.
   */
  it('broadcasts owned rows to peer WebViews', async () => {
    await downloadPath('/work/out/report.pdf')
    await settle()

    const broadcasts = emit.mock.calls.filter(([name]) => name === 'downloads://changed')

    expect(broadcasts.length).toBeGreaterThan(0)

    const payload = broadcasts.at(-1)?.[1] as undefined | { item: { name: string; status: string }; origin: string }

    expect(payload?.item).toMatchObject({ name: 'report.pdf', status: 'done' })
    // Stamped, so the receiver can drop its own echo — `emit` is global.
    expect(payload?.origin).toBeTypeOf('string')
  })
})

describe('the failure vocabulary', () => {
  /**
   * Rust answers in short stable CODES rather than prose, so the only English in
   * an otherwise translated UI does not come from the native layer. Moved here
   * from `lib/media-download.test.ts` when the tray took over reporting: the
   * mapping is the same, the surface that shows it is not.
   */
  it.each([
    ['file_too_large', 'That file is too large to download.'],
    ['file_not_found', 'That file is no longer on the gateway.'],
    ['file_forbidden', 'The gateway will not serve that file.'],
    ['unauthorized', 'Your session expired. Reconnect and try again.'],
    ['no_gateway', 'Not connected to a gateway.'],
    ['gateway_unreachable', 'Could not reach the gateway.'],
    ['write_failed', 'Could not write the file to disk.'],
    ['something_new', 'Download failed'],
    [undefined, 'Download failed']
  ])('translates the %s code from Rust', (code, message) => {
    expect(downloadErrorMessage(code)).toBe(message)
  })
})
