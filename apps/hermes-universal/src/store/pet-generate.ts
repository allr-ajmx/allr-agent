import { PET_SETTINGS_ROUTE } from '@/app/routes'
import { atom } from '@/store/atom'
import { requestGateway, subscribeGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { type PetInfo, setPetInfo } from '@/store/pet'
import { loadPetGallery } from '@/store/pet-gallery'
import { openAppRoute } from '@/store/windows'

// AI pet generation (K10.c). Three backend steps, mirrored as state here:
//   - `pet.generate` produces N cheap base-look *drafts* keyed by a `token`
//     (streamed in via `pet.generate.progress`).
//   - `pet.hatch` turns the chosen draft into a full animated pet — installed but
//     NOT active — streaming per-row progress via `pet.hatch.progress`.
//   - the user then *adopts* (`pet.select`) or *discards* (`pet.remove`) it.
// Leaned from apps/desktop/src/store/pet-generate.ts: mobile's requestGateway has
// no AbortSignal, so cancellation rides a monotonic run-id guard (stale results
// are ignored) plus a `pet.cancel` token telling the backend to stop; the
// desktop reference-image / persisted-provider / background-notify paths are
// dropped (single simple flow).

// Generation fans out many grounded image calls — far longer than the default
// RPC timeout. Hatch can take minutes per row.
const GENERATE_TIMEOUT_MS = 420_000
const HATCH_TIMEOUT_MS = 3_600_000

const NAME_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'cute',
  'for',
  'from',
  'in',
  'of',
  'on',
  'style',
  'the',
  'to',
  'with'
])

const capitalize = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w)

/** Derive a short, friendly default name from a generation prompt. */
export function cleanPetName(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const meaningful = words.filter(w => !NAME_STOPWORDS.has(w.toLowerCase()))
  const picked = (meaningful.length ? meaningful : words).slice(0, 3)
  const name = picked.map(capitalize).join(' ').slice(0, 28).trim()

  return name || 'Pet'
}

export interface PetDraft {
  index: number
  /** Downscaled PNG data URI preview from the gateway. */
  dataUri: string
}

export type PetGenStatus = 'idle' | 'generating' | 'ready' | 'hatching' | 'preview' | 'adopting' | 'error' | 'stale'

/** Live hatch step for the egg screen — which row is drawing, then compose/save. */
export interface PetHatchStage {
  phase: 'row' | 'compose' | 'save'
  state?: string
  done?: number
  total?: number
}

export const $petGenStatus = atom<PetGenStatus>('idle')
export const $petGenStage = atom<PetHatchStage | null>(null)
export const $petGenError = atom<string | null>(null)
// null = not yet probed (show the prompt optimistically); false gates the UI.
export const $petGenAvailable = atom<boolean | null>(null)
export const $petGenToken = atom<string | null>(null)
export const $petGenPrompt = atom('')
/** Drives the generate sheet's open state so `/hatch` can open it from the
 *  dispatcher (the sheet itself lives in app/pet/pet-section.tsx). */
export const $petGenOpen = atom(false)
export const $petGenDrafts = atom<PetDraft[]>([])
export const $petGenSelected = atom<number | null>(null)
/** The hatched-but-unadopted pet: its renderer payload, played in the preview. */
export const $petGenPreview = atom<PetInfo | null>(null)

const isMissingMethod = (err: unknown): boolean =>
  /method not found|-32601|unknown method|no such method/i.test(err instanceof Error ? err.message : String(err))

/** Clear all generation state (before a fresh run or on close). */
export function resetPetGen(): void {
  $petGenStatus.set('idle')
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenToken.set(null)
  $petGenPrompt.set('')
  $petGenDrafts.set([])
  $petGenSelected.set(null)
  $petGenPreview.set(null)
}

/**
 * Open the pet generator, optionally seeding the prompt (`/hatch a cyber fox`).
 * The sheet only mounts on the pet settings page, so route there first — same
 * end state as desktop's pet-generate overlay.
 */
