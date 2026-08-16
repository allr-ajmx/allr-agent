import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { normalizeWebhookName, readableCreateError, splitWebhookList, webhookCreateError } from './create-model'

const w = en.webhooks

// Each of these mirrors a 400 from `create_webhook` (hermes_cli/web_server.py).
// The point of restating them client-side is that the user never has to learn
// the rule from an HTTP error — so the tests assert the rule, not the wording.
describe('webhook name normalisation', () => {
  it('matches the backend: trim, lowercase, spaces to hyphens', () => {
    expect(normalizeWebhookName('  My Hook  ')).toBe('my-hook')
    expect(normalizeWebhookName('GitHub Push')).toBe('github-push')
  })

  it('leaves an already-normal name alone', () => {
    expect(normalizeWebhookName('github-push')).toBe('github-push')
  })
})

describe('create validation', () => {
  const draft = { deliver: 'log', deliverOnly: false, name: 'github-push' }

  it('accepts a valid draft', () => {
    expect(webhookCreateError(draft, w)).toBeNull()
  })

  it('rejects an empty name', () => {
    expect(webhookCreateError({ ...draft, name: '   ' }, w)).toBe(w.nameRequired)
  })

  it('rejects a name the backend pattern would reject, after normalising', () => {
    // Leading hyphen, and characters outside [a-z0-9_-].
    expect(webhookCreateError({ ...draft, name: '-lead' }, w)).toBe(w.nameInvalid)
    expect(webhookCreateError({ ...draft, name: 'hé/llo' }, w)).toBe(w.nameInvalid)
  })

  it('accepts a name that only becomes valid after normalising', () => {
    expect(webhookCreateError({ ...draft, name: 'My Hook' }, w)).toBeNull()
  })

  // The backend answers this pair with "Direct delivery requires a real target
  // (telegram, discord, …), not 'log'." Desktop's form can send it.
  it('rejects deliver-only against the log target', () => {
    expect(webhookCreateError({ ...draft, deliverOnly: true }, w)).toBe(w.deliverOnlyNeedsTarget)
  })

  it('allows deliver-only against a real target', () => {
    expect(webhookCreateError({ deliver: 'telegram', deliverOnly: true, name: 'github-push' }, w)).toBeNull()
  })
})

describe('create failures stay legible', () => {
  it('lifts the backend detail out of an ApiError message', () => {
    const err = new Error('POST /api/webhooks → HTTP 400: {"detail":"Webhook platform is not enabled."}')

    expect(readableCreateError(err)).toBe('Webhook platform is not enabled.')
  })

  it('falls back to the whole message when there is no detail', () => {
    expect(readableCreateError(new Error('Not connected to a Hermes backend'))).toBe(
      'Not connected to a Hermes backend'
    )
  })
})

describe('comma lists', () => {
  it('trims and drops empties', () => {
    expect(splitWebhookList(' push , , pull_request ')).toEqual(['push', 'pull_request'])
  })

  it('is empty for an empty string', () => {
    expect(splitWebhookList('')).toEqual([])
  })
})
