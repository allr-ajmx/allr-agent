/**
 * MJXHRM-304 item 4 — the pill's LABEL and the surface's ACTIONS have to mean
 * the same session.
 *
 * This pill read `$currentModel` / `$currentProvider` directly. Those are the
 * PRIMARY chat's composer selection (see `selectModel`, which refuses to write
 * them for a named target for exactly that reason), so every tile and every
 * detached chat window labelled itself with the main pane's model while
 * everything else on that surface — submit, steer, the model pick — targeted its
 * own session. Desktop's pill has always followed the SessionView.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { $currentFastMode, $currentModel, $currentProvider, $currentReasoningEffort } from '@/store/model'
import { resetSessionStates, seedActiveSession } from '@/test-sessions'

import { ModelPill } from './model-pill'
import type { ChatBarState } from './types'

const modelState = (over: Partial<ChatBarState['model']> = {}): ChatBarState['model'] => ({
  canSwitch: true,
  model: '',
  provider: '',
  ...over
})

/** A tile's view: every field off its own slice, exactly like `buildTileView`. */
const tileView = (model: string, provider: string): SessionView =>
  ({
    kind: 'tile',
    $model: atom(model),
    $provider: atom(provider),
    $fast: atom(false),
    $reasoningEffort: atom('')
  }) as unknown as SessionView

afterEach(() => {
  cleanup()
  resetSessionStates()
  $currentModel.set('')
  $currentProvider.set('')
  $currentFastMode.set(false)
  $currentReasoningEffort.set('')
})

describe('ModelPill labelling', () => {
  it("labels a tile with its OWN session model, not the primary chat's globals", () => {
    $currentModel.set('primary-model')
    $currentProvider.set('primary-provider')

    render(
      <SessionViewProvider value={tileView('glm-5', 'zai')}>
        <ModelPill disabled={false} model={modelState({ model: 'glm-5', provider: 'zai' })} />
      </SessionViewProvider>
    )

    expect(screen.getByText(/Glm 5/)).toBeTruthy()
    expect(screen.queryByText(/Primary Model/)).toBeNull()
  })

  // Ordering, not just presence: the host's snapshot is what this surface was
  // RENDERED with, so it wins; the atoms are the fallback. Reversing the two
  // lets a slice that has not caught up yet override a fresh render.
  it('prefers the chat-bar snapshot over the view atoms when the two disagree', () => {
    render(
      <SessionViewProvider value={tileView('stale-model', 'zai')}>
        <ModelPill disabled={false} model={modelState({ model: 'glm-5', provider: 'zai' })} />
      </SessionViewProvider>
    )

    expect(screen.getByText(/Glm 5/)).toBeTruthy()
    expect(screen.queryByText(/Stale Model/)).toBeNull()
  })

  // The snapshot is view-scoped by ChatComposer, but it lags a beat behind a
  // `session.info` that lands mid-render — the atoms are the live answer.
  it('falls back to the live view atoms when the chat-bar snapshot is empty', () => {
    render(
      <SessionViewProvider value={tileView('glm-5', 'zai')}>
        <ModelPill disabled={false} model={modelState()} />
      </SessionViewProvider>
    )

    expect(screen.getByText(/Glm 5/)).toBeTruthy()
  })

  // Default context = PRIMARY_SESSION_VIEW. While the chat is a DRAFT there is
  // no session model, so the main composer paints the sticky pick.
  it('keeps painting the primary composer pick with no provider around it', () => {
    $currentModel.set('primary-model')

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.getByText(/Primary Model/)).toBeTruthy()
  })

  // Once the primary chat is LIVE its own slice is authoritative — that is
  // where `session.info` lands. The pill used to read the persisted globals
  // here too, naming the last pick (or a localStorage leftover) instead of the
  // model the session was running, and disagreeing with the menu's checkmark.
  it("labels a live primary chat with its session's model, not the sticky globals", () => {
    $currentModel.set('primary-model')
    seedActiveSession('runtime-1', { runtimeSessionId: 'runtime-1', model: 'glm-5', provider: 'zai' })

    render(<ModelPill disabled={false} model={modelState()} />)

    expect(screen.getByText(/Glm 5/)).toBeTruthy()
    expect(screen.queryByText(/Primary Model/)).toBeNull()
  })
})
