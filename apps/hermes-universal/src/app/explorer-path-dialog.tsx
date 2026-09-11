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
import {
  $explorerPathPrompt,
  cancelExplorerPathPrompt,
  confirmExplorerPathDefaultOnly,
  confirmExplorerPathMoveSession
} from '@/store/explorer-path'

/**
 * "You picked a folder — move this chat there, or only start new ones there?"
 *
 * Three outcomes, which is why this is not `ConfirmDialog`: that one is
 * confirm + cancel, and folding "new chats only" into a checkbox would hide the
 * choice the owner asked to be made explicitly every time. Same `Dialog`
 * primitive, so it looks like every other dialog in the app.
 *
 * Mounted ONCE, from `app.tsx`, driven by an atom — never one dialog per tree
 * row. The three askers (the Home button, a tree row's context menu, a search
 * hit's kebab) are all transient: a Radix menu item is unmounted the instant it
 * is selected, so a dialog owned by the row would be torn down before it could
 * be answered.
 *
 * There is no busy/settled beat here on purpose. `session.cwd.set` answers with
 * `session.info`, and the visible confirmation is the file tree re-rooting
 * itself — a spinner in a dialog nobody is looking at any more would only delay
 * that.
 */
export function ExplorerPathDialog() {
  const { t } = useI18n()
  const e = t.explorerPath
  const prompt = useStore($explorerPathPrompt)

  return (
    <Dialog onOpenChange={open => !open && cancelExplorerPathPrompt()} open={Boolean(prompt)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{e.title}</DialogTitle>
          <DialogDescription>{e.body}</DialogDescription>
        </DialogHeader>

        {/* The path itself, not just its basename: two folders called `src`
            look identical in a sentence, and this question is worth getting
            right the first time. */}
        {prompt && (
          <div className="truncate rounded-md bg-(--ui-control-hover-background) px-3 py-2 font-mono text-xs text-foreground">
            {prompt.path}
          </div>
        )}

        <DialogFooter>
          <Button onClick={cancelExplorerPathPrompt} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button onClick={() => void confirmExplorerPathDefaultOnly()} type="button" variant="secondary">
            {e.newChatsOnly}
          </Button>
          <Button onClick={() => void confirmExplorerPathMoveSession()} type="button">
            {e.moveChat}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
