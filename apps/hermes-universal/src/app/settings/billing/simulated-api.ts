import type { BillingChargeStatusResponse, ChargeFailureReason } from '@/lib/billing/billing-types'

import type { BillingApi, BillingRefusal, BillingResult } from './api'
import { formatAmountForRequest, formatMoney, parseAmount } from './billing-amounts'
import type { BillingStateResponse, SubscriptionPreviewResponse, SubscriptionStateResponse } from './types'

/** The shape of one `billingDevFixtures` entry — a canned billing + subscription pair. */
export interface SimulatedFixture {
  billing: BillingResult<BillingStateResponse>
  subscription: BillingResult<SubscriptionStateResponse>
}

/**
 * How the simulated api's *mutations* behave, orthogonal to which account state the
 * fixture describes — so any of the 16 fixtures can be crossed with any of these.
 * Every refusal code below is real (`BILLING_REFUSAL_POLICY` in
 * @/lib/billing/billing-policy) and every failure reason is one `renderChargeFailed`
 * in use-charge-poller.ts actually switches on; the three refusals are chosen to
 * cover the three distinct recovery policies the outcome card can render.
 */
export const BILLING_SIM_BEHAVIORS = [
  'ok',
  'slow-settle',
  'card-declined',
  'card-expired',
  'needs-3ds',
  'charge-refused-portal',
  'charge-refused-step-up',
  'charge-retryable',
  'auto-reload-refused'
] as const

export type BillingSimBehavior = (typeof BILLING_SIM_BEHAVIORS)[number]

/** How many `pending` polls precede the terminal status, then what that status is. */
type ChargeScript =
  { kind: 'fail'; pendingPolls: number; reason: ChargeFailureReason } | { kind: 'settle'; pendingPolls: number }

interface SimBehaviorSpec {
  /** Refuse `updateAutoReload` outright. */
  autoReload?: BillingRefusal
  /** Refuse `charge` outright — settlement is never reached. */
  charge?: BillingRefusal
  /** Otherwise, the settlement timeline `chargeStatus` walks. */
  script?: ChargeScript
}

const BEHAVIOR_SPECS: Record<BillingSimBehavior, SimBehaviorSpec> = {
  'auto-reload-refused': {
    autoReload: {
      kind: 'no_payment_method',
      message: 'No payment method on file. Add one on the billing portal.'
    }
  },
  'card-declined': { script: { kind: 'fail', pendingPolls: 1, reason: 'card_declined' } },
  'card-expired': { script: { kind: 'fail', pendingPolls: 1, reason: 'payment_method_expired' } },
  // `insufficient_scope` → recovery 'step_up': the outcome card offers verification.
  'charge-refused-step-up': {
    charge: {
      kind: 'insufficient_scope',
      message: 'This terminal is not allowed to spend remotely yet.'
    }
  },
  // `no_payment_method` → recovery 'portal': the outcome card offers the portal.
  'charge-refused-portal': {
    charge: {
      kind: 'no_payment_method',
      message: 'No payment method on file. Add one on the billing portal.'
    }
  },
  // `rate_limited` → recovery 'retry' AND reuseIdempotencyKey, so the retry re-sends
  // the same key rather than minting a fresh one.
  'charge-retryable': {
    charge: {
      kind: 'rate_limited',
      message: 'Too many charge attempts. Try again shortly.',
      retryAfter: 5
    }
  },
  'needs-3ds': { script: { kind: 'fail', pendingPolls: 1, reason: 'authentication_required' } },
  ok: { script: { kind: 'settle', pendingPolls: 1 } },
  // At the real 2s poll interval this is ~8s of visible "polling".
  'slow-settle': { script: { kind: 'settle', pendingPolls: 4 } }
}

const DEFAULT_SCRIPT: ChargeScript = { kind: 'settle', pendingPolls: 1 }

// A visible-but-brief pause so the live fixture loop actually sees the "Checking…" /
// "Scheduling…" / "Undoing…" transitions rather than an instant flip.
const SIMULATED_DELAY_MS = 300

// Fixed rather than Date.now() so the fixture click-through and the tests agree.
const SIMULATED_SETTLED_AT = '2026-07-11T08:14:55.000Z'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const ok = <T>(data: T): BillingResult<T> => ({ data, ok: true })

/**
 * A fully in-memory BillingApi for DEV fixtures — no gateway. Fetches serve a mutable
 * copy of the fixture and the mutations WRITE that copy, so the fixture click-through
 * genuinely progresses: schedule sets a pending downgrade (→ the plan card's
 * "Changes to …" + Undo, and the grid's Scheduled marker on refetch), resume clears
 * any pending downgrade OR cancellation, a settled charge credits the balance, and an
 * auto-reload save round-trips. `behavior` scripts how the money-moving mutations
 * resolve — see BILLING_SIM_BEHAVIORS. Consumers reach all of this transparently via
 * `useBillingApi` (overridden by BillingApiProvider), so no code outside this file is
 * fixture-aware.
 */
