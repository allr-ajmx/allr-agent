import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import {
  $sshHostKey,
  $sshPrompt,
  answerActiveSshPrompt,
  decideActiveSshHostKey,
  type SshPromptEvent
} from '@/store/ssh-backend'

// The two questions an SSH operation can stop and ask: a credential, and whether
// to trust a host key we have never seen.
//
// One component, mounted once, reading shared atoms — rather than living inside
// SshPanel as it used to. Desktop ran `ssh` with BatchMode=yes and so could never
// ask anything; we can, and the moment a SECOND caller existed (installing Hermes
// on the remote, which authenticates exactly like a connect) the panel-owned
// version left it asking into a void until the 60s timeout killed it.
//
// Mount this ONCE per surface. Two mounted copies would both render the same
// pending question, and the first answer would clear the atom out from under the
// second.

export function SshPromptDialog({
  onAnswered
}: {
  /** Lets the settings form keep an answer, so the next launch — which cannot
   *  prompt — has something to authenticate with. */
  onAnswered?: (kind: SshPromptEvent['kind'], answer: string) => void
}) {
  const { t } = useI18n()
  const g = t.settings.gateway
  const prompt = useStore($sshPrompt)
  const hostKey = useStore($sshHostKey)
  const [answer, setAnswer] = useState('')

  // A fresh box per question. Without this, the answer to a key passphrase is
  // still sitting in the field when the next question — often the login password
  // — arrives, and pressing Enter submits the wrong secret.
  useEffect(() => {
    setAnswer('')
  }, [prompt?.promptId])

  const submit = () => {
    if (!prompt) {
      return
    }

    void answerActiveSshPrompt(answer)
    onAnswered?.(prompt.kind, answer)
    setAnswer('')
  }

  if (!prompt && !hostKey) {
    return null
  }

  return (
    <>
      {/* Trust-on-first-use. A CHANGED key never reaches here — it is refused
          outright in Rust, under every policy. */}
      {hostKey ? (
        <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
          <div className="text-sm font-medium">{g.sshHostKeyTitle}</div>
          <p className="text-xs text-(--ui-text-secondary)">{g.sshHostKeyDesc(hostKey.host, hostKey.fingerprint)}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => void decideActiveSshHostKey(false)} size="sm" variant="outline">
              {g.sshHostKeyReject}
            </Button>
            <Button onClick={() => void decideActiveSshHostKey(true)} size="sm">
              {g.sshHostKeyTrust}
            </Button>
          </div>
        </div>
      ) : null}

      {prompt ? (
        <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
          <div className="text-sm font-medium">{g.sshPromptTitle}</div>
          <p className="text-xs text-(--ui-text-secondary)">{prompt.label}</p>
          <Input
            autoFocus
            className="font-normal"
            onChange={event => setAnswer(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                submit()
              }
            }}
            // Per QUESTION, not per kind: keyboard-interactive is the one
            // exchange that legitimately asks things the server wants echoed.
            type={prompt.secret ? 'password' : 'text'}
            value={answer}
          />
          <div className="flex justify-end">
            <Button onClick={submit} size="sm">
              {g.sshConnect}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