export function openPetGenerate(concept?: string): void {
  const seed = concept?.trim()

  if (seed) {
    $petGenPrompt.set(seed)
  }

  $petGenOpen.set(true)
  openAppRoute(PET_SETTINGS_ROUTE)
}

/** Probe whether generation is possible (a reference-capable backend exists). */
export async function checkPetGenAvailable(): Promise<void> {
  try {
    const res = await requestGateway<{ available: boolean }>('pet.generate.status')
    $petGenAvailable.set(Boolean(res?.available))
  } catch {
    // Unknown (old backend / transient) — don't gate the UI on a failed probe.
    $petGenAvailable.set(true)
  }
}

// A monotonic run-id: a Stop or a fresh round bumps it so stale callbacks/events
// (and the resolved promise of a superseded call) are ignored.
let runId = 0
const bump = () => (runId += 1)

/** Generate (or retry) a fresh set of base-look drafts for `prompt`. */
export async function generateDrafts(prompt: string): Promise<boolean> {
  const text = prompt.trim()

  if (!text) {
    return false
  }

  const myRun = bump()

  // Starting a fresh round supersedes any unadopted preview pet.
  const preview = $petGenPreview.get()

  if (preview?.slug) {
    await requestGateway('pet.remove', { slug: preview.slug }).catch(() => {})
  }

  $petGenStatus.set('generating')
  $petGenError.set(null)
  $petGenPreview.set(null)
  $petGenDrafts.set([])
  $petGenSelected.set(null)

  // Stream drafts in as the backend finishes each one so the grid fills live.
  const off = subscribeGateway<PetDraft & { token?: string }>('pet.generate.progress', draft => {
    if (myRun !== runId || $petGenStatus.get() !== 'generating') {
      return
    }

    if (draft?.token) {
      $petGenToken.set(draft.token)
    }

    if (!draft?.dataUri || typeof draft.index !== 'number') {
      return
    }

    const current = $petGenDrafts.get()

    if (current.some(d => d.index === draft.index)) {
      return
    }

    $petGenDrafts.set([...current, { index: draft.index, dataUri: draft.dataUri }].sort((a, b) => a.index - b.index))
  })

  try {
    const result = await requestGateway<{ ok: boolean; token: string; drafts: PetDraft[] }>(
      'pet.generate',
      { prompt: text, style: 'auto', count: 4 },
      GENERATE_TIMEOUT_MS
    )

    if (myRun !== runId) {
      return false
    }

    if (!result?.ok || !result.drafts?.length) {
      throw new Error('generation produced no drafts')
    }

    $petGenToken.set(result.token)
    $petGenPrompt.set(text)
    $petGenDrafts.set(result.drafts)
    $petGenSelected.set(result.drafts[0]?.index ?? 0)
    $petGenStatus.set('ready')

    return true
  } catch (e) {
    if (myRun !== runId) {
      return false
    }

    if (isMissingMethod(e)) {
      $petGenStatus.set('stale')
    } else {
      $petGenStatus.set('error')
      $petGenError.set(e instanceof Error ? e.message : 'Could not generate pet drafts.')
    }

    return false
  } finally {
    off()
  }
}

/** Abandon drafts (Stop) and return to the prompt; keeps the prompt text. */
export function cancelGenerate(): void {
  const token = $petGenToken.get()

  if (token) {
    void requestGateway('pet.cancel', { token }).catch(() => {})
  }

  bump()
  $petGenStatus.set('idle')
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenDrafts.set([])
  $petGenSelected.set(null)
  $petGenToken.set(null)
}

