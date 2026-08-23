import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import type { MenuKit } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'

import { withMobile } from '../../../.storybook/decorators'

import { MenuDrawer } from './menu-drawer'

/**
 * A kit-rendered menu hosted as a top drawer.
 *
 * The `render` function below is the shape a real menu already has — the
 * session menu hands its own `renderItems` straight in. Nothing about the menu
 * is rewritten for touch; it is handed a different kit, and the same rows come
 * out as full-width drawer rows with submenus as PAGES rather than as hover
 * panels a finger cannot open.
 */
function Harness() {
  const [open, setOpen] = useState(true)

  const render = (kit: MenuKit) => (
    <>
      <kit.Item onSelect={() => {}}>
        <Codicon name="pin" size="0.875rem" />
        <span>Pin</span>
      </kit.Item>
      <kit.Item onSelect={() => {}}>
        <Codicon name="edit" size="0.875rem" />
        <span>Rename</span>
      </kit.Item>
      <kit.Sub>
        <kit.SubTrigger>
          <Codicon name="folder" size="0.875rem" />
          <span>Project</span>
        </kit.SubTrigger>
        <kit.SubContent>
          <kit.Item onSelect={() => {}}>
            <span>No project</span>
          </kit.Item>
          <kit.Item onSelect={() => {}}>
            <span>allr-agent</span>
          </kit.Item>
          <kit.Item onSelect={() => {}}>
            <span>hermes-universal</span>
          </kit.Item>
        </kit.SubContent>
      </kit.Sub>
      <kit.Separator />
      <kit.Item onSelect={() => {}} variant="destructive">
        <Codicon name="trash" size="0.875rem" />
        <span>Delete</span>
      </kit.Item>
    </>
  )

  return (
    <div className="flex h-full flex-col items-center justify-center">
      <button className="rounded-md border border-border/65 px-3 py-2 text-sm" onClick={() => setOpen(true)} type="button">
        Open menu
      </button>
      <MenuDrawer onOpenChange={setOpen} open={open} render={render} title="Session actions" />
    </div>
  )
}

const meta = {
  component: Harness,
  decorators: [withMobile],
  parameters: { layout: 'fullscreen', viewport: { defaultViewport: 'mobile1' } },
  title: 'Nav/Menu Drawer'
} satisfies Meta<typeof Harness>

export default meta

/** Tap "Project" to push its page; the back button returns to the list. */
export const Mobile: StoryObj<typeof meta> = {}
