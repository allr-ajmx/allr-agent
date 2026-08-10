import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { respondSecret, type SecretRequest } from '@/store/chat'
import { notifyError } from '@/store/notifications'

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
      await respondSecret(value, sessionKey)
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
