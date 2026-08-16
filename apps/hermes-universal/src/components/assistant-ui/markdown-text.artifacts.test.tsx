/**
 * The artifact path, end to end through the real markdown pipeline.
 *
 * Adapted from apps/desktop/src/components/assistant-ui/markdown-text.artifacts.test.tsx.
 * A substantial ```html fence in assistant markdown has to come out of
 * preprocessMarkdown → streamdown → our SyntaxHighlighter slot as an artifact
 * card that is registered in the store, while a small fence keeps the plain
 * code-card path.
 *
 * Two adaptations, both because universal's seams differ from desktop's:
 *  - the session id comes from `useSessionView()` (`$activeSessionKey` /
 *    `$activeStoredSessionId`), not desktop's `$activeSessionId`;
 *  - universal's registry is memory-only, so there is no localStorage to clear.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { artifactsForSession, clearArtifactRegistry } from '@/store/artifacts'
import { $previewTabs } from '@/store/preview'
import { $activeStoredSessionId } from '@/store/session'
import { $activeSessionKey } from '@/store/session-state-types'

import { MarkdownTextContent } from './markdown-text'

const HTML_DOC = `<!doctype html>
<html>
<head><title>Pomodoro Timer</title></head>
<body>
<h1>Pomodoro</h1>
<p>A tiny focus timer that counts down twenty-five minutes.</p>
<script>let seconds = 25 * 60; setInterval(() => { seconds -= 1 }, 1000)</script>
</body>
</html>`

const SMALL_SNIPPET = 'const x = 1'

function fenced(language: string, body: string): string {
  return `Here you go:\n\n\`\`\`${language}\n${body}\n\`\`\`\n`
}

beforeEach(() => {
  $activeSessionKey.set('session-artifacts')
  $activeStoredSessionId.set(null)
  $previewTabs.set([])
  clearArtifactRegistry()
})

afterEach(() => {
  cleanup()
  $activeSessionKey.set('')
  $activeStoredSessionId.set(null)
  $previewTabs.set([])
  clearArtifactRegistry()
})

describe('MarkdownTextContent artifacts', () => {
  it('renders a substantial html fence as an artifact card and registers it', async () => {
    render(<MarkdownTextContent isRunning={false} text={fenced('html', HTML_DOC)} />)

    const card = await screen.findByText('Pomodoro Timer')

    expect(card.closest('button')?.dataset.slot).toBe('aui_artifact-card')
    await waitFor(() => expect(artifactsForSession('session-artifacts')).toHaveLength(1))
    expect(artifactsForSession('session-artifacts')[0]?.kind).toBe('html')
    // Registration alone must not open the pane (offer, don't hijack).
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('keeps a small fence as a plain code block', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text={fenced('js', SMALL_SNIPPET)} />)

    // Shiki may split tokens into spans, so assert on the card slots rather
    // than on text content.
    await waitFor(() => expect(container.querySelector('[data-slot="code-card"]')).not.toBeNull())
    expect(container.querySelector('[data-slot="aui_artifact-card"]')).toBeNull()
    expect(artifactsForSession('session-artifacts')).toHaveLength(0)
  })

  it('does not register while the message is still streaming', async () => {
    render(<MarkdownTextContent isRunning text={fenced('html', HTML_DOC)} />)

    await screen.findByText('Pomodoro Timer')

    expect(artifactsForSession('session-artifacts')).toHaveLength(0)
  })
})
