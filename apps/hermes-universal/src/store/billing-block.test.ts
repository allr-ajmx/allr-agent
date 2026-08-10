import { beforeEach, expect, test, vi } from 'vitest'

import type { BillingBlock } from '@/lib/billing/billing-types'

vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('@/store/windows', () => ({ openSettingsScreen: vi.fn(async () => {}) }))

import { openExternalLink } from '@/lib/external-link'
import { openSettingsScreen } from '@/store/windows'

import {
  $billingBlock,
  BILLING_SETTINGS_ROUTE,
  billingCtaLabel,
  clearBillingBlock,
  requestBillingSettings,
  runBillingRecovery,
  setBillingBlock,
  surfaceBillingBlock
} from './billing-block'
import { $notifications, clearNotifications } from './notifications'

// Ported from apps/desktop/src/store/billing-block.test.ts. Desktop's
// `$billingSettingsRequest` counter has no universal counterpart — universal can
// navigate from module scope — so those assertions become "did we open
// /settings/billing?".

function makeBlock(overrides: Partial<BillingBlock> = {}): BillingBlock {
  return {
    billing_url: 'https://platform.openai.com/settings/organization/billing',
    is_nous: false,
    message: 'You are out of credits.',
    model: 'gpt-5',
    provider: 'openai',
    provider_label: 'OpenAI',
    ...overrides
  }
}

/** requestBillingSettings routes through a dynamic import, so the mocked module
 *  is only reached on a later microtask. */
const settleNavigation = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  $billingBlock.set(null)
  clearNotifications()
  vi.clearAllMocks()
})

test('setBillingBlock stores the block against its session', () => {
  setBillingBlock('s1', makeBlock())
  expect($billingBlock.get()?.sessionId).toBe('s1')
  expect($billingBlock.get()?.block.provider).toBe('openai')
})

test('clearBillingBlock scoped to a session leaves a different session block intact', () => {
  setBillingBlock('s1', makeBlock())
  clearBillingBlock('s2')
  expect($billingBlock.get()).not.toBeNull()

  clearBillingBlock('s1')
  expect($billingBlock.get()).toBeNull()
})

test('clearBillingBlock with no arg clears any active block', () => {
  setBillingBlock('s1', makeBlock())
  clearBillingBlock()
  expect($billingBlock.get()).toBeNull()
})

test('runBillingRecovery routes Nous to in-app Settings, never an external link', async () => {
  runBillingRecovery(makeBlock({ is_nous: true, provider: 'nous', provider_label: 'Nous Portal' }))
  await settleNavigation()
  expect(openSettingsScreen).toHaveBeenCalledWith(BILLING_SETTINGS_ROUTE)
  expect(openExternalLink).not.toHaveBeenCalled()
})

test('runBillingRecovery deep-links a third-party provider to its billing page', async () => {
  const block = makeBlock({ billing_url: 'https://openrouter.ai/settings/credits', provider: 'openrouter' })
  runBillingRecovery(block)
  await settleNavigation()
  expect(openExternalLink).toHaveBeenCalledWith('https://openrouter.ai/settings/credits')
  expect(openSettingsScreen).not.toHaveBeenCalled()
})

test('runBillingRecovery falls back to in-app settings when a provider has no URL', async () => {
  runBillingRecovery(makeBlock({ billing_url: null, provider: 'custom' }))
  await settleNavigation()
  expect(openExternalLink).not.toHaveBeenCalled()
  expect(openSettingsScreen).toHaveBeenCalledWith(BILLING_SETTINGS_ROUTE)
})

test('requestBillingSettings opens the billing drill-in', async () => {
  requestBillingSettings()
  await settleNavigation()
  expect(openSettingsScreen).toHaveBeenCalledWith('/settings/billing')
})

test('billingCtaLabel picks the right verb per route', () => {
  const copy = { addCredits: 'Add credits', openBilling: 'Open billing' }
  expect(billingCtaLabel(makeBlock({ is_nous: true }), copy)).toBe('Open billing')
  expect(billingCtaLabel(makeBlock({ is_nous: false }), copy)).toBe('Add credits')
})

// ── surfaceBillingBlock: the wire → (cache + toast) seam ─────────────────────

test('surfaceBillingBlock ignores a payload that is not a usable block', () => {
  surfaceBillingBlock('s1', undefined)
  surfaceBillingBlock('s1', 'out of credits')
  surfaceBillingBlock('s1', { message: 'no provider field' })

  expect($billingBlock.get()).toBeNull()
  expect($notifications.get()).toHaveLength(0)
})

test('surfaceBillingBlock caches the block and raises one sticky billing toast', () => {
  surfaceBillingBlock('s1', makeBlock({ message: 'Out of credits.\nsecond line' }))

  expect($billingBlock.get()?.sessionId).toBe('s1')

  const toasts = $notifications.get()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.id).toBe('billing-block:openai')
  expect(toasts[0]?.kind).toBe('warning')
  // Only the first line of the block message reaches the toast.
  expect(toasts[0]?.message).toBe('Out of credits.')
  expect(toasts[0]?.action?.label).toBe('Add credits')
})

test('a repeat wall from the same provider collapses into the one toast', () => {
  surfaceBillingBlock('s1', makeBlock())
  surfaceBillingBlock('s1', makeBlock())
  surfaceBillingBlock('s2', makeBlock({ provider: 'nous', provider_label: 'Nous Portal', is_nous: true }))

  const ids = $notifications.get().map(item => item.id)
  expect(ids.filter(id => id === 'billing-block:openai')).toHaveLength(1)
  expect(ids).toContain('billing-block:nous')
})

test('a block with an empty message falls back to the localized copy', () => {
  surfaceBillingBlock('s1', makeBlock({ message: '' }))
  expect($notifications.get()[0]?.message).toBe('Your account is out of credits. Add credits to keep going.')
})
