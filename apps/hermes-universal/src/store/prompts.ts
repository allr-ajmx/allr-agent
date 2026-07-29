import { atom, computed, type ReadableAtom } from 'nanostores'

import { $activeSessionKey } from '@/store/session-state-types'

// The blocking-prompt request shapes. They live HERE, not in store/chat.ts,
// because this module is the single owner of prompt state for every session and
// must not depend on the chat store at runtime (store/chat.ts re-exports these
// types for the existing import sites).

export interface ApprovalRequest {
  command: string
  description: string
  allowPermanent: boolean
  // Gateway-restricted choice set (e.g. a tirith warning drops `always`), and the
  // smart-deny flag that implies `['once', 'deny']`. Both optional — the backend
  // omits them on a plain approval. Mirrors desktop's ApprovalRequest.
  choices?: string[]
  smartDenied?: boolean
}
export interface ClarifyRequest {
  requestId: string
  question: string
  // Up to 4 predefined answers (tools/clarify_tool.py); null for an open-ended
  // question. The inline ClarifyTool reads BOTH fields from here — `tool.start`
  // ships no args, so the event payload is the only source for the panel.
  choices: string[] | null
}
// Sudo is a password-entry flow (not an allow/deny choice).
export interface SudoRequest {
  requestId: string
  prompt: string
}
export interface SecretRequest {
  requestId: string
  envVar: string
  prompt: string
}

// ---------------------------------------------------------------------------
// Per-session blocking prompts, keyed by SESSION KEY (see
// store/session-state-types.ts). Every session — the one on screen, a tile, a
// background bubble — stores its prompt here; the chat store's `$approval` /
// `$clarify` / `$sudo` / `$secret` are computed views of the ACTIVE session's
// entry. There is no primary/tile duality: `setSessionApproval(key, …)` is the
// only writer. Mirrors desktop's `keyedPromptStore`.
// ---------------------------------------------------------------------------

interface KeyedPromptStore<T> {
  /** The whole map (used to compute cross-session aggregates). */
  $all: ReadableAtom<Record<string, T>>
  /** Drop every session's request. */
  clearAll: () => void
  /** A per-id readable atom (memoized) — the request for that session, or null. */
  forId: (id: string) => ReadableAtom<T | null>
  /** Set (or clear, when null) the request for a session. */
  set: (id: string, value: T | null) => void
}

function keyedPromptStore<T>(): KeyedPromptStore<T> {
  const $all = atom<Record<string, T>>({})
  const perId = new Map<string, ReadableAtom<T | null>>()

  return {
    $all,
    clearAll() {
      if (Object.keys($all.get()).length > 0) {
        $all.set({})
      }
    },
    forId(id) {
      const existing = perId.get(id)

      if (existing) {
        return existing
      }

      const derived = computed($all, all => all[id] ?? null)
      perId.set(id, derived)

      return derived
    },
    set(id, value) {
      const current = $all.get()

      if (value === null) {
        if (id in current) {
          const { [id]: _dropped, ...rest } = current
          $all.set(rest)
        }

        return
      }

      $all.set({ ...current, [id]: value })
    }
  }
}

const approvalStore = keyedPromptStore<ApprovalRequest>()
const clarifyStore = keyedPromptStore<ClarifyRequest>()
const sudoStore = keyedPromptStore<SudoRequest>()
const secretStore = keyedPromptStore<SecretRequest>()

// --- The ACTIVE session's prompts (what store/chat.ts re-exports) -----------

const activePrompt = <T>(store: KeyedPromptStore<T>): ReadableAtom<T | null> =>
  computed([$activeSessionKey, store.$all], (key, all) => all[key] ?? null)

export const $approval = activePrompt(approvalStore)
export const $clarify = activePrompt(clarifyStore)
export const $sudo = activePrompt(sudoStore)
export const $secret = activePrompt(secretStore)

// The active turn is parked waiting on the user (a clarify / approval / sudo /
// secret prompt is open). The main composer's Esc handling reads this to avoid
// interrupting a turn that's actually waiting for input.
export const $activeSessionAwaitingInput = computed(
  [$clarify, $approval, $sudo, $secret],
  (clarify, approval, sudo, secret) => Boolean(clarify || approval || sudo || secret)
)

export const sessionApprovalRequest = (id: string) => approvalStore.forId(id)
export const sessionClarifyRequest = (id: string) => clarifyStore.forId(id)
export const sessionSudoRequest = (id: string) => sudoStore.forId(id)
export const sessionSecretRequest = (id: string) => secretStore.forId(id)

export const setSessionApproval = (id: string, req: ApprovalRequest | null) => approvalStore.set(id, req)
export const setSessionClarify = (id: string, req: ClarifyRequest | null) => clarifyStore.set(id, req)
export const setSessionSudo = (id: string, req: SudoRequest | null) => sudoStore.set(id, req)
export const setSessionSecret = (id: string, req: SecretRequest | null) => secretStore.set(id, req)

export const clearSessionApproval = (id: string) => approvalStore.set(id, null)
export const clearSessionClarify = (id: string) => clarifyStore.set(id, null)
export const clearSessionSudo = (id: string) => sudoStore.set(id, null)
export const clearSessionSecret = (id: string) => secretStore.set(id, null)

/** All per-session blocking prompts cleared — for one session (id) or all. */
export function clearAllPrompts(id?: string): void {
  if (id) {
    clearSessionApproval(id)
    clearSessionClarify(id)
    clearSessionSudo(id)
    clearSessionSecret(id)

    return
  }

  approvalStore.clearAll()
  clarifyStore.clearAll()
  sudoStore.clearAll()
  secretStore.clearAll()
}

/** Whether a specific (tiled) session's turn is parked on a blocking prompt. */
export function sessionAwaitingInput(id: string): ReadableAtom<boolean> {
  return computed(
    [approvalStore.forId(id), clarifyStore.forId(id), sudoStore.forId(id), secretStore.forId(id)],
    (approval, clarify, sudo, secret) => Boolean(approval || clarify || sudo || secret)
  )
}
