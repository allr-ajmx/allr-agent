import type { Meta, StoryObj } from '@storybook/react-vite'

import { withDesktop, withHud, withMobile } from '../../../.storybook/decorators'

import { ChatComposer } from './chat-composer'

/**
 * The composer as the app actually mounts it — the integration reference.
 *
 * `ChatBar` (Chat/Composer) is the surface to DESIGN against: every input is a
 * prop, so an arg change is the whole feedback loop. This file is the check that
 * the design still holds once the real plumbing is attached — the wired wrapper
 * takes no props at all and pulls model, session, attachments, slash commands
 * and the gateway from stores and contexts.
 *
 * What is real here and what is not: the component tree, the layout and the
 * styling are the app's. The Tauri boundary is stubbed (`.storybook/mocks/`), so
 * anything that would cross into Rust — the file pickers, transcription, the
 * clipboard — resolves as cancelled or empty rather than doing something. Use it
 * to confirm a redesign survives contact with the wiring, not to exercise the
 * backend.
 */
const meta = {
  component: ChatComposer,
  parameters: { layout: 'fullscreen' },
  title: 'Chat/Composer (wired)'
} satisfies Meta<typeof ChatComposer>

export default meta

type Story = StoryObj<typeof meta>

export const Desktop: Story = { decorators: [withDesktop] }

export const Mobile: Story = {
  decorators: [withMobile],
  parameters: { viewport: { defaultViewport: 'mobile1' } }
}

export const Hud: Story = { decorators: [withHud] }
