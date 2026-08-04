import { describe, expect, it, vi } from 'vitest'

// See use-billing-state.test.ts: reaching the real @/store/gateway from a test
// enters its import cycle with @/store/connection before $gatewayState exists.
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { refusalPolicy } from '@/lib/billing/billing-policy'
import type { BillingChargeStatusResponse } from '@/lib/billing/billing-types'

import type { BillingApi } from './api'
import { billingDevFixtures } from './dev-fixtures'
import { createSimulatedBillingApi } from './simulated-api'
import { deriveBillingView } from './use-billing-state'

const FREE_TIER_ID = 'cltier000free0000personal'

describe('createSimulatedBillingApi', () => {
  it('progresses the pending state through the whole loop: schedule sets it, resume clears it', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures['subscriber-personal'])
    const billing = await api.fetchBillingState()

    // Baseline: subscriber on Plus, nothing pending.
    const before = deriveBillingView(billing, await api.fetchSubscriptionState())
    expect(before.plan?.pending).toBeUndefined()

    // Schedule a downgrade to Free → the very next fetch shows the pending card + marker.
    expect((await api.scheduleSubscriptionChange(FREE_TIER_ID)).ok).toBe(true)
    const afterSchedule = deriveBillingView(billing, await api.fetchSubscriptionState())
    expect(afterSchedule.plan?.pending).toMatchObject({ kind: 'downgrade', tierName: 'Free' })
    expect(afterSchedule.tiers.find(tier => tier.name === 'Free')?.state).toBe('scheduled')

    // Undo → pending cleared on the next fetch.
    expect((await api.resumeSubscription()).ok).toBe(true)
    const afterResume = deriveBillingView(billing, await api.fetchSubscriptionState())
    expect(afterResume.plan?.pending).toBeUndefined()
    expect(afterResume.tiers.some(tier => tier.state === 'scheduled')).toBe(false)
  })

  it('previews a chargeless scheduled change for the chosen tier', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures['subscriber-personal'])
    const preview = await api.previewSubscriptionChange(FREE_TIER_ID)

    expect(preview).toMatchObject({ data: { effect: 'scheduled', target_tier_name: 'Free' }, ok: true })
  })

  it('undoes a scheduled cancellation too', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures['pending-cancellation'])
    const billing = await api.fetchBillingState()

    expect(deriveBillingView(billing, await api.fetchSubscriptionState()).plan?.pending).toMatchObject({
      kind: 'cancellation'
    })

    await api.resumeSubscription()
    expect(deriveBillingView(billing, await api.fetchSubscriptionState()).plan?.pending).toBeUndefined()
  })

  it('does not mutate the shared fixture object', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures['subscriber-personal'])
    await api.scheduleSubscriptionChange(FREE_TIER_ID)

    const fixture = billingDevFixtures['subscriber-personal']
    expect(deriveBillingView(fixture.billing, fixture.subscription).plan?.pending).toBeUndefined()
  })
})

/** Drive one charge to its terminal status, returning every status seen on the way. */
async function runCharge(api: BillingApi, amountUsd: string): Promise<BillingChargeStatusResponse[]> {
  const charge = await api.charge(amountUsd)

  if (!charge.ok) {
    throw new Error(`charge refused: ${charge.refusal.kind}`)
  }

  const chargeId = charge.data.charge_id
  const seen: BillingChargeStatusResponse[] = []

  // Bounded so a mis-scripted behavior fails the test rather than hanging it.
  for (let poll = 0; poll < 10; poll += 1) {
    const status = await api.chargeStatus(chargeId as string)

    if (!status.ok) {
      throw new Error(`chargeStatus refused: ${status.refusal.kind}`)
    }

    seen.push(status.data)

    if (status.data.status !== 'pending') {
      return seen
    }
  }

  throw new Error('charge never reached a terminal status')
}

describe('createSimulatedBillingApi charge scripting', () => {
  it('settles after one pending poll by default, and credits the balance', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy)
    const before = await api.fetchBillingState()

    expect(before.ok && before.data.balance_usd).toBe('142.50')

    const seen = await runCharge(api, '100')

    expect(seen.map(status => status.status)).toEqual(['pending', 'settled'])

    // The settled amount lands on the balance, so a top-up visibly moves the number.
    const after = await api.fetchBillingState()

    // `balance_usd` is the wire format, so formatAmountForRequest drops the trailing
    // zero; the rendered fields keep the two decimals.
    expect(after.ok && after.data.balance_usd).toBe('242.5')
    expect(after.ok && after.data.balance_display).toBe('$242.50')
    expect(after.ok && after.data.usage?.total_spendable_display).toBe('$242.50')
  })

  it('holds slow-settle in pending long enough for the polling phase to be visible', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy, 'slow-settle')
    const seen = await runCharge(api, '100')

    expect(seen.map(status => status.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'settled'])
  })

  it.each([
    ['card-declined', 'card_declined'],
    ['card-expired', 'payment_method_expired'],
    ['needs-3ds', 'authentication_required']
  ] as const)('fails %s with reason %s and leaves the balance alone', async (behavior, reason) => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy, behavior)
    const seen = await runCharge(api, '100')
    const terminal = seen.at(-1)

    expect(terminal).toMatchObject({ reason, status: 'failed' })

    const after = await api.fetchBillingState()

    expect(after.ok && after.data.balance_usd).toBe('142.50')
  })

  // Each refusal is chosen for the recovery its policy drives, which is what the
  // outcome card branches on — so assert the policy, not just the code.
  it.each([
    ['charge-refused-portal', 'no_payment_method', 'portal'],
    ['charge-refused-step-up', 'insufficient_scope', 'step_up'],
    ['charge-retryable', 'rate_limited', 'retry']
  ] as const)('refuses the charge outright under %s', async (behavior, kind, recovery) => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy, behavior)
    const charge = await api.charge('100')

    expect(charge.ok).toBe(false)
    expect(!charge.ok && charge.refusal.kind).toBe(kind)
    expect(refusalPolicy(kind).recovery).toBe(recovery)
    // The key must come back so useChargeFlow can re-send it on a retry.
    expect(charge.idempotencyKey).toBeTruthy()
  })

  it('reuses a caller-supplied idempotency key rather than minting a fresh one', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy)
    const charge = await api.charge('100', 'retry-of-an-earlier-attempt')

    expect(charge.idempotencyKey).toBe('retry-of-an-earlier-attempt')
  })
})

describe('createSimulatedBillingApi auto-reload', () => {
  it('round-trips a save, so the row reflects the new values on refetch', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy)

    expect((await api.updateAutoReload({ enabled: true, reload_to_usd: '75', threshold_usd: '25' })).ok).toBe(true)

    const after = await api.fetchBillingState()

    expect(after.ok && after.data.auto_reload).toMatchObject({
      enabled: true,
      reload_to_display: '$75',
      reload_to_usd: '75',
      threshold_display: '$25',
      threshold_usd: '25'
    })
  })

  it('refuses the save under auto-reload-refused, leaving the stored values untouched', async () => {
    const api = createSimulatedBillingApi(billingDevFixtures.healthy, 'auto-reload-refused')
    const before = await api.fetchBillingState()
    const original = before.ok ? before.data.auto_reload : null
    const result = await api.updateAutoReload({ enabled: false, reload_to_usd: '75', threshold_usd: '25' })

    expect(result.ok).toBe(false)
    expect(!result.ok && refusalPolicy(result.refusal.kind).recovery).toBe('portal')

    const after = await api.fetchBillingState()

    expect(after.ok && after.data.auto_reload).toEqual(original)
  })
})
