import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { KbdCombo } from '@/components/ui/kbd'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  AudioLines,
  Ear,
  EarOff,
  iconSize,
  Layers3,
  Loader2,
  Square,
  SteeringWheel,
  Volume2,
  VolumeX
} from '@/lib/icons'
import { formatCombo } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import { bindingsFor } from '@/store/keybinds'
import { $wakeWord, toggleWakeWord } from '@/store/wake-word'

import type { ConversationStatus } from './hooks/use-voice-conversation'
import { ModelPill } from './model-pill'
import type { ChatBarState, VoiceStatus } from './types'

export const ICON_BTN = 'size-(--composer-control-size) shrink-0 rounded-md'
export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)
// Send/voice-conversation primary: solid foreground-on-background circle
// (reads as black-on-white in light mode, white-on-black in dark mode) to
// match the reference composer's high-contrast CTA. Keeps the pill itself
// neutral and lets the action visually dominate the row.
export const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'bg-foreground text-background hover:bg-foreground/90',
  'disabled:bg-foreground/30 disabled:text-background disabled:opacity-100'
)

interface ConversationProps {
  active: boolean
  level: number
  muted: boolean
  status: ConversationStatus
  onEnd: () => void
  onStart: () => void
  onStopTurn: () => void
  onToggleMute: () => void
}

export function ComposerControls({
  autoSpeak,
  busy,
  busyAction,
  busyActionActive,
  canSubmit,
  compactModelPill = false,
  conversation,
  disabled,
  hasComposerPayload,
  state,
  voiceStatus,
  onDictate,
  onQueue,
  onToggleAutoSpeak
}: {
  autoSpeak: boolean
  busy: boolean
  busyAction: 'queue' | 'steer' | 'stop'
  /** Whether the turn is OCCUPIED — `busy`, or compacting, which occupies the
   *  composer without a turn (a manual `/compress` on an idle session). What the
   *  primary button says and does branches on this, not on `busy`: the two
   *  disagree exactly while summarizing, and branching on `busy` there had the
   *  button offer "Send" for an action that queues. `busy` still decides whether
   *  the slot belongs to the turn controls at all, so an idle compaction with an
   *  empty composer keeps its mic rather than growing a Stop with nothing to
   *  stop. */
  busyActionActive: boolean
  canSubmit: boolean
  compactModelPill?: boolean
  conversation: ConversationProps
  disabled: boolean
  hasComposerPayload: boolean
  state: ChatBarState
  voiceStatus: VoiceStatus
  onDictate: () => void
  onQueue: () => void
  onToggleAutoSpeak: () => void
}) {
  const { t } = useI18n()
  const c = t.composer
  // Read from the keybind registry rather than hardcoding the chord — queue is a
  // readonly binding today, but the registry stays the single source of truth.
  const queueCombo = bindingsFor('composer.queue')[0] ?? 'mod+enter'
  const queueLabel = `${c.queueMessage} (${formatCombo(queueCombo)})`

  // The primary button has to say what the primary key does: while a turn runs,
  // Enter steers it. Only an attachment, a compacting turn or a slash command
  // demotes it to a queue.
  const busyActionLabel = busyAction === 'steer' ? c.steer : busyAction === 'queue' ? c.queueMessage : c.stop

  const queueTip = (
    <span className="inline-flex items-center gap-1.5">
      {c.queueMessage}
      <KbdCombo combo={queueCombo} size="sm" variant="inverted" />
    </span>
  )

  if (conversation.active) {
    return <ConversationPill {...conversation} disabled={disabled} />
  }

  const showVoicePrimary = !busy && !hasComposerPayload

  return (
    <div className="ms-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <ModelPill compact={compactModelPill} disabled={disabled} model={state.model} />
      {/* Dictation stays put while a correction is being typed: the mic slot is
          not the steer slot. The primary button below already carries the steer
          wheel, so the only action that needs its own control here is QUEUE —
          without it "line this up next" is reachable by mod+Enter alone, which
          does not exist on a touch keyboard. */}
      <DictationButton disabled={disabled} onToggle={onDictate} state={state.voice} status={voiceStatus} />
      <WakeWordButton disabled={disabled} />
      <AutoSpeakButton active={autoSpeak} disabled={disabled} onToggle={onToggleAutoSpeak} />
      {busyAction === 'steer' ? (
        <Tip label={queueTip}>
          <Button
            aria-label={queueLabel}
            className={GHOST_ICON_BTN}
            disabled={disabled}
            onClick={onQueue}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Layers3 className={iconSize.sm} />
          </Button>
        </Tip>
      ) : null}
      {showVoicePrimary ? (
        <Tip label={c.startVoice}>
          <Button
            aria-label={c.startVoice}
            className={PRIMARY_ICON_BTN}
            disabled={disabled}
            onClick={() => {
              triggerHaptic('open')
              conversation.onStart()
            }}
            size="icon"
            type="button"
          >
            <AudioLines className={iconSize.sm} />
          </Button>
        </Tip>
      ) : (
        <Tip
          label={
            busyActionActive ? (
              busyAction === 'steer' ? (
                <TipKeybindLabel actionId="composer.steer" text={c.steer} />
              ) : busyAction === 'queue' ? (
                <TipKeybindLabel actionId="composer.queue" text={c.queueMessage} />
              ) : (
                c.stop
              )
            ) : (
              <TipKeybindLabel actionId="composer.send" text={c.send} />
            )
          }
        >
          <Button
            aria-label={busyActionActive ? busyActionLabel : c.send}
            className={PRIMARY_ICON_BTN}
            disabled={disabled || !canSubmit}
            type="submit"
          >
            {busyActionActive ? (
              busyAction === 'steer' ? (
                <SteeringWheel className={iconSize.sm} />
              ) : busyAction === 'queue' ? (
                <Layers3 className={iconSize.sm} />
              ) : (
                <span className="block size-2.5 rounded-[0.1875rem] bg-current" />
              )
            ) : (
              <Codicon name="arrow-up" size="0.875rem" />
            )}
          </Button>
        </Tip>
      )}
    </div>
  )
}

