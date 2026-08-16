import { atom } from 'nanostores'

import type { WebhookCreateResponse } from '@/hermes'

// The one-time secret, held OUTSIDE the component tree.
//
// `POST /api/webhooks` returns the generated HMAC secret exactly once — the
// backend masks it on every subsequent read (`_webhook_route_summary` reports
// `secret_set`, never the value). So the reveal is the only chance the user
// gets, and anything that can unmount the surface holding it destroys it:
// dismissing the dialog with Esc or a click outside, an error path that
// re-renders the page, a route change, the overlay closing, another window
// stealing the route. Desktop's page keeps it in `useState` inside the view and
// clears it in `closeCreate()`, so every one of those loses it silently.
//
// A module atom outlives all of them: the view re-mounts, re-reads this, and
// puts the dialog straight back up. Only an explicit acknowledgement clears an
// entry — dismissal never does.
//
// It is a QUEUE, not a slot: creating a second subscription while the first
// secret is still unacknowledged must not overwrite it. Same-name re-creates DO
// replace (the older secret is dead — the route was rewritten).
//
// Deliberately in memory only. Persisting an HMAC secret to localStorage would
// trade a recoverable loss for an unrecoverable disclosure; the recovery path
// for a lost secret is to delete the subscription and create it again (or to
// supply your own secret at create time, which this client offers precisely so
// the one-time reveal is optional).
//
// The one boundary this cannot cross: on Android the Webhooks page can open as
// a native screen ACTIVITY, which is its own WebView with its own JS heap, and
// the hardware Back button finishes that Activity from Kotlin with no JS hook to
// intercept (`store/windows.ts` → `open_screen_window`). Inside the reveal every
// in-page dismissal is blocked, so leaving is deliberate — but a hardware Back
// there ends the heap this atom lives in. That is exactly why the create form
// offers a caller-supplied secret and why the reveal states the delete-and-
// recreate recovery in words: neither depends on this atom surviving.

export interface PendingWebhookSecret {
  /** True once a copy actually reached the clipboard (CopyButton's onCopied). */
  copied: boolean
  createdAt: number
  name: string
  secret: string
  url: string
}

export const $pendingWebhookSecrets = atom<readonly PendingWebhookSecret[]>([])

/** Record a freshly created subscription's secret. Call this BEFORE anything
 *  that can throw, await or navigate — the value has no second source. */
export function rememberWebhookSecret(created: WebhookCreateResponse): void {
  if (!created.secret) {
    return
  }

  const entry: PendingWebhookSecret = {
    copied: false,
    createdAt: Date.now(),
    name: created.name,
    secret: created.secret,
    url: created.url
  }

  $pendingWebhookSecrets.set([...$pendingWebhookSecrets.get().filter(item => item.name !== entry.name), entry])
}

/** The secret the dialog should be showing, or null. */
export function nextPendingWebhookSecret(
  entries: readonly PendingWebhookSecret[] = $pendingWebhookSecrets.get()
): PendingWebhookSecret | null {
  return entries[0] ?? null
}

export function pendingWebhookSecretFor(
  name: string,
  entries: readonly PendingWebhookSecret[] = $pendingWebhookSecrets.get()
): PendingWebhookSecret | null {
  return entries.find(item => item.name === name) ?? null
}

/** A copy reached the clipboard. Does NOT clear the entry: a copy can still be
 *  overwritten before it is pasted, so the user says when they are done. */
export function markWebhookSecretCopied(name: string): void {
  $pendingWebhookSecrets.set(
    $pendingWebhookSecrets.get().map(item => (item.name === name ? { ...item, copied: true } : item))
  )
}

/** The ONLY thing that drops a secret. Wired exclusively to the explicit
 *  "I have saved this secret" confirmation — never to a close/Esc/outside-click
 *  path, and never to an unmount. */
export function acknowledgeWebhookSecret(name: string): void {
  $pendingWebhookSecrets.set($pendingWebhookSecrets.get().filter(item => item.name !== name))
}

/** Test seam — the atom is module state and vitest shares modules across files. */
export function resetPendingWebhookSecrets(): void {
  $pendingWebhookSecrets.set([])
}
