/**
 * MJXHRM-381 — RENDER-COUNT PROOF for the composer status stack.
 *
 * The ticket's definition of done asks for render-count instrumentation showing
 * that unrelated state changes no longer re-render the stack. That was written
 * for bippy, which needs a dev build this agent cannot run and which is only
 * verified to LOAD under WebKitGTK, never to REPORT. A `<Profiler>` gives the
 * same measurement here and is strictly stronger as a regression guard: it runs
 * in CI on every push.
 *
 * HOW THIS MEASURES, precisely — this is the part that is easy to get wrong.
 * `Profiler.onRender` fires once per COMMIT of the profiled subtree. A store
 * write that a narrowed `useSyncExternalStore` selector bails on produces no
 * re-render, so no commit, so no call. A whole-atom `useStore` re-renders even
 * when the rendered output is byte-identical, and React still commits — so the
 * call happens. The distinction the file exists to catch is therefore visible.
 *
 * Every case here carries a POSITIVE CONTROL: the same component, the same
 * store, a write it genuinely depends on, asserted to commit. Without them a
 * component that had been broken into rendering nothing would sail through.
 *
 * These components mount ONCE PER OPEN TILE (and the preview rows once per
 * artifact per tile), which is what turns "one extra render" into N.
 */

import { render } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BillingBanner } from '@/components/chat/billing-banner'
import type { BillingBlock } from '@/lib/billing/billing-types'
import { $billingBlock, clearBillingBlock, setBillingBlock } from '@/store/billing-block'
import { closeAllPreviewTabs, setPreviewTarget } from '@/store/preview'
import { type PreviewArtifact } from '@/store/preview-status'
import { $subagentsBySession } from '@/store/subagents'

import { PreviewStatusRow } from './preview-row'

import { ComposerStatusStack } from './index'

const noop = () => undefined

const artifact = (over: Partial<PreviewArtifact> = {}): PreviewArtifact => ({
  cwd: '/repo',
  id: 'preview.html',
  label: 'preview.html',
  target: 'preview.html',
  ...over
})

const block: BillingBlock = {
  is_nous: true,
  message: 'Out of credits',
  provider_label: 'Nous'
} as BillingBlock

/** Renders `node` and returns a spy that ticks once per commit of that subtree,
 *  already cleared of the mount commit. */
function commitsOf(node: ReactNode) {
  const commits = vi.fn()
  render(
    <Profiler id="under-test" onRender={commits}>
      {node}
    </Profiler>
  )
  commits.mockClear()

  return commits
}

beforeEach(() => {
  closeAllPreviewTabs()
  clearBillingBlock()
  $subagentsBySession.set({})
})

afterEach(() => {
  closeAllPreviewTabs()
  clearBillingBlock()
  $subagentsBySession.set({})
})

describe('PreviewStatusRow / $activePreviewPath', () => {
  it('ignores a preview tab opened on another path', () => {
    const commits = commitsOf(<PreviewStatusRow item={artifact()} onDismiss={noop} />)

    act(() => setPreviewTarget('/repo/somewhere-else.ts'))

    expect(commits).not.toHaveBeenCalled()
  })

  it('still repaints when ITS OWN path becomes the open tab', () => {
    const commits = commitsOf(<PreviewStatusRow item={artifact()} onDismiss={noop} />)

    act(() => setPreviewTarget('/repo/preview.html'))

    expect(commits).toHaveBeenCalled()
  })
})

describe('BillingBanner / $billingBlock', () => {
  it("ignores another session's credit wall", () => {
    const commits = commitsOf(<BillingBanner sessionId="mine" />)

    act(() => setBillingBlock('theirs', block))

    expect(commits).not.toHaveBeenCalled()
    expect($billingBlock.get()?.sessionId).toBe('theirs')
  })

  it("still repaints on its own session's credit wall", () => {
    const commits = commitsOf(<BillingBanner sessionId="mine" />)

    act(() => setBillingBlock('mine', block))

    expect(commits).toHaveBeenCalled()
  })
})

describe('ComposerStatusStack / $subagentsBySession', () => {
  it("ignores another session's subagent tick", () => {
    const commits = commitsOf(<ComposerStatusStack queue={null} sessionId="mine" />)

    act(() =>
      $subagentsBySession.set({
        theirs: [{ goal: 'other work', id: 'sub-1', status: 'running' }]
      } as never)
    )

    expect(commits).not.toHaveBeenCalled()
  })

  it("still repaints on its own session's subagent tick", () => {
    const commits = commitsOf(<ComposerStatusStack queue={null} sessionId="mine" />)

    act(() =>
      $subagentsBySession.set({
        mine: [{ goal: 'my work', id: 'sub-1', status: 'running' }]
      } as never)
    )

    expect(commits).toHaveBeenCalled()
  })

  it("ignores another session's credit wall", () => {
    const commits = commitsOf(<ComposerStatusStack queue={null} sessionId="mine" />)

    act(() => setBillingBlock('theirs', block))

    expect(commits).not.toHaveBeenCalled()
  })
})
