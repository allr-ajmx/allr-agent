import { invoke } from '@tauri-apps/api/core'

import { artifactContentHash, type ArtifactDetection, type ArtifactKind, artifactSlug } from '@/lib/artifact-detect'
import { IS_TAURI } from '@/lib/platform'
import { atom } from '@/store/atom'

import { closeArtifactPreviewTabs, openArtifactPreviewTab } from './preview'

/**
 * ARTIFACT REGISTRY — substantial generated content (HTML pages, large SVGs,
 * long code) produced in the transcript, promoted out of the message flow into
 * versioned content the right rail can preview. The registry is authoritative
 * for artifact content; a rail tab only ever holds a reference to it, so a new
 * version shows up in an already-open tab.
 *
 * Identity: one artifact = one (session, slug) pair, where the slug derives
 * from kind + language + title. When the model regenerates "the dashboard"
 * three times in a session, that is ONE artifact with three versions, exactly
 * like a document the user keeps refining — not three cards.
 *
 * Memory-only: the transcript is the durable copy. Cards re-register as they
 * render, so a reload rebuilds the registry (and its version history) for free
 * instead of parking megabytes of generated HTML in localStorage.
 */

export interface ArtifactVersion {
  content: string
  createdAt: number
  hash: string
}

export interface ArtifactRecord {
  createdAt: number
  id: string
  kind: ArtifactKind
  language: string
  sessionId: string
  slug: string
  title: string
  updatedAt: number
  /** Oldest → newest. The last entry is the current version. */
  versions: ArtifactVersion[]
}

export type ArtifactRegistry = Record<string, ArtifactRecord[]>

const MAX_ARTIFACTS_PER_SESSION = 24
const MAX_VERSIONS_PER_ARTIFACT = 20
const MAX_SESSIONS = 40

function pruneRegistry(registry: ArtifactRegistry): ArtifactRegistry {
  const entries = Object.entries(registry)
    .map(([sessionId, records]) => {
      const trimmed = [...records]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_ARTIFACTS_PER_SESSION)
        .sort((a, b) => a.createdAt - b.createdAt)

      return [sessionId, trimmed] as const
    })
    .filter(([, records]) => records.length > 0)
    .sort(([, a], [, b]) => {
      const latest = (records: readonly ArtifactRecord[]) => Math.max(...records.map(record => record.updatedAt))

      return latest(b) - latest(a)
    })
    .slice(0, MAX_SESSIONS)

  return Object.fromEntries(entries)
}

export const $artifactRegistry = atom<ArtifactRegistry>({})

/** Per-artifact selected version index; absent = newest. */
export const $artifactVersionSelection = atom<Record<string, number>>({})

/** Lookup against a registry value, for components that already subscribe to
 *  the atom and need the record to change identity when it does. */
export function findArtifact(registry: ArtifactRegistry, artifactId: string): ArtifactRecord | null {
  for (const records of Object.values(registry)) {
    const found = records.find(record => record.id === artifactId)

    if (found) {
      return found
    }
  }

  return null
}

export function getArtifact(artifactId: string): ArtifactRecord | null {
  return findArtifact($artifactRegistry.get(), artifactId)
}

export function artifactsForSession(sessionId: string | null | undefined): ArtifactRecord[] {
  const id = sessionId?.trim()

  if (!id) {
    return []
  }

  return $artifactRegistry.get()[id] ?? []
}

/** Re-base a pinned version index after `dropped` versions fell off the front. */
function shiftVersionPin(artifactId: string, dropped: number): void {
  if (dropped <= 0) {
    return
  }

  const selection = $artifactVersionSelection.get()
  const pinned = selection[artifactId]

  if (pinned === undefined) {
    return
  }

  $artifactVersionSelection.set({ ...selection, [artifactId]: Math.max(0, pinned - dropped) })
}

interface UpsertResult {
  artifactId: string
  record: ArtifactRecord
  /** True when this call appended a NEW version (vs. deduped/no-op). */
  versionAdded: boolean
}

/**
 * Register (or version) an artifact for a session. Same slug + same content
 * hash is a no-op (streaming remounts and transcript re-renders call this
 * repeatedly); same slug + new content appends a version.
 */
