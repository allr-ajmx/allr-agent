import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { respondSecret, type SecretRequest } from '@/store/chat'
import { notify, notifyError } from '@/store/notifications'

export function SecretBar({ request, sessionKey }: { request: SecretRequest; sessionKey: string }) {
  const [value, setValue] = useState('')
  // Kept answerable on failure, like the sudo and approval bars (MJXHRM-418).
  const [sending, setSending] = useState(false)

  const submit = async () => {
    if (!value) {
      return
    }

    setSending(true)

    try {
      // `secret.respond` is `allow_expired` like sudo's: a value that arrives
      // after the tool stopped waiting is accepted and discarded. Reporting that
      // as sent is how a secret disappears with the UI saying it landed.
      if ((await respondSecret(value, sessionKey)) === 'expired') {
        notify({
          kind: 'warning',
          message: 'That secret prompt had already timed out — the tool gave up, so the value was not used.'
        })
      }
    } catch (error) {
      notifyError(error, 'Secret failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <RequestBar title={`Secret required${request.envVar ? `: ${request.envVar}` : ''}`}>
      {request.prompt && <RequestBarDescription>{request.prompt}</RequestBarDescription>}
      <Input
        autoFocus
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && void submit()}
        placeholder={request.envVar || 'Value'}
        type="password"
        value={value}
      />
      <RequestBarActions>
        <Button disabled={!value || sending} onClick={() => void submit()} size="sm">
          Submit
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