/** Hatch the selected draft into a full pet (installed, not yet active). */
export async function hatchSelected(name: string): Promise<boolean> {
  const token = $petGenToken.get()
  const index = $petGenSelected.get()
  const finalName = name.trim()
  const concept = ($petGenPrompt.get() || finalName).trim()

  if (token === null || index === null || !finalName) {
    return false
  }

  // Hatch cancellation rides its own token (not the draft token).
  const cancelToken = crypto.randomUUID()
  const myRun = bump()

  $petGenStatus.set('hatching')
  $petGenStage.set(null)
  $petGenError.set(null)

  const off = subscribeGateway<{ event: string; state?: string; done?: string; total?: string }>(
    'pet.hatch.progress',
    p => {
      if (!p || myRun !== runId || $petGenStatus.get() !== 'hatching') {
        return
      }

      if (p.event === 'row' && p.state) {
        $petGenStage.set({
          phase: 'row',
          state: p.state,
          done: Number(p.done) || undefined,
          total: Number(p.total) || undefined
        })
      } else if (p.event === 'compose') {
        $petGenStage.set({ phase: 'compose' })
      } else if (p.event === 'save') {
        $petGenStage.set({ phase: 'save' })
      }
    }
  )

  try {
    const result = await requestGateway<{ ok: boolean; slug: string; displayName: string; pet?: PetInfo }>(
      'pet.hatch',
      { token, cancelToken, index, name: finalName, description: '', prompt: concept, style: 'auto' },
      HATCH_TIMEOUT_MS
    )

    if (myRun !== runId) {
      // Superseded: the server made the pet anyway, so delete it.
      if (result?.slug) {
        void requestGateway('pet.remove', { slug: result.slug }).catch(() => {})
      }

      return false
    }

    if (!result?.ok || !result.pet?.spritesheetBase64) {
      throw new Error('hatch produced no preview')
    }

    $petGenPreview.set({ ...result.pet, enabled: true })
    $petGenStatus.set('preview')

    return true
  } catch (e) {
    if (myRun !== runId) {
      return false
    }

    $petGenStatus.set('error')
    $petGenError.set(e instanceof Error ? e.message : 'Could not hatch the pet.')

    return false
  } finally {
    off()

    if (myRun === runId) {
      $petGenStage.set(null)
    }
  }
}

/** Stop the in-flight hatch and return to the draft picker. */
export function cancelHatch(): void {
  bump()
  $petGenStage.set(null)
  $petGenError.set(null)
  $petGenStatus.set($petGenDrafts.get().length > 0 ? 'ready' : 'idle')
}

/** Adopt the previewed pet: optionally rename, activate (`pet.select`), refresh. */
export async function adoptHatched(name?: string): Promise<boolean> {
  const preview = $petGenPreview.get()

  if (!preview?.slug) {
    return false
  }

  $petGenStatus.set('adopting')
  $petGenError.set(null)

  try {
    const finalName = name?.trim()
    let adoptSlug = preview.slug

    if (finalName && finalName !== preview.displayName) {
      const renamed = await requestGateway<{ ok: boolean; slug: string }>('pet.rename', {
        slug: preview.slug,
        name: finalName
      }).catch(() => null)

      if (renamed?.slug) {
        adoptSlug = renamed.slug
      }
    }

    const result = await requestGateway<{ ok: boolean; slug: string; displayName: string }>('pet.select', {
      slug: adoptSlug
    })

    if (!result?.ok) {
      throw new Error('adopt failed')
    }

    // Reflect the new active mascot locally + refresh the gallery.
    setPetInfo({ ...preview, slug: result.slug, displayName: result.displayName || finalName || preview.displayName })
    resetPetGen()
    void loadPetGallery(true)

    return true
  } catch (e) {
    $petGenStatus.set('preview')
    $petGenError.set(e instanceof Error ? e.message : 'Could not adopt the pet.')
    notifyError(e, 'Could not adopt the pet.')

    return false
  }
}

/** Throw away the previewed pet and return to the draft picker. */
export async function discardHatched(): Promise<void> {
  const preview = $petGenPreview.get()

  if (preview?.slug) {
    await requestGateway('pet.remove', { slug: preview.slug }).catch(() => {})
  }

  $petGenPreview.set(null)
  $petGenError.set(null)
  $petGenStatus.set($petGenDrafts.get().length > 0 ? 'ready' : 'idle')
}
