import { beforeEach, describe, expect, it } from 'vitest'

import type { WebhookCreateResponse } from '@/hermes'

import {
  $pendingWebhookSecrets,
  acknowledgeWebhookSecret,
  markWebhookSecretCopied,
  nextPendingWebhookSecret,
  pendingWebhookSecretFor,
  rememberWebhookSecret,
  resetPendingWebhookSecrets
} from './pending-secret'

const created = (name: string, secret = `secret-${name}`): WebhookCreateResponse =>
  ({
    created_at: null,
    deliver: 'log',
    deliver_only: false,
    description: '',
    enabled: true,
    events: [],
    name,
    prompt: '',
    script: '',
    secret,
    secret_set: true,
    skills: [],
    url: `http://localhost:8644/webhooks/${name}`
  }) satisfies WebhookCreateResponse

beforeEach(() => resetPendingWebhookSecrets())

// `POST /api/webhooks` is the ONLY place the secret exists in the clear. Every
// rule below is a way it used to be able to disappear.
describe('the one-time webhook secret', () => {
  it('is held outside the component tree, so it survives the surface unmounting', () => {
    rememberWebhookSecret(created('github-push'))

    // Nothing here re-renders anything; the value is reachable from module state.
    expect(nextPendingWebhookSecret()?.secret).toBe('secret-github-push')
    expect(pendingWebhookSecretFor('github-push')?.url).toContain('/webhooks/github-push')
  })

  // The load-bearing rule. Dismissing the dialog, closing the overlay, or
  // navigating away must not be able to drop it: only the explicit "I have saved
  // it" button calls `acknowledgeWebhookSecret`.
  it('is dropped by acknowledgement and by nothing else', () => {
    rememberWebhookSecret(created('github-push'))

    // Stand-ins for every non-acknowledging exit: they touch other state and
    // leave the secret alone.
    markWebhookSecretCopied('github-push')
    nextPendingWebhookSecret()
    pendingWebhookSecretFor('github-push')

    expect($pendingWebhookSecrets.get()).toHaveLength(1)

    acknowledgeWebhookSecret('github-push')

    expect($pendingWebhookSecrets.get()).toEqual([])
  })

  it('acknowledging one subscription leaves another one pending', () => {
    rememberWebhookSecret(created('a'))
    rememberWebhookSecret(created('b'))

    acknowledgeWebhookSecret('a')

    expect($pendingWebhookSecrets.get().map(entry => entry.name)).toEqual(['b'])
  })

  // A second create while the first secret is still unacknowledged used to be a
  // silent overwrite when this was a single slot.
  it('queues a second secret instead of overwriting the first', () => {
    rememberWebhookSecret(created('first'))
    rememberWebhookSecret(created('second'))

    expect($pendingWebhookSecrets.get().map(entry => entry.secret)).toEqual(['secret-first', 'secret-second'])
    expect(nextPendingWebhookSecret()?.name).toBe('first')
  })

  // Re-creating the SAME name rewrites the route, so the older secret is dead —
  // keeping it would offer the user a value that no longer verifies anything.
  it('replaces the entry when the same name is created again', () => {
    rememberWebhookSecret(created('dup', 'old'))
    rememberWebhookSecret(created('dup', 'new'))

    expect($pendingWebhookSecrets.get()).toHaveLength(1)
    expect(nextPendingWebhookSecret()?.secret).toBe('new')
  })

  // A copy can be overwritten before it is pasted, so copying is progress, not
  // completion — the acknowledgement is still the user's to give.
  it('records a successful copy without clearing the secret', () => {
    rememberWebhookSecret(created('github-push'))

    expect(pendingWebhookSecretFor('github-push')?.copied).toBe(false)

    markWebhookSecretCopied('github-push')

    expect(pendingWebhookSecretFor('github-push')?.copied).toBe(true)
    expect($pendingWebhookSecrets.get()).toHaveLength(1)
  })

  // A caller-supplied secret comes back on the response too, but a response with
  // no secret at all must not push an empty entry the dialog would then show.
  it('ignores a response that carries no secret', () => {
    rememberWebhookSecret({ ...created('x'), secret: '' })

    expect($pendingWebhookSecrets.get()).toEqual([])
  })
})