function ConversationPill({
  disabled,
  level,
  muted,
  onEnd,
  onStopTurn,
  onToggleMute,
  status
}: ConversationProps & { disabled: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const speaking = status === 'speaking'
  const listening = status === 'listening' && !muted

  const label =
    status === 'speaking'
      ? c.speaking
      : status === 'transcribing'
        ? c.transcribing
        : status === 'thinking'
          ? c.thinking
          : muted
            ? c.muted
            : c.listening

  return (
    <div className="ms-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <Tip label={muted ? c.unmuteMic : c.muteMic}>
        <Button
          aria-label={muted ? c.unmuteMic : c.muteMic}
          aria-pressed={muted}
          className={cn(GHOST_ICON_BTN, 'p-0', muted && 'bg-muted text-muted-foreground')}
          disabled={disabled}
          onClick={() => {
            triggerHaptic('selection')
            onToggleMute()
          }}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Codicon name={muted ? 'mic-off' : 'mic'} size="1rem" />
        </Button>
      </Tip>
      {listening && (
        <Tip label={c.stopListening}>
          <Button
            aria-label={c.stopListening}
            className="h-(--composer-control-size) shrink-0 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={disabled}
            onClick={() => {
              triggerHaptic('submit')
              onStopTurn()
            }}
            type="button"
            variant="ghost"
          >
            <Square className={cn('fill-current', iconSize.xs)} />
            <span>{c.stopShort}</span>
          </Button>
        </Tip>
      )}
      {/* The ear never hides: it stays reachable mid-conversation, shown paused,
          because the conversation itself is holding the mic the detector wants. */}
      <WakeWordButton disabled={disabled} pausedForVoice />
      <Tip label={c.endConversation}>
        <Button
          aria-label={c.endConversation}
          className="h-(--composer-control-size) gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          disabled={disabled}
          onClick={() => {
            triggerHaptic('close')
            onEnd()
          }}
          type="button"
        >
          <ConversationIndicator level={level} listening={listening} speaking={speaking} />
          <span>{c.endShort}</span>
        </Button>
      </Tip>
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  )
}

function ConversationIndicator({
  level,
  listening,
  speaking
}: {
  level: number
  listening: boolean
  speaking: boolean
}) {
  if (speaking) {
    return <Loader2 className={cn('animate-spin', iconSize.xs)} />
  }

  const bars = [0.55, 0.85, 1, 0.85, 0.55]
  const normalized = Math.max(0, Math.min(level, 1))

  return (
    <span aria-hidden="true" className="flex h-3 items-center gap-0.5">
      {bars.map((weight, index) => {
        const height = listening ? 0.3 + Math.min(0.7, normalized * weight) : 0.3

        return <span className="w-0.5 rounded-full bg-current" key={index} style={{ height: `${height * 100}%` }} />
      })}
    </span>
  )
}

/**
 * The wake-word ear. "The toggle IS the config": there is no separate client
 * preference — clicking writes `wake_word.enabled` on the gateway, and the state
 * shown here is whatever the gateway last reported.
 *
 * Deliberately never hidden, even when the backend refuses. A control that
 * disappears leaves the user with no way to find out WHY the wake word isn't
 * working; a control that stays and explains itself in its tooltip does.
 */
function WakeWordButton({ disabled, pausedForVoice = false }: { disabled: boolean; pausedForVoice?: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const wake = useStore($wakeWord)
  const on = wake.enabled && wake.available

  const label = !wake.available
    ? c.wakeWordUnavailable
    : pausedForVoice || wake.pausedForVoice
      ? c.wakeWordPausedVoice(wake.phrase)
      : on
        ? c.wakeWordListening(wake.phrase)
        : c.wakeWordOff(wake.phrase)

  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={on}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          on && !pausedForVoice && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
          (pausedForVoice || wake.pausedForVoice) && 'opacity-60'
        )}
        disabled={disabled || wake.busy}
        onClick={() => {
          triggerHaptic(on ? 'close' : 'open')
          void toggleWakeWord()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {on ? <Ear className={iconSize.sm} /> : <EarOff className={iconSize.sm} />}
      </Button>
    </Tip>
  )
}

// Pure-TTS toggle: type normally, but have every assistant reply read aloud —
// no dictation, no full conversation loop. Filled/accent when on, mirroring the
// muted-mic pressed state above. Driven by (and persisted to) `voice.auto_tts`.
function AutoSpeakButton({ active, disabled, onToggle }: { active: boolean; disabled: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const c = t.composer
  const label = active ? c.stopSpeakingReplies : c.speakReplies

  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
        )}
        disabled={disabled}
        onClick={() => {
          triggerHaptic(active ? 'close' : 'open')
          onToggle()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {active ? <Volume2 className={iconSize.sm} /> : <VolumeX className={iconSize.sm} />}
      </Button>
    </Tip>
  )
}

function DictationButton({
  disabled,
  state,
  status,
  onToggle
}: {
  disabled: boolean
  state: ChatBarState['voice']
  status: VoiceStatus
  onToggle: () => void
}) {
  const { t } = useI18n()
  const c = t.composer
  const active = state.active || status !== 'idle'

  const aria =
    status === 'recording' ? c.stopDictation : status === 'transcribing' ? c.transcribingDictation : c.voiceDictation

  return (
    <Tip label={aria}>
      <Button
        aria-label={aria}
        aria-pressed={active}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          'data-[active=true]:bg-accent data-[active=true]:text-foreground',
          status === 'recording' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
          status === 'transcribing' && 'bg-primary/10 text-primary'
        )}
        data-active={active}
        disabled={disabled || !state.enabled || status === 'transcribing'}
        onClick={() => {
          triggerHaptic(active ? 'close' : 'open')
          onToggle()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {status === 'recording' ? (
          <Square className={cn('fill-current', iconSize.xs)} />
        ) : status === 'transcribing' ? (
          <Loader2 className={cn('animate-spin', iconSize.sm)} />
        ) : (
          <Codicon name="mic" size="0.875rem" />
        )}
      </Button>
    </Tip>
  )
}
