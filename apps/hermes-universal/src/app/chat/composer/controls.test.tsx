/**
 * MJXHRM-357 — the primary button has to say what pressing it will do.
 *
 * A COMPACTING turn occupies the composer without setting `busy`: a manual
 * `/compress` summarizes an idle session, and `useComposerSubmit` queues
 * anything typed into that window (its `turnOccupied`). These branches read
 * `busy` alone, so the button offered "Send" for an action that queues — the one
 * affordance that could have told the user a compaction was under way said the
 * opposite.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ComposerControls } from './controls'

const CONVERSATION = {
  active: false,
  level: 0,
  muted: false,
  status: 'idle' as const,
  onEnd: () => {},
  onStart: () => {},
  onStopTurn: () => {},
  onToggleMute: () => {}
}

const STATE = {
  model: 'test-model',
  voice: { recording: false, transcribing: false }
} as unknown as Parameters<typeof ComposerControls>[0]['state']

const renderControls = (props: Partial<Parameters<typeof ComposerControls>[0]>) =>
  render(
    <ComposerControls
      autoSpeak={false}
      busy={false}
      busyAction="stop"
      busyActionActive={false}
      canSubmit
      conversation={CONVERSATION}
      disabled={false}
      hasComposerPayload
      onDictate={() => {}}
      onQueue={() => {}}
      onToggleAutoSpeak={() => {}}
      state={STATE}
      voiceStatus={{ level: 0, recording: false } as unknown as Parameters<typeof ComposerControls>[0]['voiceStatus']}
      {...props}
    />
  )

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the primary composer button', () => {
  it('offers Send on an idle session', () => {
    renderControls({})

    expect(screen.getByLabelText('Send')).toBeTruthy()
  })

  // busy=false, occupied=true — the compaction window.
  it('offers Queue while a compaction occupies the turn', () => {
    renderControls({ busyAction: 'queue', busyActionActive: true })

    expect(screen.queryByLabelText('Send')).toBeNull()
    expect(screen.getByLabelText('Queue message')).toBeTruthy()
  })

  it('still offers Steer on an ordinary running turn', () => {
    renderControls({ busy: true, busyAction: 'steer', busyActionActive: true })

    expect(screen.getByLabelText('Steer the current run')).toBeTruthy()
  })
})
