import { translateNow } from '@/i18n'
import type { BillingBlock } from '@/lib/billing/billing-types'
import { openExternalLink } from '@/lib/external-link'
import { atom } from '@/store/atom'
import { notify } from '@/store/notifications'

// Ported from apps/desktop/src/store/billing-block.ts. One deliberate divergence:
// desktop needs a `$billingSettingsRequest` intent COUNTER because a toast fired
// outside React has no `useNavigate`, so the shell has to observe the counter and
// navigate on its behalf. Universal navigates from module scope
// (`store/windows.ts` → `openSettingsScreen` → `lib/route-nav`), so the counter
// has nothing to solve here — `requestBillingSettings` just opens the route, and
// on Android that same call promotes to the native Settings activity for free.

/**
 * The active inference billing wall, if any. Set from the gateway
 * `message.complete` event when a turn fails with `FailoverReason.billing` (see
 * `agent/billing_links.py`; the gateway attaches it as `payload.billing`). One
 * global slot: a credit wall on the active session's provider is the whole app's
 * problem, and the newest block wins. Cleared when a new turn starts on that
 * session or the user dismisses it.
 */
export interface ActiveBillingBlock {
  block: BillingBlock
  sessionId: string
  at: number
}

export const $billingBlock = atom<ActiveBillingBlock | null>(null)

export function setBillingBlock(sessionId: string, block: BillingBlock): void {
  $billingBlock.set({ at: Date.now(), block, sessionId })
}

export function clearBillingBlock(sessionId?: string): void {
  const current = $billingBlock.get()

  if (!current) {
    return
  }

  // A scoped clear (new turn on session X) must not wipe a block raised by a
  // different session's provider.
  if (sessionId && current.sessionId !== sessionId) {
    return
  }

  $billingBlock.set(null)
}

/** Settings drill-in for the billing page — the in-app recovery target. */
export const BILLING_SETTINGS_ROUTE = '/settings/billing'

/**
 * Open Settings → Billing. Dynamic import so this leaf store stays out of
 * `store/windows.ts`'s module graph (`@tauri-apps/api/app` + the route registry)
 * — it is imported by the gateway event router, which runs in tests that mock
 * neither.
 */
export function requestBillingSettings(): void {
  void import('@/store/windows').then(m => m.openSettingsScreen(BILLING_SETTINGS_ROUTE)).catch(() => {})
}

/**
 * The single recovery action for a billing wall, shared by the toast and the
 * in-chat banner so both behave identically: Nous routes to the in-app
 * Settings → Billing surface; a third-party provider deep-links to its own
 * billing page (falling back to the in-app surface only if we have no URL).
 */
export function runBillingRecovery(block: BillingBlock): void {
  if (block.is_nous) {
    requestBillingSettings()

    return
  }

  if (block.billing_url) {
    openExternalLink(block.billing_url)

    return
  }

  requestBillingSettings()
}

export function billingCtaLabel(block: BillingBlock, copy: { addCredits: string; openBilling: string }): string {
  return block.is_nous ? copy.openBilling : copy.addCredits
}

function firstBillingLine(text: string): string {
  return (text || '').split('\n')[0]?.trim() ?? ''
}

/**
 * A turn failed on a billing wall (out of credits / payment required). The
 * gateway forwards the structured descriptor built by `agent/billing_links.py`;
 * we cache it per-session (drives the in-chat banner) AND raise one sticky,
 * billing-specific toast — never the generic "Hermes error" — with a smart CTA
 * (Nous → in-app Settings → Billing, other providers → their billing page).
 *
 * Takes the raw wire value so the caller does not have to validate it: a payload
 * that is not an object, or has no `provider`, is ignored rather than cached as a
 * half-formed block the banner would then render blank.
 */
export function surfaceBillingBlock(sessionId: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    return
  }

  const block = raw as BillingBlock

  if (typeof block.provider !== 'string') {
    return
  }

  setBillingBlock(sessionId, block)

  const ctaCopy = {
    addCredits: translateNow('billingBlock.addCredits'),
    openBilling: translateNow('billingBlock.openBilling')
  }

  notify({
    // Sticky: a credit wall blocks every turn until it is resolved.
    action: { label: billingCtaLabel(block, ctaCopy), onClick: () => runBillingRecovery(block) },
    durationMs: 0,
    icon: 'credit-card',
    // Collapse repeat walls from the same provider into one toast.
    id: `billing-block:${block.provider}`,
    kind: 'warning',
    message: firstBillingLine(block.message) || translateNow('billingBlock.fallbackMessage'),
    title: block.is_nous
      ? translateNow('billingBlock.titleNous')
      : translateNow('billingBlock.titleProvider', block.provider_label)
  })
}
