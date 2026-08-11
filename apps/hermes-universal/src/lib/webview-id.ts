// Identifies THIS WebView, for any cross-WebView broadcast that has to drop its
// own echo (`emit` is global — the sender receives what it sent).
//
// Deliberately not the Tauri window label: the mobile activity screens are extra
// webviews inside ONE window and can share a label, which would make them discard
// each other's events as self-echo.
//
// Lives in lib/ rather than beside its first caller because it is now shared by
// two independent broadcasts (gateway switching, appearance). One id per WebView
// is the point — two generators would mean a surface with two identities, and a
// receiver that only recognises half its own echoes.
export const WEBVIEW_ID = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()
