/**
 * The NATIVE download branch of `downloadGatewayMediaFile`.
 *
 * `media.test.ts` covers the browser fallback, because jsdom is not Tauri and
 * `IS_TAURI` is a load-time const there. This file stubs the platform module so
 * the other branch — save dialog + the `download_file` Rust command — is
 * reachable at all, and it is the branch that actually ships: the fallback it
 * replaced was broken three ways over (CSP blocks `fetch` on a `data:` URL, the
 * data-URL route caps at 16 MB, and the mobile webview ignores `<a download>`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const save = vi.fn(async (_options: unknown): Promise<null | string> => '/Users/me/Downloads/report.pdf')
const invoke = vi.fn(async (_cmd: string, _args: unknown) => undefined as unknown)

vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_TAURI: true
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (options: unknown) => save(options) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }))

const { downloadGatewayMediaFile } = await import('@/lib/media')

beforeEach(() => {
  save.mockClear()
  save.mockResolvedValue('/Users/me/Downloads/report.pdf')
  invoke.mockClear()
  invoke.mockResolvedValue(undefined)
})

describe('downloadGatewayMediaFile on Tauri', () => {
  it('asks Rust to write the gateway file to the path the dialog returned', async () => {
    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).resolves.toBe(true)

    // The filename seeds the dialog — otherwise the user is offered "Untitled".
    expect(save).toHaveBeenCalledWith({ defaultPath: 'report.pdf' })
    expect(invoke).toHaveBeenCalledWith('download_file', {
      dest: '/Users/me/Downloads/report.pdf',
      path: '/work/out/report.pdf'
    })
  })

  /** The bytes must never reach the webview — that is the whole point. */
  it('never fetches, so no CSP directive is in play', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await downloadGatewayMediaFile('/work/out/report.pdf')

    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('unwraps a file: URL before handing the path to the gateway', async () => {
    await downloadGatewayMediaFile('file:///work/out/q3%20report.pdf')

    expect(invoke).toHaveBeenCalledWith(
      'download_file',
      expect.objectContaining({ path: '/work/out/q3 report.pdf' })
    )
  })

  it('reports a dismissed dialog as "not downloaded" rather than an error', async () => {
    save.mockResolvedValue(null)

    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  /**
   * Rust answers with a short code, not prose, so the only English in a
   * translated UI does not come from the native layer. Anything unrecognised
   * still has to land on a real sentence.
   */
  it.each([
    ['file_too_large', 'That file is too large to download.'],
    ['file_not_found', 'That file is no longer on the gateway.'],
    ['unauthorized', 'Your session expired. Reconnect and try again.'],
    ['no_gateway', 'Not connected to a gateway.'],
    ['something_new', 'Download failed']
  ])('translates the %s code from Rust', async (code, message) => {
    invoke.mockRejectedValue(code)

    await expect(downloadGatewayMediaFile('/work/out/report.pdf')).rejects.toThrow(message)
  })
})