export function upsertArtifact(
  sessionId: string | null | undefined,
  detection: ArtifactDetection,
  content: string
): UpsertResult | null {
  const id = sessionId?.trim()
  const trimmed = content.trim()

  if (!id || !trimmed) {
    return null
  }

  const slug = artifactSlug(detection)
  const hash = artifactContentHash(trimmed)
  const registry = $artifactRegistry.get()
  const records = registry[id] ?? []
  const existing = records.find(record => record.slug === slug)
  const now = Date.now()

  if (existing) {
    const known = existing.versions.some(version => version.hash === hash)

    if (known) {
      return { artifactId: existing.id, record: existing, versionAdded: false }
    }

    const grown = [...existing.versions, { content: trimmed, createdAt: now, hash }]
    const versions = grown.slice(-MAX_VERSIONS_PER_ARTIFACT)

    // Dropping the oldest version renumbers every remaining one, and a pinned
    // selection is an INDEX. Left alone, the viewer someone parked on v3 would
    // quietly start showing what used to be v4 — the content changing under an
    // open pane with nothing on screen saying so. Shift the pin by as many as
    // fell off the front so it keeps naming the same version, and let it clamp
    // at the oldest survivor once the one it named is gone.
    shiftVersionPin(existing.id, grown.length - versions.length)

    const next: ArtifactRecord = {
      ...existing,
      // A regenerated artifact may carry a sharper title (html <title> arrives
      // late in the stream); prefer the newest non-generic one.
      title: detection.title || existing.title,
      updatedAt: now,
      versions
    }

    $artifactRegistry.set(
      pruneRegistry({
        ...registry,
        [id]: records.map(record => (record.id === existing.id ? next : record))
      })
    )

    return { artifactId: existing.id, record: next, versionAdded: true }
  }

  const record: ArtifactRecord = {
    createdAt: now,
    id: `${id}:${slug}`,
    kind: detection.kind,
    language: detection.language,
    sessionId: id,
    slug,
    title: detection.title,
    updatedAt: now,
    versions: [{ content: trimmed, createdAt: now, hash }]
  }

  $artifactRegistry.set(pruneRegistry({ ...registry, [id]: [...records, record] }))

  return { artifactId: record.id, record, versionAdded: true }
}

/** Open an artifact in the right pane at `versionIndex` (default: newest).
 *  User-initiated only (card click) — never called from streaming, per the
 *  no-hijack rule. */
export function openArtifact(artifactId: string, versionIndex?: number) {
  const record = getArtifact(artifactId)

  if (!record) {
    return
  }

  selectArtifactVersion(artifactId, versionIndex ?? record.versions.length - 1)
  openArtifactPreviewTab(record.id, record.title)
}

export function selectArtifactVersion(artifactId: string, versionIndex: number) {
  const record = getArtifact(artifactId)

  if (!record) {
    return
  }

  const clamped = Math.max(0, Math.min(record.versions.length - 1, versionIndex))
  const selection = $artifactVersionSelection.get()

  if (clamped === record.versions.length - 1) {
    if (artifactId in selection) {
      const { [artifactId]: _dropped, ...rest } = selection
      $artifactVersionSelection.set(rest)
    }

    return
  }

  $artifactVersionSelection.set({ ...selection, [artifactId]: clamped })
}

/**
 * Hand a composed artifact document to the native side so the sandboxed frame
 * can load it from `hermes-artifact://` — see src-tauri/src/artifact.rs for why
 * the frame gets an origin instead of a `srcdoc`.
 *
 * Keyed by content hash, so re-staging the same document is idempotent and the
 * frame's `src` stays stable across re-renders (a changing src would reload —
 * and re-run — the page).
 */
export async function stageArtifactDocument(documentId: string, html: string): Promise<boolean> {
  if (!IS_TAURI) {
    return false
  }

  try {
    await invoke('artifact_stage', { html, id: documentId })

    return true
  } catch {
    return false
  }
}

/** Drop a staged document once its frame is gone. */
export async function releaseStagedArtifact(documentId: string): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  try {
    await invoke('artifact_release', { id: documentId })
  } catch {
    // Best effort: the staging map is capped and process-lifetime anyway.
  }
}

export function clearArtifactRegistry() {
  $artifactRegistry.set({})
  $artifactVersionSelection.set({})
  closeArtifactPreviewTabs()
}
