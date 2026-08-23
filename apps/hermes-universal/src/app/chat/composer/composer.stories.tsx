import type { Meta, StoryObj } from '@storybook/react-vite'

import { $chatBubbles } from '@/store/chat-bubbles'
import { type ComposerAttachment, stashSessionDraft } from '@/store/composer'

import { withDesktop, withHud, withMobile } from '../../../../.storybook/decorators'

import type { ChatBarState } from './types'

import { ChatBar } from './index'

/**
 * The composer, on its own, for design work.
 *
 * `ChatBar` is fully prop-driven (`types.ts`), so everything the design depends
 * on is an arg here — no gateway, no session, no Tauri. The three environment
 * stories at the bottom are the SAME component; desktop / mobile / HUD differ by
 * global state, not by implementation (see `.storybook/decorators.tsx`).
 *
 * The wired version, for checking the real plumbing, is
 * `app/chat/chat-composer.stories.tsx`.
 */

const state: ChatBarState = {
  model: { canSwitch: true, model: 'claude-opus-5', provider: 'anthropic' },
  tools: { enabled: true, label: 'Add context' },
  voice: { active: false, enabled: true }
}

const attachments: ComposerAttachment[] = [
  { id: '1', kind: 'image', label: 'screenshot.png', refText: '@image:screenshot.png' },
  { id: '2', kind: 'file', detail: 'src/app/chat/composer', label: 'index.tsx', refText: '@file:index.tsx' },
  { id: '3', kind: 'folder', label: 'src/store', refText: '@folder:src/store' }
]

const meta = {
  args: {
    busy: false,
    cwd: '~/Projects/allr-agent',
    disabled: false,
    onCancel: () => {},
    onSubmit: () => true,
    sessionId: 'storybook',
    state
  },
  component: ChatBar,
  parameters: { layout: 'fullscreen' },
  title: 'Chat/Composer'
} satisfies Meta<typeof ChatBar>

export default meta

type Story = StoryObj<typeof meta>

// ── The three environments ──────────────────────────────────────────────────

export const Desktop: Story = { decorators: [withDesktop] }

/** Moves the status stack into flow and turns on the mobile-only branches. */
export const Mobile: Story = {
  decorators: [withMobile],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

/**
 * Mobile with the parallel-chat carousel showing.
 *
 * `BubbleRow` is gated twice — `IS_MOBILE` in `index.tsx`, and its own
 * `bubbles.length < 2` early return — so the plain Mobile story renders without
 * it, which is correct but not the layout worth designing against. Seeding the
 * store is what makes the row (and the vertical space it takes from the
 * composer) visible.
 */
export const MobileWithBubbles: Story = {
  decorators: [
    Story => {
      $chatBubbles.set([
        { storedSessionId: 'session-a' },
        { storedSessionId: 'session-b' },
        { storedSessionId: 'session-c' }
      ])

      return <Story />
    },
    withMobile
  ],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

/** The Spotlight bar. Same composer, lifted out of its dock by the
 *  `html[data-hud]` rules and made the first row in flow. */
export const Hud: Story = { decorators: [withHud] }

// ── States, on desktop ──────────────────────────────────────────────────────

/** Mid-turn. Drives the stop / steer / queue ladder in the controls row. */
export const Busy: Story = { args: { busy: true }, decorators: [withDesktop] }

/** What the composer looks like before the gateway is up — the state every
 *  story would be in if the preview did not open it. */
export const Disabled: Story = { args: { disabled: true }, decorators: [withDesktop] }

/**
 * Seeded through `stashSessionDraft`, NOT by writing to the attachment scope.
 *
 * The composer restores its session draft on mount (`use-composer-draft`), and
 * that restore SETS the attachment atom — so chips written into the scope
 * beforehand are wiped by the first render. Going through the app's own stash is
 * both the thing that survives and an honest reproduction of how attachments
 * actually get there.
 */
export const WithAttachments: Story = {
  args: { onRemoveAttachment: () => {}, sessionId: 'storybook-attachments' },
  decorators: [
    Story => {
      stashSessionDraft('storybook-attachments', 'Review these and tell me what changed', attachments)

      return <Story />
    },
    withDesktop
  ]
}

export const Recording: Story = {
  args: { state: { ...state, voice: { active: true, enabled: true } } },
  decorators: [withDesktop]
}

/** Below 320px the control row stops sharing a line with the input and stacks.
 *  The ladder is width-driven (`use-composer-metrics`) and independent of
 *  platform, so it is reachable on desktop too. */
export const Stacked: Story = {
  decorators: [withDesktop],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

/** No model switching — a tile's composer, or a gateway that has not reported
 *  its catalog yet. */
export const ModelLocked: Story = {
  args: { state: { ...state, model: { ...state.model, canSwitch: false, loading: true } } },
  decorators: [withDesktop]
}
