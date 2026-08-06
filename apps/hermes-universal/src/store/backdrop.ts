import { Codecs, persistentAtom } from '@/lib/persisted'

// The faint statue image behind the conversation (desktop `store/backdrop.ts`).
// On by default and persisted per device — it is decoration, so the only state
// it needs is whether the user wants to see it.
export const $backdrop = persistentAtom<boolean>('hermes.backdrop', true, Codecs.bool)

export const setBackdrop = (on: boolean) => $backdrop.set(on)
