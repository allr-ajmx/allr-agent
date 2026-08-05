import { atom } from '@/store/atom'

/**
 * Reaction signal bus. `id` is a monotonic nonce so a consumer fires once per
 * bump; `kind` selects the renderer (today only `vibe` → hearts). Generic on
 * purpose so future reactions (emoji, etc.) ride the same channel.
 *
 * NOTE: this has no consumer yet. On desktop it lives in `store/pet-overlay.ts`
 * and mirrors a burst into the popped-out pet's own OS window, so the pet reacts
 * even while the app is minimized. Universal is single-window (see
 * `app/pet/floating-pet.tsx`), so there is nothing to mirror to — the bus is
 * carried anyway, and kept bumped on every reaction, so a future pop-out window
 * can subscribe without reworking the trigger path.
 */
export interface PetReaction {
  id: number
  kind: string
}

export const $petReaction = atom<PetReaction | null>(null)

export const forwardPetReaction = (kind: string) => $petReaction.set({ id: ($petReaction.get()?.id ?? 0) + 1, kind })
