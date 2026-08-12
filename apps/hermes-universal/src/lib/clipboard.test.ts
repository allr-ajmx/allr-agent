import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pluginReadText, pluginWriteText } = vi.hoisted(() => ({
  pluginReadText: vi.fn(),
  pluginWriteText: vi.fn()
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: pluginReadText,
  writeText: pluginWriteText
}))

import { readClipboardText, writeClipboardText } from './clipboard'

// A stand-in for the webview's own async Clipboard API. jsdom does not ship one,
// so every case has to install exactly the shape it is testing — which is the
// point: "WebKitGTK has no usable `readText`" is a real target state, not a
// hypothetical, and the fallback has to be correct for it.
function installWebClipboard(api: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: api, writable: true })
}

beforeEach(() => {
  pluginReadText.mockReset()
  pluginWriteText.mockReset()
  installWebClipboard(undefined)
})

afterEach(() => vi.restoreAllMocks())

describe('writeClipboardText', () => {
  it('writes through the OS plugin and does NOT touch the web API', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)
    pluginWriteText.mockResolvedValue(undefined)

    await writeClipboardText('hello')

    expect(pluginWriteText).toHaveBeenCalledWith('hello')
    expect(webWrite).not.toHaveBeenCalled()
  })

  // The plugin call lives INSIDE the try for a reason: in a plain browser the
  // module imports fine and only `invoke` rejects, so guarding the import alone
  // would let the rejection escape instead of falling back.
  it('falls back to the web API when the plugin rejects', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)
    pluginWriteText.mockRejectedValue(new Error('clipboard-manager.write_text not allowed'))

    await writeClipboardText('hello')

    expect(webWrite).toHaveBeenCalledWith('hello')
  })

  it('throws when neither path exists, so a copy button can show its error state', async () => {
    pluginWriteText.mockRejectedValue(new Error('no plugin'))

    await expect(writeClipboardText('hello')).rejects.toThrow(/unavailable/i)
  })

  it('writes nothing at all for empty text', async () => {
    const webWrite = vi.fn(async () => {})
    installWebClipboard({ writeText: webWrite } as unknown as Clipboard)

    await writeClipboardText('')

    expect(pluginWriteText).not.toHaveBeenCalled()
    expect(webWrite).not.toHaveBeenCalled()
  })
})

describe('readClipboardText', () => {
  it('reads through the OS plugin and does NOT touch the web API', async () => {
    const webRead = vi.fn(async () => 'from-webview')
    installWebClipboard({ readText: webRead } as unknown as Clipboard)
    pluginReadText.mockResolvedValue('from-os')

    await expect(readClipboardText()).resolves.toBe('from-os')
    expect(webRead).not.toHaveBeenCalled()
  })

  it('falls back to the web API when the plugin rejects', async () => {
    installWebClipboard({ readText: vi.fn(async () => 'from-webview') } as unknown as Clipboard)
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('from-webview')
  })

  // A paste the platform refuses must be a no-op over a shell prompt, never a
  // thrown error — the terminal's chord handler has nowhere to put one.
  it('answers empty rather than throwing when both refuse', async () => {
    installWebClipboard({ readText: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) } as never)
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('')
  })

  it('answers empty when the webview has no clipboard object at all', async () => {
    pluginReadText.mockRejectedValue(new Error('no plugin'))

    await expect(readClipboardText()).resolves.toBe('')
  })
})

/**
 * The seam only works if it is the ONLY door.
 *
 * MJXHRM-415 installed the clipboard plugin and wired two call sites — and four
 * others went on calling `navigator.clipboard` directly, so on WebKitGTK the
 * status-bar "Copy path", the external-CLI sign-in command, the OAuth device
 * code and the mermaid text fallback each silently did nothing. Nothing failed
 * loudly, and nothing in the suite noticed: the plugin was installed but not
 * reached. A grep is the only assertion that catches the FIFTH one.
 */
describe('nothing reaches around the seam', () => {
  const SRC = path.join(process.cwd(), 'src')
  // `navigator.clipboard.write` (images) is exempt: `allow-write-image` is
  // deliberately not granted, so an image write has no OS path to take. Its TEXT
  // fallback is not exempt, which is the whole point of the svg-image change.
  const REACH_AROUND = /navigator\s*\.\s*clipboard\s*\??\s*\.\s*(writeText|readText|read)\b/

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        return sources(full)
      }

      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
    })
  }

  it('finds no direct navigator.clipboard text call outside lib/clipboard.ts', () => {
    const seam = path.join(SRC, 'lib', 'clipboard.ts')

    const offenders = sources(SRC)
      .filter(file => file !== seam)
      .filter(file => REACH_AROUND.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })

  it('scans a believable number of files (so an empty walk cannot pass it)', () => {
    expect(sources(SRC).length).toBeGreaterThan(300)
  })
})
