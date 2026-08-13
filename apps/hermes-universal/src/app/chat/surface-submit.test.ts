import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChatStoreModule from '@/store/chat'
import { sendPrompt } from '@/store/chat'
import type * as NotificationsModule from '@/store/notifications'
import { notify } from '@/store/notifications'
import { type SessionTileDelegate, sessionTileDelegate, setSessionTileDelegate } from '@/store/session-states'

import type { SessionView } from './session-view'
import { submitPromptToSurface } from './surface-submit'

// Partial: store/session builds `$workingSessionIds` out of `$busy`, so a
// wholesale mock of the chat store takes the whole store graph down with it.
vi.mock('@/store/chat', async importOriginal => ({
  ...(await importOriginal<typeof ChatStoreModule>()),
  sendPrompt: vi.fn(async () => {})
}))
vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notify: vi.fn()
}))

const view = (kind: SessionView['kind'], key: null | string): SessionView =>
  ({ $runtimeId: atom<null | string>(key), kind }) as unknown as SessionView

let submitted: [string, string][]

beforeEach(() => {
  submitted = []
  vi.mocked(sendPrompt).mockClear()
  vi.mocked(notify).mockClear()
  setSessionTileDelegate({
    submitToSession: async (runtimeId: string, text: string) => {
      submitted.push([runtimeId, text])
    }
  } as unknown as SessionTileDelegate)
})

describe('submitPromptToSurface', () => {
  it('sends the primary chat through sendPrompt', async () => {
    await submitPromptToSurface(view('primary', 'sess-1'), 'hello')

    expect(sendPrompt).toHaveBeenCalledWith('hello')
    expect(submitted).toEqual([])
  })

  // The whole point of the helper. `sendPrompt` writes to `$activeSessionKey`
  // and refuses on the FOREGROUND chat's `$busy`, so a tile routed through it
  // opened its turn on the wrong conversation — or silently on none at all
  // (MJXHRM-419).
  it('sends a tile through the delegate, keyed to the tile', async () => {
    await submitPromptToSurface(view('tile', 'tile-1'), 'hello')

    expect(submitted).toEqual([['tile-1', 'hello']])
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  // The composer clears the draft BEFORE it calls this, so a quiet return is
  // how a message vanishes with nothing said about it.
  it('says so when the tile has no live session', async () => {
    await submitPromptToSurface(view('tile', null), 'hello')

    expect(submitted).toEqual([])
    expect(vi.mocked(notify).mock.calls[0]?.[0]).toMatchObject({ kind: 'error' })
  })

  it('says so when no delegate has registered', async () => {
    setSessionTileDelegate(null as unknown as SessionTileDelegate)

    await submitPromptToSurface(view('tile', 'tile-1'), 'hello')

    expect(sessionTileDelegate()).toBeNull()
    expect(vi.mocked(notify).mock.calls[0]?.[0]).toMatchObject({ kind: 'error' })
  })
})
