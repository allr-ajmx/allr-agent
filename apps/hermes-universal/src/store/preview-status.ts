import { previewName } from '@/lib/preview-targets'
import { atom } from '@/store/atom'

// Ported from apps/desktop/src/store/preview-status.ts.
//
// Session-scoped feed of previewable artifacts (HTML files, localhost dev URLs)
// a tool produced. Fed from the tool row (tool/fallback.tsx) using the same
// detected target the desktop inline card used.
//
// FIXME(MJX-106): `use-status-presence.ts` already reads this for the presence
// boolean, but the compact links desktop shows in the composer status stack are
// still missing — `PreviewStatusRow` is a null stub and isn't mounted. Wiring it
// up also needs an `openPreviewInBrowser` equivalent for the click target.
export interface PreviewArtifact {
  /** cwd captured at detection so a relative path still resolves on click. */
  cwd: string
  /** Dedupe key + display id (the raw target). */
  id: string
  label: string
  target: string
}

const MAX_PER_SESSION = 4

export const $previewStatusBySession = atom<Record<string, PreviewArtifact[]>>({})

const writePreviews = (sid: string, items: PreviewArtifact[]) => {
  const current = $previewStatusBySession.get()

  if (items.length === 0) {
    if (!current[sid]) {
      return
    }

    const next = { ...current }
    delete next[sid]
    $previewStatusBySession.set(next)

    return
  }

  $previewStatusBySession.set({ ...current, [sid]: items })
}

/**
 * Record a detected artifact, newest last, capped. Idempotent: a target already
 * in the list keeps its slot (the tool row re-registers on every render, so this
 * must not churn the atom or reorder rows).
 */
export function recordPreviewArtifact(sid: string, target: string, cwd: string) {
  const raw = target.trim()

  if (!sid || !raw) {
    return
  }

  const list = $previewStatusBySession.get()[sid] ?? []

  if (list.some(item => item.id === raw)) {
    return
  }

  writePreviews(sid, [...list, { cwd, id: raw, label: previewName(raw), target: raw }].slice(-MAX_PER_SESSION))
}

export function dismissPreviewArtifact(sid: string, id: string) {
  const list = $previewStatusBySession.get()[sid]

  if (list) {
    writePreviews(
      sid,
      list.filter(item => item.id !== id)
    )
  }
}

export function clearPreviewArtifacts(sid: string) {
  writePreviews(sid, [])
}
