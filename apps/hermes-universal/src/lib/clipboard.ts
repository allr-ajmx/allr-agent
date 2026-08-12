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
// `src-tauri/capabilities/default.json`: `clipboard-manager:allow-read-text`
// and `allow-write-text`, granted to every window label the
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
