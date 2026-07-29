import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { respondSudo, type SudoRequest } from '@/store/chat'

export function SudoBar({ request, sessionKey }: { request: SudoRequest; sessionKey: string }) {
  const [password, setPassword] = useState('')

  const submit = () => {
    if (password) {
      void respondSudo(password, sessionKey)
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
        <Button disabled={!password} onClick={submit} size="sm">
          Submit
        </Button>
        <Button onClick={() => void respondSudo('', sessionKey)} size="sm" variant="outline">
          Cancel
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
