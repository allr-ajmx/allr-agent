import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// Type-only, so these are erased and cannot trip vi.mock's hoisting.
import type * as RouterModule from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NotificationsModule from '@/store/notifications'
import type * as SessionModule from '@/store/session'

// TileWindowRoot hosts exactly one tile. With no `?tile=` in the URL — the legacy
// `?win=secondary` pop-out shape, and what jsdom gives us here — it routes to the
// CHAT host, which is pinned to ONE session by its route. When another WebView
// switches gateway this window re-homes, and sessions are per-backend, so the chat
// it is showing usually does not exist on the gateway it just landed on.

const navigate = vi.fn()

vi.mock('react-router-dom', async importActual => ({
  ...(await importActual<typeof RouterModule>()),
  useNavigate: () => navigate
}))
vi.mock('@/app/chat/chat-screen', () => ({ ChatScreen: () => <div>chat</div> }))
vi.mock('@/app/chat/chat-title', () => ({ ChatTitle: () => <div>title</div> }))
vi.mock('@/app/shell/window-controls', () => ({ WindowControls: () => null }))
vi.mock('@/components/notifications', () => ({ NotificationStack: () => null }))
// Partial: the tile window imports the contribution controller (for its
// module-scope tile registrations), which drags in the plugin SDK — and that
// wants `notifyError` too.
vi.mock('@/store/notifications', async importActual => ({
  ...(await importActual<typeof NotificationsModule>()),
  notify: vi.fn()
}))
vi.mock('@/store/gateway-soft-switch', () => ({ sessionMissingFromCurrentGateway: vi.fn() }))
// Partial: session-states/chat-bubbles reach for other exports through the import
// graph, so replacing the whole module breaks the render.
vi.mock('@/store/session', async importActual => ({
  ...(await importActual<typeof SessionModule>()),
  newSession: vi.fn(),
  openSession: vi.fn().mockResolvedValue(undefined),
  refreshSessions: vi.fn().mockResolvedValue(undefined)
}))

import { $connectionPhase } from '@/store/connection'
import { sessionMissingFromCurrentGateway } from '@/store/gateway-soft-switch'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'
import { newSession, openSession } from '@/store/session'

import { TileWindowRoot } from './tile-window'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TileWindowRoot />
    </MemoryRouter>
  )
}

/**
 * Drive the mounted window through a re-home: another WebView's switch flips
 * $gatewaySwitching up and back down, and this window re-resumes off the far side.
 */
async function reHome() {
  await act(async () => {
    $gatewaySwitching.set(true)
  })
  await act(async () => {
    $gatewaySwitching.set(false)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  $connectionPhase.set('ready')
  $gatewaySwitching.set(false)
  vi.mocked(sessionMissingFromCurrentGateway).mockReturnValue(false)
})

describe('TileWindowRoot chat host — session after a re-home', () => {
  it('resumes its session normally on a cold open', async () => {
    renderAt('/sess-1')

    await waitFor(() => expect(openSession).toHaveBeenCalledWith('sess-1'))
    expect(newSession).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('drops to a new session and says why when the chat is not on the new gateway', async () => {
    renderAt('/sess-1')
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('sess-1'))
    vi.clearAllMocks()

    // Another WebView switched gateway: this window re-homes, and its session is gone.
    vi.mocked(sessionMissingFromCurrentGateway).mockReturnValue(true)
    await reHome()

    await waitFor(() => expect(newSession).toHaveBeenCalledOnce())
    expect(openSession).not.toHaveBeenCalled()
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: 'Gateway changed',
      message: "This session doesn't exist on the new gateway."
    })
    // The dead id must not stay in the route, or the next render resumes it again.
    expect(navigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('resumes the session when it DOES exist on the new gateway', async () => {
    renderAt('/sess-1')
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('sess-1'))
    vi.clearAllMocks()

    await reHome()

    await waitFor(() => expect(openSession).toHaveBeenCalledWith('sess-1'))
    expect(newSession).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('holds the chat mounted while the switch is in flight', () => {
    $connectionPhase.set('connecting')
    $gatewaySwitching.set(true)
    renderAt('/sess-1')

    expect(screen.getByText('chat')).toBeInTheDocument()
  })
})
