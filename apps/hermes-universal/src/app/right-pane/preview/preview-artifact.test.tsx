/**
 * The artifact tab in the right pane.
 *
 * Adapted from apps/desktop/src/app/chat/right-rail/preview-artifact.test.tsx.
 * Six of desktop's seven cases carry over; what changes is the HTML leg.
 *
 * Desktop writes the document into a `srcdoc`. Universal deliberately does not
 * (MJXHRM-56): a srcdoc frame is same-origin with the app document and inherits
 * the app's CSP, so the artifact's own inline scripts would only run if the
 * app's `script-src` were widened for them. Universal stages the document with
 * Rust and loads it over `hermes-artifact://` instead, which needs a Tauri
 * runtime — so `IS_TAURI` and `invoke` are the two seams mocked here, and the
 * srcdoc assertions become src + staging assertions.
 *
 * jsdom-only, and deliberately so: this pins the sandbox attribute set and the
 * URL handed to the frame. Whether WebKitGTK ENFORCES that sandbox and the
 * response CSP behind it is a real-engine question and stays on MJXHRM-56's
 * runtime checklist.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_MOBILE: false,
  IS_TAURI: true
}))

const invoke = vi.fn(async () => undefined)

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }))

// Shiki compiles a grammar per language; the source pane's highlighting is not
// what this suite is about, and the plain <pre> keeps the content assertable.
vi.mock('@/components/chat/shiki-highlighter', () => ({
  SyntaxHighlighter: ({ code }: { code: string }) => <pre data-slot="artifact-source">{code}</pre>
}))

const { $artifactRegistry, $artifactVersionSelection, upsertArtifact } = await import('@/store/artifacts')
const { ARTIFACT_TAB_PREFIX } = await import('@/store/preview')
const { ArtifactPreview } = await import('./preview-artifact')

function register(title: string, kind: 'code' | 'html' | 'svg', content: string) {
  const result = upsertArtifact('session-1', { kind, language: kind === 'code' ? 'python' : kind, title }, content)

  if (!result) {
    throw new Error('artifact did not register')
  }

  return result
}

async function renderArtifact(artifactId: string) {
  await act(async () => {
    render(<ArtifactPreview target={{ name: 'Artifact', path: `${ARTIFACT_TAB_PREFIX}${artifactId}` }} />)
  })
}

// By tag, not by title alone: the header shows the artifact's name in a
// `title` attribute too, so `getByTitle` matches two nodes.
const frame = (title: string) => document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`)!

beforeEach(() => {
  invoke.mockClear()
  $artifactRegistry.set({})
  $artifactVersionSelection.set({})
})

afterEach(() => {
  cleanup()
  $artifactRegistry.set({})
  $artifactVersionSelection.set({})
})

describe('ArtifactPreview', () => {
  it('renders html in a scripts-only sandboxed frame the parent app is unreachable from', async () => {
    const { artifactId } = register('Dashboard', 'html', '<h1>Hi</h1>')
    await renderArtifact(artifactId)

    expect(frame('Dashboard').getAttribute('sandbox')).toBe('allow-scripts')
    // No allow-same-origin: granted alongside allow-scripts, the frame could
    // reach its own document and strip the sandbox attribute outright.
    expect(frame('Dashboard').getAttribute('sandbox')).not.toContain('same-origin')
    // The document reaches the frame by REFERENCE, over its own scheme — never
    // as a srcdoc, which would inherit the app's origin and its CSP with it.
    expect(frame('Dashboard').getAttribute('srcdoc')).toBeNull()
    expect(frame('Dashboard').getAttribute('src')).toMatch(/^hermes-artifact:\/\/localhost\//)
    expect(invoke).toHaveBeenCalledWith(
      'artifact_stage',
      expect.objectContaining({ html: expect.stringContaining('<h1>Hi</h1>') })
    )
  })

  it('strips scripts out of svg before it renders inline', async () => {
    const { artifactId } = register(
      'Logo',
      'svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )

    await renderArtifact(artifactId)

    expect(document.querySelector('svg')).not.toBeNull()
    expect(document.querySelector('svg script')).toBeNull()
  })

  it('offers only the source view for code, which has nothing to render', async () => {
    const { artifactId } = register('Solver', 'code', 'print("hi")')
    await renderArtifact(artifactId)

    // Universal labels the live mode PREVIEW, not RENDERED.
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
    expect(document.querySelector('[data-slot="artifact-source"]')?.textContent).toBe('print("hi")')
  })

  it('shows the version stepper once an artifact has history, and follows the selection', async () => {
    register('Dashboard', 'html', '<h1>v1</h1>')
    const { artifactId } = register('Dashboard', 'html', '<h1>v2</h1>')
    await renderArtifact(artifactId)

    expect(screen.getByText('v2 of 2')).toBeTruthy()
    expect(invoke).toHaveBeenLastCalledWith(
      'artifact_stage',
      expect.objectContaining({ html: expect.stringContaining('v2') })
    )

    await act(async () => {
      $artifactVersionSelection.set({ [artifactId]: 0 })
    })

    expect(screen.getByText('v1 of 2')).toBeTruthy()
    expect(invoke).toHaveBeenLastCalledWith(
      'artifact_stage',
      expect.objectContaining({ html: expect.stringContaining('v1') })
    )
  })

  it('hides the stepper for a single-version artifact', async () => {
    const { artifactId } = register('Dashboard', 'html', '<h1>only</h1>')
    await renderArtifact(artifactId)

    expect(screen.queryByText('v1 of 1')).toBeNull()
  })

  it('picks up a new version in an already-open tab', async () => {
    const { artifactId } = register('Dashboard', 'html', '<h1>v1</h1>')
    await renderArtifact(artifactId)

    await act(async () => {
      register('Dashboard', 'html', '<h1>v2</h1>')
    })

    expect(screen.getByText('v2 of 2')).toBeTruthy()
    expect(invoke).toHaveBeenLastCalledWith(
      'artifact_stage',
      expect.objectContaining({ html: expect.stringContaining('v2') })
    )
  })

  it('falls back to an empty state when the registry no longer has the artifact', async () => {
    const { artifactId } = register('Dashboard', 'html', '<h1>gone</h1>')

    $artifactRegistry.set({})

    await renderArtifact(artifactId)

    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByText('Artifact unavailable')).toBeTruthy()
  })
})
