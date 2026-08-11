import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as WindowsStore from '@/store/windows'

type Windows = typeof WindowsStore

// The activity screen's job here is purely which surfaces it MOUNTS: Settings ▸
// Providers renders provider rows whose only effect is setting store state, and
// nothing happens unless the matching surface is mounted in this window too.
// Stub the leaves so the test is about the wiring, not their internals.
vi.mock('@/app/shell/mobile-surface-shell', () => ({ MobileSurfaceShell: () => <div>settings surface</div> }))
vi.mock('@/app/onboarding/onboarding-screen', () => ({ OnboardingScreen: () => <div>onboarding wizard</div> }))
vi.mock('@/app/settings/provider-connect-overlay', () => ({
  ProviderConnectOverlay: () => <div>provider connect overlay</div>
}))
vi.mock('@/components/notifications', () => ({ NotificationStack: () => null }))
// Partial: `@/store/windows` is also imported transitively for persisted-state
// ownership, so only `returnHome` (a real native-window call) is replaced.
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<Windows>()),
  returnHome: vi.fn(async () => {})
}))

import { $onboardingActive } from '@/store/onboarding'

import { ActivityScreenRoot } from './activity-screen'

afterEach(() => $onboardingActive.set(false))

describe('ActivityScreenRoot', () => {
  it('mounts the provider-connect overlay over the settings surface', () => {
    render(<ActivityScreenRoot />)

    expect(screen.getByText('settings surface')).toBeInTheDocument()
    expect(screen.getByText('provider connect overlay')).toBeInTheDocument()
  })

  it('takes the whole screen over when the onboarding wizard is opened from Settings ▸ Model', () => {
    $onboardingActive.set(true)
    render(<ActivityScreenRoot />)

    expect(screen.getByText('onboarding wizard')).toBeInTheDocument()
    expect(screen.queryByText('settings surface')).not.toBeInTheDocument()
  })
})
