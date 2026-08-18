import { Codecs, persistentAtom } from '@/lib/persisted'
import { setCurrentFastMode, setCurrentReasoningEffort } from '@/store/model'
import { notifyError } from '@/store/notifications'

// Ported from apps/desktop/src/store/model-presets.ts. Seam changes: persistence
// via @/lib/persisted (persistentAtom) instead of desktop's storage helpers, and
// the reasoning/fast setters come from @/store/model.

/** Per-model reasoning/fast preset, remembered globally across sessions and
 *  re-applied to the session whenever that model is selected. Unset dimensions
 *  fall back to the Allr default (medium effort, no fast). */
export interface ModelPreset {
  effort?: string
  fast?: boolean
}

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Stable `provider::model` key (matches the visibility-store format). */
export const modelPresetKey = (provider: string, model: string): string => `${provider}::${model}`

export const $modelPresets = persistentAtom<Record<string, ModelPreset>>(
  'hermes.model-presets',
  {},
  Codecs.json<Record<string, ModelPreset>>()
)

export function getModelPreset(provider: string, model: string): ModelPreset {
  return $modelPresets.get()[modelPresetKey(provider, model)] ?? {}
}

/** Merge a partial preset for one model and persist. */
export function setModelPreset(provider: string, model: string, patch: ModelPreset): void {
  const key = modelPresetKey(provider, model)
  const next = { ...$modelPresets.get(), [key]: { ...$modelPresets.get()[key], ...patch } }

  $modelPresets.set(next)
}

/** Push a model's preset onto the active session (optimistic + gateway).
 *  `undefined` skips that dimension; values are capability-gated upstream.
 *  No-ops without a session — the gateway's `config.set` reasoning/fast fall
 *  back to persistent (global/profile) config when none matches, so selecting
 *  a model must not reach it (else it rewrites `agent.*`, defaults included). */
export async function applyModelPreset(
  { effort, fast }: ModelPreset,
  ctx: { failMessage: string; request: RequestGateway; sessionId: null | string }
): Promise<void> {
  if (!ctx.sessionId) {
    return
  }

  if (effort !== undefined) {
    setCurrentReasoningEffort(effort)
  }

  if (fast !== undefined) {
    setCurrentFastMode(fast)
  }

  try {
    if (effort !== undefined) {
      await ctx.request('config.set', { key: 'reasoning', session_id: ctx.sessionId, value: effort })
    }

    if (fast !== undefined) {
      await ctx.request('config.set', { key: 'fast', session_id: ctx.sessionId, value: fast ? 'fast' : 'normal' })
    }
  } catch (err) {
    notifyError(err, ctx.failMessage)
  }
}
