import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { NEW_CHAT_ROUTE, sessionRoute } from '@/app/routes'
import { $connectionPhase } from '@/store/connection'
import { $activeStoredSessionId, lastOpenedSessionId, openSession } from '@/store/session'

// Land on the chat you were last in, not an empty one.
//
// A phone cold-starts at "/" every time: there is no window state to restore and
// no address bar to come back to, so the app always opened on a blank new
// session and the conversation you were in the middle of was three taps deep in
// the sidebar. `store/session` records the last real session id on every switch;
// this spends it, once.
//
// It has to wait for the gateway, because opening a session is a `session.resume`
// round trip — running it at mount would just fail. And it must fire ONCE per
// launch: a later reconnect (a gateway switch, a dropped socket) also brings the
// phase back to `ready`, and re-running there would drag the user out of whatever
// chat they had since opened.
export function useRestoreLastSession(): void {
  const navigate = useNavigate()
  const done = useRef(false)
  // Read through a ref, not a dep: the effect must not re-arm on navigation, and
  // the router's location is the real one — under HashRouter `window.location`
  // reports "/" whatever route is showing.
  const { pathname } = useLocation()
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  useEffect(() => {
    if (done.current) {
      return
    }

    // nanostores calls a new listener immediately, so this covers the case where
    // the gateway was already up before we mounted.
    return $connectionPhase.subscribe(phase => {
      if (done.current || phase !== 'ready') {
        return
      }

      done.current = true

      const id = lastOpenedSessionId()

      // Only from a standing start. Anything already open — a deep link, a chat
      // the user opened while we were still connecting — outranks a memory.
      if (!id || $activeStoredSessionId.get() || pathnameRef.current !== NEW_CHAT_ROUTE) {
        return
      }

      void Promise.resolve(openSession(id))
        .then(() => navigate(sessionRoute(id)))
        // A session that has since been deleted leaves nothing to restore; the
        // blank new chat already on screen is the right fallback.
        .catch(() => undefined)
    })
  }, [navigate])
}
