import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import { modelOptionsQueryKey } from '@/lib/model-options'
import { queryClient } from '@/lib/query-client'
import type { ModelOptionsResponse } from '@/types/hermes'

import { withMobile } from '../../../.storybook/decorators'

import type { ModelMenuController } from './model-catalog-menu'
import { ModelDrawer } from './model-drawer'

/**
 * The touch model picker.
 *
 * Driven through the REAL data path, not a prop of pre-shaped rows: the story
 * seeds React Query with a `model.options` response under the key the drawer
 * asks for, so curation, search widening and provider grouping all run the same
 * code the app runs. What the story stands in for is the gateway, not the logic.
 */

const CATALOG: ModelOptionsResponse = {
  providers: [
    {
      name: 'Anthropic',
      slug: 'anthropic',
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-5-fast'],
      capabilities: {
        'claude-opus-5': { reasoning: true, fast: false },
        'claude-sonnet-5': { reasoning: true, fast: true },
        'claude-haiku-4-5': { reasoning: false, fast: false }
      }
    },
    {
      name: 'OpenAI',
      slug: 'openai',
      models: ['gpt-5.2', 'gpt-5.2-mini', 'o5'],
      capabilities: {
        'gpt-5.2': { reasoning: true, fast: false },
        'gpt-5.2-mini': { reasoning: true, fast: false },
        o5: { reasoning: true, fast: false }
      }
    }
  ]
} as ModelOptionsResponse

/** Holds the picked model in local state so the tick actually moves when you
 *  tap — a controller that only logged would look broken for the one thing
 *  this drawer exists to do. */
function useStoryController(): ModelMenuController {
  const [choice, setChoice] = useState({ effort: 'medium', fast: false, model: 'claude-opus-5', provider: 'anthropic' })
  const [presets, setPresets] = useState<Record<string, { effort?: string; fast?: boolean }>>({})

  return {
    applyPreset: (preset, row) => setPresets(p => ({ ...p, [`${row.provider}:${row.model}`]: preset })),
    current: choice,
    presetFor: (provider, model) => presets[`${provider}:${model}`] ?? {},
    select: (model, provider) => {
      setChoice(c => ({ ...c, model, provider }))
    },
    setOptions: (patch, row) => {
      setPresets(p => ({ ...p, [`${row.provider}:${row.model}`]: { ...p[`${row.provider}:${row.model}`], ...patch } }))

      if (row.isActive && patch.effort !== undefined) {
        setChoice(c => ({ ...c, effort: patch.effort as string }))
      }
    }
  }
}

function DrawerHarness({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const controller = useStoryController()

  queryClient.setQueryData(modelOptionsQueryKey(null, null), CATALOG)

  return (
    <div className="flex h-full flex-col items-center justify-end p-4">
      <button
        className="rounded-md border border-border/65 px-3 py-2 text-sm"
        onClick={() => setOpen(true)}
        type="button"
      >
        Open model picker
      </button>
      <ModelDrawer controller={controller} onOpenChange={setOpen} open={open} profile={null} sessionId={null} />
    </div>
  )
}

const meta = {
  component: DrawerHarness,
  decorators: [withMobile],
  parameters: { layout: 'fullscreen', viewport: { defaultViewport: 'mobile1' } },
  title: 'Chat/Model Drawer'
} satisfies Meta<typeof DrawerHarness>

export default meta

type Story = StoryObj<typeof meta>

/** Page one: search, close, and the model list with a tick on the current one. */
export const Open: Story = { args: { startOpen: true } }

/** The closed state, so the open transition can be driven by hand. */
export const Closed: Story = { args: { startOpen: false } }
