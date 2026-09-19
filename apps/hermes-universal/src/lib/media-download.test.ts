/**
 * The NATIVE download branch of `downloadGatewayMediaFile`.
 *
 * `media.test.ts` covers the browser fallback, because jsdom is not Tauri and
 * `IS_TAURI` is a load-time const there. This file stubs the platform module so
 * the other branch is reachable at all, and it is the branch that actually
 * ships: the fallback it replaced was broken three ways over (CSP blocks `fetch`
 * on a `data:` URL, the data-URL route caps at 16 MB, and the mobile webview
 * ignores `<a download>`).
 *
 * What CHANGED with the downloads spine: this function is now a thin wrapper
 * over `downloadPath` in `store/downloads.ts`. Resolving no longer means "the
 * file is on disk" — it means "queued, and the titlebar tray owns it from
 * here", so a gateway failure surfaces there rather than as a rejection. The
 * code→sentence mapping those tests used to pin now lives on
 * `downloadErrorMessage`, and is pinned in `store/downloads.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const save = vi.fn(async (_options: unknown): Promise<null | string> => '/Users/me/Downloads/report.pdf')
const invoke = vi.fn(async (_cmd: string, _args: unknown) => 1024 as unknown)
const listen = vi.fn(async (_name: string, _handler: unknown) => () => undefined)

vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_TAURI: true
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (options: unknown) => save(options) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: async () => undefined,
  listen: (name: string, handler: unknown) => listen(name, handler)
}))
vi.mock('@tauri-apps/api/path', () => ({ downloadDir: async () => '/Users/me/Downloads' }))

const { downloadGatewayMediaFile } = await import('@/lib/media')
const { __resetDownloads } = await import('@/store/downloads')

/** The store reaches Tauri through dynamic `import()`, which is a macrotask. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  __resetDownloads()
  save.mockClear()
  save.mockResolvedValue('/Users/me/Downloads/report.pdf')
  invoke.mockClear()
  invoke.mockResolvedValue(1024)
  listen.mockClear()
})

describe('downloadGatewayMediaFile on Tauri', () => {
  it('asks Rust to write the gateway file straight into the downloads folder', async () => {
    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).resolves.toBe(true)
    await settle()

    // No dialog: a browser does not ask, and neither does this. Choosing a
    // destination is the file menu's separate "Save as…" row.
    expect(save).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('download_file', {
      dest: '/Users/me/Downloads/report.pdf',
      // New: the transfer's own id, which is what the progress topic and
      // `cancel_download` are keyed on.
      id: expect.any(String),
      path: '/work/out/report.pdf'
    })
  })

  /** The bytes must never reach the webview — that is the whole point. */
  it('never fetches, so no CSP directive is in play', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await downloadGatewayMediaFile('/work/out/report.pdf')
    await settle()

    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('unwraps a file: URL before handing the path to the gateway', async () => {
    await downloadGatewayMediaFile('file:///work/out/q3%20report.pdf')
    await settle()

    expect(invoke).toHaveBeenCalledWith('download_file', expect.objectContaining({ path: '/work/out/q3 report.pdf' }))
  })

  /**
   * The regression guard for the no-dialog rule: if a default prompt ever comes
   * back, a dialog the user dismissed would turn this click into a silent
   * no-op — which is exactly what it used to do.
   */
  it('never consults the save dialog, even one that would answer null', async () => {
    save.mockResolvedValue(null)

    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).resolves.toBe(true)
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(
      'download_file',
      expect.objectContaining({ dest: '/Users/me/Downloads/report.pdf' })
    )
  })

  /**
   * The handoff this whole change is for: a click must not hold open until a
   * 4 GB file has landed. The wrapper resolves once the transfer is queued, and
   * the tray reports the rest.
   */
  it('resolves as soon as the download is queued, not when the bytes land', async () => {
    let landed = false

    invoke.mockImplementation(
      async () =>
        await new Promise(resolve => {
          setTimeout(() => {
            landed = true
            resolve(4096)
          }, 50)
        })
    )

    await expect(downloadGatewayMediaFile('/work/out/huge.bin')).resolves.toBe(true)

    expect(landed).toBe(false)
  })
})
