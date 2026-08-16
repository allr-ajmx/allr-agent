/**
 * These frames park a running agent tool for 30-45s, so the property that
 * matters is not "we answer well" but "we ALWAYS answer" — including with no
 * reader registered, and when the reader throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted, not a bare `let`: the module under test registers its listener at
// IMPORT time, so the mock factory runs before a normal top-level binding is
// initialised.
const stream = vi.hoisted(() => ({ route: null as ((event: { payload?: unknown; type: string }) => void) | null }))

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: (listener: (event: { payload?: unknown; type: string }) => void) => {
    stream.route = listener

    return () => {
      stream.route = null
    }
  },
  requestGateway: vi.fn().mockResolvedValue({ status: 'ok' })
}))

import { requestGateway } from '@/store/gateway'

import { __resetAgentReadRequests, registerPreviewReader, registerWindowBelowReader } from './agent-read-requests'

const rpc = vi.mocked(requestGateway)

const send = (type: string, payload: Record<string, unknown>) => stream.route?.({ type, payload })

/** The responder answers off a promise chain, so let the microtasks drain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  __resetAgentReadRequests()
  rpc.mockClear()
  rpc.mockResolvedValue({ status: 'ok' })
})

afterEach(() => __resetAgentReadRequests())

describe('preview.read.request', () => {
  it('answers empty when nothing is registered, rather than stalling the tool', async () => {
    send('preview.read.request', { request_id: 'r1' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r1', text: '' })
  })

  it('serialises the reader result as JSON and forwards the tool windowing', async () => {
    const reader = vi.fn().mockResolvedValue({ text: 'hello', title: 'Docs' })
    registerPreviewReader(reader)

    send('preview.read.request', { request_id: 'r2', start: 10, count: 200 })
    await settle()

    expect(reader).toHaveBeenCalledWith({ start: 10, count: 200 })
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', {
      request_id: 'r2',
      text: '{"text":"hello","title":"Docs"}'
    })
  })

  it('passes undefined windowing through when the tool asked for the whole page', async () => {
    const reader = vi.fn().mockReturnValue(null)
    registerPreviewReader(reader)

    send('preview.read.request', { request_id: 'r3' })
    await settle()

    expect(reader).toHaveBeenCalledWith({ start: undefined, count: undefined })
  })

  it('answers empty when the reader throws (a surface still booting)', async () => {
    registerPreviewReader(() => {
      throw new Error('webview not ready')
    })

    send('preview.read.request', { request_id: 'r4' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r4', text: '' })
  })

  it('ignores a frame with no request_id — there is nothing to answer', async () => {
    send('preview.read.request', {})
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('window.read.request', () => {
  it('answers on its own method, empty when the platform cannot enumerate windows', async () => {
    send('window.read.request', { request_id: 'w1' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'w1', text: '' })
  })

  it('serialises a registered reader answer', async () => {
    registerWindowBelowReader(() => ({ platform: 'linux', window: { app: 'Firefox' } }))

    send('window.read.request', { request_id: 'w2' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', {
      request_id: 'w2',
      text: '{"platform":"linux","window":{"app":"Firefox"}}'
    })
  })
})

describe('expiry', () => {
  it('drops a request the tool already gave up on instead of answering into the void', async () => {
    let release: (value: unknown) => void = () => {}
    registerPreviewReader(() => new Promise(resolve => void (release = resolve)))

    send('preview.read.request', { request_id: 'r5' })
    send('preview.read.expire', { request_id: 'r5' })
    release({ text: 'too late' })
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })

  it('leaves an unrelated in-flight request alone', async () => {
    send('window.read.expire', { request_id: 'other' })
    send('window.read.request', { request_id: 'w3' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'w3', text: '' })
  })
})

describe('reader registration', () => {
  it('unregisters idempotently, so a stale disposer cannot unseat a newer reader', async () => {
    const first = vi.fn().mockReturnValue({ a: 1 })
    const dispose = registerPreviewReader(first)
    const second = vi.fn().mockReturnValue({ b: 2 })
    registerPreviewReader(second)

    dispose()
    send('preview.read.request', { request_id: 'r6' })
    await settle()

    expect(second).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r6', text: '{"b":2}' })
  })
})
