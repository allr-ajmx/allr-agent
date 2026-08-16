import { IS_DESKTOP } from '@/lib/platform'

// The app's ONE clipboard seam. Every read and every write goes through here.
//
// Why a seam at all: universal renders in WebKitGTK on the Linux desktop, not
// Chromium (see MJXHRM-415). WebKitGTK gates the async Clipboard API far more
// tightly than Chromium — `readText` is refused outright in cases Chromium
// allows, and a write outside a user gesture can be dropped — so a call site
// that reaches for `navigator.clipboard` directly is a call site that silently
// does nothing on the platform we ship. The Tauri clipboard-manager plugin goes
// through the OS instead, so no engine gate applies.
//
// Order is therefore always: plugin first, web API second. The web API stays as
// the fallback for targets without the plugin (browser dev, `npm run dev`), and
// because a fallback that works is better than a hard failure. The plugin call
// itself is inside the try: without `window.__TAURI_INTERNALS__` the module
// still IMPORTS fine and only `invoke` rejects, so guarding the import alone
// would not catch it.
//
// The capability chain behind the plugin lives in
// `src-tauri/capabilities/default.json`: `clipboard-manager:allow-read-text`,
// `allow-write-text` and `allow-read-image`, granted to every window label the
// app opens (`main`, `session-*`, `instance-*`, `tile-*`, `sat-*`, `screen`). A
// missing grant does not throw at build time on the JS side — it rejects at
// `invoke`, which lands in the same catch as "plugin absent" and degrades to the
// web API. That is deliberate, but it means the grant list is load-bearing: an
// unlisted window label loses the OS path without any visible signal.

/**
 * Write text to the system clipboard.
 *
 * Throws when neither path is available, so a copy button can show its error
 * state. Callers that must not surface a failure catch it themselves.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (!text) {
    return
  }

  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')

    await writeText(text)

    return
  } catch {
    // Plugin unavailable or refused — fall through to the webview's own API.
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)

    return
  }

  throw new Error('Clipboard API is unavailable')
}

/**
 * Read text from the system clipboard.
 *
 * Returns '' rather than throwing: the caller is a paste, and a paste the
 * platform refuses must be a no-op, not an error dialog over a shell prompt.
 */
export async function readClipboardText(): Promise<string> {
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')

    return (await readText()) ?? ''
  } catch {
    // Plugin unavailable or refused — fall through to the webview's own API.
  }

  try {
    return (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    return ''
  }
}

/**
 * Can this target read an IMAGE off the clipboard at all?
 *
 * Text is universal; images are not. The plugin's `read_image` is a hard
 * "Unsupported on this platform" on Android and iOS (its `mobile.rs` returns an
 * error without ever reaching the OS), and `navigator.clipboard.read` is a
 * Chromium-family API that WebKitGTK does not implement. So the honest answer is
 * desktop-with-the-plugin, or a browser that has the async read API.
 *
 * Exported because a control that can never succeed should not be offered: the
 * composer withholds its "Paste image" action when this is false, which renders
 * the menu entry disabled instead of enabled-and-always-failing.
 */
export function canReadClipboardImage(): boolean {
  return IS_DESKTOP || typeof navigator.clipboard?.read === 'function'
}

// The plugin hands back raw RGBA (row-major, top to bottom) plus a size, which
// is what the OS clipboard actually holds — not an encoded file. Re-encode to
// PNG so the rest of the app only ever deals in blobs.
async function rgbaToPngBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob | null> {
  if (!width || !height || rgba.length < width * height * 4) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return null
  }

  // `createImageData` rather than `new ImageData(...)`: the constructor will not
  // take a view onto a SharedArrayBuffer, and a Uint8Array that arrived over IPC
  // makes no promise about which kind of buffer backs it. Copying into the
  // context's own buffer sidesteps that entirely.
  const image = ctx.createImageData(width, height)

  image.data.set(rgba.subarray(0, image.data.length))
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
}

/**
 * Read an image off the system clipboard, or null when there isn't one.
 *
 * Never throws: "no image on the clipboard" and "this platform will not tell us"
 * are the same answer to the caller, and both are ordinary.
 */
export async function readClipboardImage(): Promise<Blob | null> {
  if (IS_DESKTOP) {
    try {
      const { readImage } = await import('@tauri-apps/plugin-clipboard-manager')
      const image = await readImage()
      const [{ height, width }, rgba] = await Promise.all([image.size(), image.rgba()])

      return await rgbaToPngBlob(rgba, width, height)
    } catch {
      // Empty clipboard, text-only clipboard, or a platform that refuses.
    }
  }

  try {
    for (const item of (await navigator.clipboard?.read?.()) ?? []) {
      const type = item.types.find(t => t.startsWith('image/'))

      if (type) {
        return await item.getType(type)
      }
    }
  } catch {
    // No permission, no gesture, or no such API.
  }

  return null
}
