import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { respondSudo, type SudoRequest } from '@/store/chat'
import { notifyError } from '@/store/notifications'

export function SudoBar({ request, sessionKey }: { request: SudoRequest; sessionKey: string }) {
  const [password, setPassword] = useState('')
  // The bar stays until the gateway has the answer (MJXHRM-418): a swallowed
  // rejection used to tear it down while the sudo prompt was still blocking the
  // agent, with no way to answer it a second time.
  const [sending, setSending] = useState(false)

  const send = async (value: string) => {
    setSending(true)

    try {
      await respondSudo(value, sessionKey)
    } catch (error) {
      notifyError(error, 'Sudo response failed to send')
    } finally {
      setSending(false)
    }
  }

  const submit = () => {
    if (password) {
      void send(password)
    }
  }

  return (
    <RequestBar title="Sudo password required">
      <RequestBarDescription>{request.prompt}</RequestBarDescription>
      <Input
        autoFocus
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Password"
        type="password"
        value={password}
      />
      <RequestBarActions>
        <Button disabled={!password || sending} onClick={submit} size="sm">
          Submit
        </Button>
        <Button disabled={sending} onClick={() => void send('')} size="sm" variant="outline">
          Cancel
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
