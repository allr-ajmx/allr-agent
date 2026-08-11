import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button, type buttonVariants } from '@/components/ui/button'
import { type ApprovalChoice, type ApprovalRequest, respondApproval } from '@/store/chat'
import { notifyError } from '@/store/notifications'

type Variant = NonNullable<Parameters<typeof buttonVariants>[0]>['variant']

const CHOICES: { choice: ApprovalChoice; label: string; variant: Variant }[] = [
  { choice: 'once', label: 'Allow once', variant: 'default' },
  { choice: 'session', label: 'Allow session', variant: 'secondary' },
  { choice: 'always', label: 'Always', variant: 'secondary' },
  { choice: 'deny', label: 'Deny', variant: 'destructive' }
]

export function ApprovalBar({ request, sessionKey }: { request: ApprovalRequest; sessionKey: string }) {
  // The bar no longer vanishes on click — `respondApproval` keeps the request
  // until the gateway has taken the answer and throws otherwise (MJXHRM-418).
  // A swallowed rejection used to read as "accepted" while the agent stayed
  // parked until its five-minute timeout, with the prompt gone and no way back.
  const [sending, setSending] = useState(false)

  const answer = async (choice: ApprovalChoice) => {
    setSending(true)

    try {
      await respondApproval(choice, sessionKey)
    } catch (error) {
      notifyError(error, 'Approval failed to send')
    } finally {
      setSending(false)
    }
  }

  // Which of the four buttons the gateway will actually honor. Desktop applies
  // the same rules in components/assistant-ui/tool/approval.tsx: an explicit
  // `choices` list wins, a smart-denied command collapses to once/deny, and
  // `allowPermanent: false` (tirith warning) hides "Always".
  const choices = request.choices ?? (request.smartDenied ? ['once', 'deny'] : undefined)
  const allowSession = choices ? choices.includes('session') : true
  const allowAlways = choices ? choices.includes('always') : request.allowPermanent

  const allowed = (choice: ApprovalChoice): boolean => {
    if (choice === 'always') {
      return allowAlways
    }

    if (choice === 'session') {
      return allowSession
    }

    return true
  }

  return (
    <RequestBar title="Approval needed">
      <RequestBarDescription mono>{request.command || request.description}</RequestBarDescription>
      <RequestBarActions>
        {CHOICES.filter(c => allowed(c.choice)).map(c => (
          <Button
            disabled={sending}
            key={c.choice}
            onClick={() => {
              void answer(c.choice)
            }}
            size="sm"
            variant={c.variant}
          >
            {c.label}
          </Button>
        ))}
      </RequestBarActions>
    </RequestBar>
  )
}
