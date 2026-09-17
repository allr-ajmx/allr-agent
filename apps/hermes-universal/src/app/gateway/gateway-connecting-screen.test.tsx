import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $allrWorkResume } from '@/store/allr-work-state'
import { $connectionError, $connectionPhase } from '@/store/connection'
import { $restoring, saveGatewayTarget } from '@/store/gateway-restore'
import { $gatewayMode } from '@/store/gateway-switch'

import { GatewayConnectingScreen } from './gateway-connecting-screen'

const renderScreen = () =>
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConnectingScreen />
      </QueryClientProvider>
    </I18nProvider>
  )

afterEach(() => {
  $connectionError.set(null)
  localStorage.clear()
})

describe('GatewayConnectingScreen recovery', () => {
  it('offers the escape hatch without showing the configurator while dialling', () => {
    renderScreen()
    expect(screen.getByRole('button', { name: 'Use a different gateway' })).toBeInTheDocument()
    expect(screen.queryByText('Connection mode')).not.toBeInTheDocument()
  })

  // A failed dial is where re-homing matters: the connect surface comes to the user
  // instead of dropping them back to the picker.
  it('reveals the embedded configurator once the dial errors', () => {
    $connectionError.set('connection refused')
    renderScreen()
    expect(screen.getByText('connection refused')).toBeInTheDocument()
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
    // Giving up entirely stays reachable.
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument()
  })
})

describe('GatewayConnectingScreen — Allr Work (ALLR-51)', () => {
  afterEach(() => {
    $allrWorkResume.set(null)
    $connectionPhase.set('idle')
    $restoring.set(false)
    $gatewayMode.set('remote')
  })

  it('allr target shows workspace host', () => {
    saveGatewayTarget({ mode: 'allr', url: 'https://xm.allr.work' })
    renderScreen()

    expect(screen.getByText('Reconnecting to your Allr Work workspace at xm.allr.work…')).toBeInTheDocument()
    expect(screen.queryByText(/the remote gateway/)).not.toBeInTheDocument()
  })

  // A mobile boot: the gateway saved BEFORE the sign-in is still the saved target.
  function mobileBoot({ marker = false }: { marker?: boolean } = {}) {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    if (marker) {
      localStorage.setItem('hermes.allr.pending', '1')
    }

    $restoring.set(true)
  }

  it('says it is finishing the sign-in before the boot restore has taken the marker', () => {
    mobileBoot({ marker: true })
    renderScreen()

    expect(screen.getByText('Finishing your Allr Work sign-in…')).toBeInTheDocument()
    expect(screen.queryByText(/gw\.example\.com/)).not.toBeInTheDocument()
  })

  it.each([{ phase: 'pending' as const }, { phase: 'dialing' as const, workspace: 'https://xm.allr.work' }])(
    'says it is finishing the sign-in while the resume is $phase',
    resume => {
      mobileBoot()
      $gatewayMode.set('allr')
      $allrWorkResume.set(resume)
      renderScreen()

      expect(screen.getByText('Finishing your Allr Work sign-in…')).toBeInTheDocument()
      expect(screen.queryByText(/gw\.example\.com/)).not.toBeInTheDocument()
    }
  )

  it('names the previous gateway once a backed-out resume re-dials it', () => {
    mobileBoot()
    renderScreen()

    expect(screen.getByText('Reconnecting to gw.example.com…')).toBeInTheDocument()
    expect(screen.queryByText('Finishing your Allr Work sign-in…')).not.toBeInTheDocument()
  })

  // The previous gateway is itself an Allr Work workspace: re-dialling it is an ordinary
  // reconnect, not the sign-in finishing — even though the mode is 'allr' either way.
  it('uses the ordinary Allr Work wording when a backed-out resume re-dials a previous workspace', () => {
    saveGatewayTarget({ mode: 'allr', url: 'https://old.allr.work' })
    $restoring.set(true)
    $gatewayMode.set('allr')
    renderScreen()

    expect(screen.getByText('Reconnecting to your Allr Work workspace at old.allr.work…')).toBeInTheDocument()
    expect(screen.queryByText('Finishing your Allr Work sign-in…')).not.toBeInTheDocument()
  })

  it('names the workspace a failed resume signed in to, not the saved gateway', () => {
    mobileBoot()
    $restoring.set(false)
    $gatewayMode.set('allr')
    $allrWorkResume.set({ phase: 'failed', workspace: 'https://xm.allr.work' })
    $connectionPhase.set('error')
    renderScreen()

    expect(screen.getByText('Stopped trying to reach your Allr Work workspace at xm.allr.work.')).toBeInTheDocument()
    expect(screen.queryByText(/gw\.example\.com/)).not.toBeInTheDocument()
  })

  it('names the saved gateway when the user has since moved off Allr Work', () => {
    mobileBoot()
    $restoring.set(false)
    $allrWorkResume.set({ phase: 'failed', workspace: 'https://xm.allr.work' })
    $connectionPhase.set('error')
    renderScreen()

    expect(screen.getByText('Stopped trying to reach gw.example.com.')).toBeInTheDocument()
  })
})
