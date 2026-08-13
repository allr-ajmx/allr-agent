/**
 * The in-window pill is the FALLBACK presentation of the wake indicator, not a
 * companion to the native light (MJXHRM-228): two lights for one phrase reads as
 * two things having happened.
 *
 * It keeps drawing while the native window opens, deliberately — a beat of both
 * is cosmetic, a beat of neither is the acknowledgement not arriving, which is
 * the entire point of the indicator.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/wake-indicator/native-indicator', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $nativeWakeIndicator: atom(false),
    installNativeWakeIndicator: () => () => undefined
  }
})

import { $nativeWakeIndicator } from '@/app/wake-indicator/native-indicator'
import { $wakeIndicator } from '@/store/wake-indicator'

import { WakeIndicatorOverlay } from './wake-indicator-overlay'

beforeEach(() => {
  $wakeIndicator.set('hidden')
  $nativeWakeIndicator.set(false)
})

describe('the in-window wake pill', () => {
  it('draws nothing until the phrase fires', () => {
    render(<WakeIndicatorOverlay />)

    expect(screen.queryByTestId('wake-indicator')).not.toBeInTheDocument()
  })

  it('draws the state the machine published', () => {
    $wakeIndicator.set('capturing')

    render(<WakeIndicatorOverlay />)

    expect(screen.getByTestId('wake-indicator')).toHaveAttribute('data-state', 'capturing')
  })

  it('stands down once the native light is on screen', () => {
    $wakeIndicator.set('detected')
    $nativeWakeIndicator.set(true)

    render(<WakeIndicatorOverlay />)

    expect(screen.queryByTestId('wake-indicator')).not.toBeInTheDocument()
  })
})
