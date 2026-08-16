/**
 * What the Projects surface does against a gateway that predates `projects.*`.
 *
 * This is the branch MJXHRM-411 was filed over and PR #138 changed, and nothing
 * covered it: `$projectsRpcAvailable` going false is what swaps the sidebar to
 * session-derived projects and what makes `createProject` refuse with the
 * stale-backend copy instead of a raw RPC error. It has to fire on the gateway's
 * -32601 whatever the message says, and it has to STAY unset for a real failure,
 * because nothing ever sets it back to false-is-wrong: one bad read latches the
 * degraded surface for the rest of the connection.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayRpcError } from '@/gateway/rpc-error'
import type * as GatewayModule from '@/store/gateway'

const { requestGateway } = vi.hoisted(() => ({ requestGateway: vi.fn() }))

// Partial mock: store/connection subscribes to `$gatewayState` at import time,
// so the real module has to stay underneath.
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

import { $projects, $projectsRpcAvailable, createProject, refreshProjects } from './projects'

beforeEach(() => {
  requestGateway.mockReset()
  $projects.set([])
  $projectsRpcAvailable.set(null)
})

describe('projects on an older gateway', () => {
  it('marks the surface unavailable on a bare -32601, whatever the gateway called it', async () => {
    requestGateway.mockRejectedValue(new GatewayRpcError('the requested procedure does not exist', -32601))

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBe(false)
  })

  it('still recognises the message when the rejection carries no code', async () => {
    requestGateway.mockRejectedValue(new Error('unknown method: projects.list'))

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBe(false)
  })

  it('leaves the surface alone when the call failed for a real reason', async () => {
    requestGateway.mockRejectedValue(new GatewayRpcError('projects.db is locked', 5061))

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBeNull()
  })

  it('refuses a create with the stale-backend copy rather than the raw RPC error', async () => {
    requestGateway.mockRejectedValue(new GatewayRpcError('unknown method: projects.create', -32601))

    // The dialog renders whatever this throws, so it must be the copy that tells
    // the user to update their backend, not the wire message.
    await expect(createProject({ folders: ['/www/app'], name: 'App' })).rejects.toThrow(
      /Update the Hermes backend to create projects/
    )
    expect($projectsRpcAvailable.get()).toBe(false)
  })
})
