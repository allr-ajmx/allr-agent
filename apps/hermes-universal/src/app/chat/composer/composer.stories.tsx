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

/**
 * A desktop window squeezed to phone width.
 *
 * There is no longer a layout to switch to — the composer is two rows at every
 * width — so this is here for the things that DO still have to survive being
 * cramped: the model pill's label, the control cluster, and the input's own
 * minimum. It was previously named `Stacked` and existed to demonstrate the
 * width ladder crossing its breakpoint; that ladder is gone.
 */
export const Narrow: Story = {
  decorators: [withDesktop],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

/** No model switching — a tile's composer, or a gateway that has not reported
 *  its catalog yet. */
export const ModelLocked: Story = {
  args: { state: { ...state, model: { ...state.model, canSwitch: false, loading: true } } },
  decorators: [withDesktop]
}

/**
 * Touch behaviour, for checking the keyboard by hand on a phone viewport.
 *
 * Two things to try, both of which used to be wrong:
 *
 * 1. Tap the padding just above the text, or the strip between the text and the
 *    controls. The keyboard must NOT open. This is not the obvious kind of bug —
 *    Chrome and WebKit apply TOUCH ADJUSTMENT and snap a near-miss onto the
 *    editable, so those taps arrive with the editor as their `event.target` and
 *    are indistinguishable from a real one by target alone. The guard compares
 *    the pointer's COORDINATES to the editor's box instead.
 * 2. Tap anywhere in the text row, including its lower half. The keyboard must
 *    open — the row is one 48px editable box, not a short editor centred in a
 *    tall wrapper, precisely so there is no dead strip inside it.
 *
 * Also worth eyeballing here: every control and both rows are 48px
 * (`--touch-target-min`), so nothing in the bar is a small target.
 */
export const MobileTouchTargets: Story = {
  decorators: [withMobile],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

/**
 * A long model name must SHORTEN, not shove.
 *
 * The controls row is a fixed set of icon buttons plus one variable-width pill.
 * Both the cluster and the pill were `shrink-0`, so a long name grew the pill
 * and pushed dictation / wake / send off the end of the composer instead of
 * being truncated. `min-w-0` alone does not fix that — it permits shrinking, it
 * does not make an item shrinkable.
 */
export const MobileLongModelName: Story = {
  args: {
    state: {
      ...state,
      model: { ...state.model, model: 'claude-opus-5-20260514-extended-thinking-preview', provider: 'anthropic' }
    }
  },
  decorators: [withMobile],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}
