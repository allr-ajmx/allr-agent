import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import {
  $petGenAvailable,
  $petGenDrafts,
  $petGenError,
  $petGenPreview,
  $petGenPrompt,
  $petGenSelected,
  $petGenStage,
  $petGenStatus,
  adoptHatched,
  cancelGenerate,
  cancelHatch,
  checkPetGenAvailable,
  cleanPetName,
  discardHatched,
  generateDrafts,
  hatchSelected,
  resetPetGen
} from '@/store/pet-generate'

import { PetSprite } from './pet-sprite'

function Spinner() {
  return (
    <span className="inline-block size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-primary" />
  )
}

export function PetGenerateSheet({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const { t } = useI18n()
  const g = t.commandCenter.generatePet
  const status = useStore($petGenStatus)
  const drafts = useStore($petGenDrafts)
  const selected = useStore($petGenSelected)
  const stage = useStore($petGenStage)
  const preview = useStore($petGenPreview)
  const error = useStore($petGenError)
  const available = useStore($petGenAvailable)

  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')

  // Probe availability + start clean each open; discard an abandoned preview on close.
  useEffect(() => {
    if (open) {
      void checkPetGenAvailable()

      if ($petGenStatus.get() === 'idle') {
        // `/hatch <concept>` seeds $petGenPrompt before opening; a plain open
        // leaves it empty, so this is still "start clean" in the normal case.
        setPrompt($petGenPrompt.get())
        setName('')
      }
    } else if ($petGenStatus.get() === 'preview' || $petGenStatus.get() === 'adopting') {
      void discardHatched().then(resetPetGen)
    }
  }, [open])

  // Seed the name from the prompt once drafts are ready.
  useEffect(() => {
    if (status === 'ready' && !name) {
      setName(cleanPetName(prompt))
    }
  }, [status])

  const close = () => {
    if (status === 'idle' || status === 'error' || status === 'stale') {
      resetPetGen()
    }

    onOpenChange(false)
  }

  const busy = status === 'generating' || status === 'hatching' || status === 'adopting'

  const stageText = () => {
    if (!stage) {
      return g.hatching
    }

    if (stage.phase === 'compose') {
      return g.hatchComposing
    }

    if (stage.phase === 'save') {
      return g.hatchSaving
    }

    return g.hatchRow(stage.state ?? '', stage.done ?? 0, stage.total ?? 0)
  }

  return (
    <Sheet onOpenChange={o => (o ? onOpenChange(true) : close())} open={open}>
      <SheetContent className="gap-0" side="bottom">
        <SheetHeader>
          <SheetTitle>{g.title}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto p-3 pt-0">
          {available === false && status === 'idle' ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{g.staleBackend}</p>
          ) : status === 'stale' ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{g.staleBackend}</p>
          ) : status === 'preview' || status === 'adopting' ? (
            <>
              <div className="grid min-h-32 place-items-center py-2">
                {preview && <PetSprite info={preview} stateOverride="idle" zoom={2.6} />}
              </div>
              <p className="text-center text-sm font-medium text-foreground">{g.hatched}</p>
              <Input onChange={e => setName(e.target.value)} placeholder={g.namePlaceholder} value={name} />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => void discardHatched()} variant="outline">
                  {g.startOver}
                </Button>
                <Button
                  className="flex-1"
                  disabled={status === 'adopting'}
                  onClick={() => void adoptHatched(name).then(ok => ok && onOpenChange(false))}
                >
                  {g.adopt}
                </Button>
              </div>
            </>
          ) : status === 'hatching' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Spinner />
              <p className="text-sm font-medium text-foreground">{stageText()}</p>
              <p className="text-xs text-muted-foreground">{g.backgroundHint}</p>
              <Button onClick={cancelHatch} size="sm" variant="ghost">
                {t.common.cancel}
              </Button>
            </div>
          ) : (
            <>
              {/* Prompt (idle/error) + live drafts (generating/ready). */}
              {status !== 'ready' && (
                <>
                  <Textarea
                    onChange={e => setPrompt(e.target.value)}
                    placeholder={g.placeholder}
                    rows={3}
                    value={prompt}
                  />
                  <p className="text-xs text-muted-foreground">{g.promptHint}</p>
                </>
              )}

              {(status === 'generating' || status === 'ready') && (
                <div className="grid grid-cols-2 gap-2">
                  {drafts.map(d => (
                    <button
                      className={`overflow-hidden rounded-lg border-2 transition-colors ${selected === d.index ? 'border-primary' : 'border-border'}`}
                      key={d.index}
                      onClick={() => $petGenSelected.set(d.index)}
                      type="button"
                    >
                      <img
                        alt=""
                        className="aspect-square w-full bg-muted object-contain [image-rendering:pixelated]"
                        src={d.dataUri}
                      />
                    </button>
                  ))}
                  {status === 'generating' &&
                    Array.from({ length: Math.max(0, 4 - drafts.length) }).map((_, i) => (
                      <div
                        className="grid aspect-square place-items-center rounded-lg border-2 border-dashed border-border"
                        key={`ph-${i}`}
                      >
                        <Spinner />
                      </div>
                    ))}
                </div>
              )}

              {status === 'ready' && (
                <>
                  <p className="text-xs text-muted-foreground">{g.readyHint}</p>
                  <Input onChange={e => setName(e.target.value)} placeholder={g.namePlaceholder} value={name} />
                </>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}

              <div className="flex gap-2">
                {status === 'generating' ? (
                  <Button className="flex-1" onClick={cancelGenerate} variant="outline">
                    {t.common.cancel}
                  </Button>
                ) : status === 'ready' ? (
                  <>
                    <Button className="flex-1" onClick={() => void generateDrafts(prompt)} variant="outline">
                      {g.remix}
                    </Button>
                    <Button className="flex-1" disabled={!name.trim()} onClick={() => void hatchSelected(name)}>
                      {g.hatch}
                    </Button>
                  </>
                ) : (
                  <Button
                    className="flex-1"
                    disabled={busy || !prompt.trim()}
                    onClick={() => void generateDrafts(prompt)}
                  >
                    {status === 'error' ? g.retry : g.generate}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
