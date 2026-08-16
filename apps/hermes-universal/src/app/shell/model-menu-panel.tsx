import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DropdownMenuItem, dropdownMenuRow } from '@/components/ui/dropdown-menu'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { currentPickerSelection } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import { $sessionId as $activeSessionId } from '@/store/chat'
import {
  $currentFastMode,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  setCurrentFastMode,
  setCurrentReasoningEffort
} from '@/store/model'
import { $modelPresets, applyModelPreset, modelPresetKey, setModelPreset } from '@/store/model-presets'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import type { ModelOptionsResponse } from '@/types/hermes'

import { ModelCatalogMenu, type ModelMenuController } from './model-catalog-menu'

/** Re-exported from its new home so the composer's model pill (and any other
 *  host dropdown) keeps importing it from the panel it wraps. */
export { ModelMenuCloseContext } from './model-catalog-menu'

interface ModelMenuPanelProps {
  gateway?: HermesGateway
  onSelectModel: (selection: { model: string; provider: string }) => Promise<boolean> | void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

/**
 * The composer's model menu: `ModelCatalogMenu` driven by the SESSION
 * controller. Everything visual lives in the catalog menu — this file is only
 * what a model choice MEANS here, which is "write it through to the live
 * session and remember it as that model's preset".
 */
export function ModelMenuPanel({ gateway, onSelectModel, requestGateway }: ModelMenuPanelProps) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const [refreshing, setRefreshing] = useState(false)
  const queryClient = useQueryClient()
  // Reactive session state is read from the stores here (not drilled in), so
  // toggling effort/fast/model re-renders this panel in place without forcing
  // the parent to rebuild the menu content (which would close the dropdown).
  const activeSessionId = useStore($activeSessionId)
  const profile = useStore($activeGatewayProfile)
  const currentFastMode = useStore($currentFastMode)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const currentReasoningEffort = useStore($currentReasoningEffort)
  const modelPresets = useStore($modelPresets)

  // Same query key the catalog menu below uses, so this is a cache read rather
  // than a second fetch. It exists because which model reads as "current" is
  // the CONTROLLER's answer, and pre-session that answer depends on what the
  // catalog reports (see currentPickerSelection).
  const modelOptions = useQuery({
    queryKey: modelOptionsQueryKey(profile, activeSessionId),
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway, sessionId: activeSessionId })
  })

  const { model: optionsModel, provider: optionsProvider } = currentPickerSelection(
    !!activeSessionId,
    { model: currentModel, provider: currentProvider },
    modelOptions.data
  )

  // The composer picker never persists the profile default. With a session it
  // scopes the switch to that session; with none it's UI state shipped on the
  // next session.create (see selectModel). The default lives in Settings → Model.
  const switchTo = (model: string, provider: string) => onSelectModel({ model, provider })

  // Editing an option always records the model's global preset; the ACTIVE
  // model also gets it pushed onto the live session. Non-active edits stay
  // preset-only — they do not switch you to that model.
  const setReasoning = async (next: string, row: { isActive: boolean; model: string; provider: string }) => {
    const previous = row.isActive
      ? currentReasoningEffort
      : (modelPresets[modelPresetKey(row.provider, row.model)]?.effort ?? '')

    setModelPreset(row.provider, row.model, { effort: next })

    if (!row.isActive) {
      return
    }

    setCurrentReasoningEffort(next)

    // Preset-only without a session: `isActive` holds for the global/default
    // row pre-session, and the gateway's `config.set` falls back to global
    // config when none matches — so don't reach it (preset + optimistic store
    // are the whole effect). Same guard in applyModelPreset / setFast.
    if (!activeSessionId) {
      return
    }

    try {
      await requestGateway('config.set', { key: 'reasoning', session_id: activeSessionId, value: next })
    } catch (err) {
      setCurrentReasoningEffort(previous)
      setModelPreset(row.provider, row.model, { effort: previous })
      notifyError(err, t.shell.modelOptions.updateFailed)
    }
  }

  const setFast = async (enabled: boolean, row: { isActive: boolean; model: string; provider: string }) => {
    setModelPreset(row.provider, row.model, { fast: enabled })

    if (!row.isActive) {
      return
    }

    setCurrentFastMode(enabled)

    // Preset-only without a session (see setReasoning).
    if (!activeSessionId) {
      return
    }

    try {
      await requestGateway('config.set', {
        key: 'fast',
        session_id: activeSessionId,
        value: enabled ? 'fast' : 'normal'
      })
    } catch (err) {
      setCurrentFastMode(!enabled)
      setModelPreset(row.provider, row.model, { fast: !enabled })
      notifyError(err, t.shell.modelOptions.fastFailed)
    }
  }

  const controller: ModelMenuController = {
    // One atomic "apply this model's preset" write to the live session — the
    // row is implicit here, since selecting it is what just made it active.
    applyPreset: preset =>
      void applyModelPreset(preset, {
        failMessage: t.shell.modelOptions.updateFailed,
        request: requestGateway,
        sessionId: activeSessionId
      }),
    current: {
      effort: currentReasoningEffort,
      fast: currentFastMode,
      model: optionsModel,
      provider: optionsProvider
    },
    presetFor: (provider, model) => modelPresets[modelPresetKey(provider, model)] ?? {},
    select: switchTo,
    setOptions: (patch, row) => {
      if (patch.effort !== undefined) {
        void setReasoning(patch.effort, row)
      }

      if (patch.fast !== undefined) {
        void setFast(patch.fast, row)
      }
    }
  }

  // Explicit "Refresh Models": re-fetch the catalog with refresh:true so the
  // backend busts its 1h provider-model disk cache and re-pulls each provider's
  // live list. Fixes live-only models (e.g. OpenCode Zen free tier) vanishing
  // when the cache expires and falls back to the curated static list.
  const refreshModels = async () => {
    if (refreshing) {
      return
    }

    setRefreshing(true)

    try {
      const queryKey = modelOptionsQueryKey(profile, activeSessionId)

      const next = await requestModelOptions({ gateway, refresh: true, sessionId: activeSessionId })

      queryClient.setQueryData<ModelOptionsResponse>(queryKey, next)
    } catch {
      // Network/backend hiccup — fall back to a plain invalidate so the next
      // open re-fetches (still cached, but no worse than before).
      void queryClient.invalidateQueries({ queryKey: ['model-options'] })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ModelCatalogMenu
      controller={controller}
      footer={
        <DropdownMenuItem
          className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
          disabled={refreshing}
          onSelect={event => {
            event.preventDefault()
            void refreshModels()
          }}
        >
          <Codicon className={cn(refreshing && 'animate-spin')} name="sync" size="0.75rem" />
          {copy.refreshModels}
        </DropdownMenuItem>
      }
      gateway={gateway}
      includeMoa
      profile={profile}
      sessionId={activeSessionId}
    />
  )
}
