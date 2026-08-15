import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $backgroundClosePrompt, dismissBackgroundClosePrompt } from '@/store/background-mode'

/**
 * The question the FIRST window close asks, once per machine.
 *
 * Background mode has no honest default. Assuming "close quits" ends an app the
 * user may have wanted resident, mid-turn; assuming "close hides" puts a running
 * process behind a tray icon they were not told about and leaves them hunting
 * for a window that is still there. So the preference starts unanswered
 * (`store/background-mode.ts`) and the first close is where it gets answered —
 * at the moment the choice is about something concrete rather than a switch in
 * Settings the user has no reason to visit.
 *
 * Three answers, not two. Cancel matters as much as the other two: the close
 * button is one keystroke from Quit on every platform, and a dialog whose only
 * exits both dispose of the window would turn a misclick into a decision that
 * also gets written down for every close after it.
 *
 * The verbs are THUNKS carried on the prompt rather than actions taken here.
 * They belong to `store/windows`, which imports the background-mode store, so
 * the close guard hands over what it already has in hand — and this component
 * stays out of the question of how a window is hidden, closed, or how the local
 * gateway is stopped.
 *
 * Mounted once per window from `app.tsx`, beside `CloseConfirm`, for the same
 * reason that one is: the guard is armed at boot for any window owning the app's
 * persisted state, and a shell that forgot to render this would park a close
 * that nothing on screen could answer — leaving the titlebar button dead.
 */
export function BackgroundCloseDialog() {
  const { t } = useI18n()
  const prompt = useStore($backgroundClosePrompt)

  function answer(run: () => Promise<void> | void): void {
    // Dismissed FIRST, and deliberately: both verbs end in a window that is
    // hidden or gone, and a dialog still mounted over a hiding window flashes on
    // its way out — and would still be on screen if the hide is refused, asking
    // a question that has already been answered.
    dismissBackgroundClosePrompt()

    void run()
  }

  return (
    <Dialog onOpenChange={open => !open && dismissBackgroundClosePrompt()} open={Boolean(prompt)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.tray.closeDialogTitle}</DialogTitle>
          <DialogDescription>{t.tray.closeDialogDesc}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button onClick={() => dismissBackgroundClosePrompt()} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button onClick={() => prompt && answer(prompt.close)} type="button" variant="secondary">
            {t.tray.closeApp}
          </Button>
          <Button onClick={() => prompt && answer(prompt.keep)} type="button">
            {t.tray.keepInBackground}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