export function createSimulatedBillingApi(fixture: SimulatedFixture, behavior: BillingSimBehavior = 'ok'): BillingApi {
  const spec = BEHAVIOR_SPECS[behavior]
  const script = spec.script ?? DEFAULT_SCRIPT

  // Mutable copies so charges, auto-reload saves and scheduling/undo don't leak back
  // into the shared fixture objects.
  let billing: BillingResult<BillingStateResponse> = structuredClone(fixture.billing)
  let subscription: BillingResult<SubscriptionStateResponse> = structuredClone(fixture.subscription)

  // Charges awaiting settlement, keyed by the id `charge` handed back.
  const inFlight = new Map<string, { amountUsd: string; polls: number }>()
  let seq = 0

  const patchBilling = (patch: Partial<BillingStateResponse>) => {
    if (billing.ok) {
      billing = ok({ ...billing.data, ...patch })
    }
  }

  const patchCurrent = (patch: Partial<NonNullable<SubscriptionStateResponse['current']>>) => {
    if (subscription.ok && subscription.data.current) {
      subscription = ok({ ...subscription.data, current: { ...subscription.data.current, ...patch } })
    }
  }

  /** Credit a settled top-up so the balance summary and the top-up row both move. */
  const creditBalance = (amountUsd: string) => {
    if (!billing.ok) {
      return
    }

    const added = parseAmount(amountUsd)
    const balance = parseAmount(billing.data.balance_usd)

    if (added == null || balance == null) {
      return
    }

    const next = balance + added
    const display = formatMoney(next)

    patchBilling({
      balance_display: display,
      balance_usd: formatAmountForRequest(next),
      ...(billing.data.usage
        ? {
            usage: {
              ...billing.data.usage,
              topup_remaining_display: display,
              total_spendable_display: display
            }
          }
        : {})
    })
  }

  const tierName = (tierId: string): null | string =>
    (subscription.ok ? subscription.data.tiers.find(tier => tier.tier_id === tierId)?.name : null) ?? null

  return {
    charge: async (amountUsd, idempotencyKey = `sim-key-${++seq}`) => {
      await delay(SIMULATED_DELAY_MS)

      if (spec.charge) {
        return { idempotencyKey, ok: false, refusal: { ...spec.charge } }
      }

      const chargeId = `sim-charge-${++seq}`

      inFlight.set(chargeId, { amountUsd, polls: 0 })

      return {
        data: {
          charge_id: chargeId,
          ok: true,
          portal_url: billing.ok ? billing.data.portal_url : null
        },
        idempotencyKey,
        ok: true
      }
    },
    chargeStatus: async chargeId => {
      const entry = inFlight.get(chargeId)

      if (!entry) {
        return {
          ok: false,
          refusal: { kind: 'invalid_charge_id', message: 'That charge id is not known to the simulator.' }
        }
      }

      entry.polls += 1

      if (entry.polls <= script.pendingPolls) {
        return ok<BillingChargeStatusResponse>({ amount_usd: entry.amountUsd, ok: true, status: 'pending' })
      }

      inFlight.delete(chargeId)

      if (script.kind === 'fail') {
        return ok<BillingChargeStatusResponse>({
          amount_usd: entry.amountUsd,
          ok: true,
          reason: script.reason,
          status: 'failed'
        })
      }

      creditBalance(entry.amountUsd)

      return ok<BillingChargeStatusResponse>({
        amount_usd: entry.amountUsd,
        ok: true,
        settled_at: SIMULATED_SETTLED_AT,
        status: 'settled'
      })
    },
    fetchBillingState: async () => billing,
    fetchSubscriptionState: async () => subscription,
    previewSubscriptionChange: async tierId => {
      await delay(SIMULATED_DELAY_MS)

      const preview: SubscriptionPreviewResponse = {
        effect: 'scheduled',
        effective_at: subscription.ok ? (subscription.data.current?.cycle_ends_at ?? null) : null,
        ok: true,
        target_tier_name: tierName(tierId)
      }

      return ok(preview)
    },
    resumeSubscription: async () => {
      await delay(SIMULATED_DELAY_MS)
      // Undo either scheduled change kind.
      patchCurrent({
        cancel_at_period_end: false,
        cancellation_effective_at: null,
        cancellation_effective_display: null,
        pending_downgrade_at: null,
        pending_downgrade_display: null,
        pending_downgrade_tier_name: null
      })

      return ok({ message: 'Change cancelled.', ok: true })
    },
    scheduleSubscriptionChange: async tierId => {
      await delay(SIMULATED_DELAY_MS)
      patchCurrent({
        pending_downgrade_at: subscription.ok ? (subscription.data.current?.cycle_ends_at ?? null) : null,
        pending_downgrade_display: null,
        pending_downgrade_tier_name: tierName(tierId)
      })

      return ok({ message: 'Downgrade scheduled.', ok: true })
    },
    stepUp: async () => ok({ granted: true, ok: true }),
    updateAutoReload: async input => {
      await delay(SIMULATED_DELAY_MS)

      if (spec.autoReload) {
        return { ok: false, refusal: { ...spec.autoReload } }
      }

      if (billing.ok && billing.data.auto_reload) {
        patchBilling({
          auto_reload: {
            ...billing.data.auto_reload,
            enabled: input.enabled,
            ...(input.reload_to_usd !== undefined
              ? { reload_to_display: formatMoney(input.reload_to_usd), reload_to_usd: input.reload_to_usd }
              : {}),
            ...(input.threshold_usd !== undefined
              ? { threshold_display: formatMoney(input.threshold_usd), threshold_usd: input.threshold_usd }
              : {})
          }
        })
      }

      return ok({ ok: true })
    }
  }
}
