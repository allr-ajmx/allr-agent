import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { respondSecret, type SecretRequest } from '@/store/chat'

export function SecretBar({ request, sessionKey }: { request: SecretRequest; sessionKey: string }) {
  const [value, setValue] = useState('')

  const submit = () => {
    if (value) {
      void respondSecret(value, sessionKey)
    }
  }

  return (
    <RequestBar title={`Secret required${request.envVar ? `: ${request.envVar}` : ''}`}>
      {request.prompt && <RequestBarDescription>{request.prompt}</RequestBarDescription>}
      <Input
        autoFocus
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder={request.envVar || 'Value'}
        type="password"
        value={value}
      />
      <RequestBarActions>
        <Button disabled={!value} onClick={submit} size="sm">
          Submit
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
