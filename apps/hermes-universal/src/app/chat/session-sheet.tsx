import { useEffect, useState } from 'react'

import { SessionRow } from '@/app/chat/session-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useStore } from '@/store/atom'
import {
  $activeStoredSessionId,
  $searchLoading,
  $sessions,
  $sessionSearch,
  $sessionsLoading,
  $sessionsTotal,
  loadMoreSessions,
  openSession,
  refreshSessions,
  searchSessionsQuery
} from '@/store/session'
import type { SessionSearchResult } from '@/types/hermes'

function SearchRow({ result, onOpen }: { result: SessionSearchResult; onOpen: () => void }) {
  return (
    <button
      className="w-full rounded-md px-3 py-2.5 text-start hover:bg-accent"
      onClick={() => {
        void openSession(result.session_id)
        onOpen()
      }}
      type="button"
    >
      <div className="truncate text-sm text-foreground">{result.snippet || 'Untitled'}</div>
      {(result.role || result.model) && (
        <div className="text-xs text-muted-foreground">{[result.role, result.model].filter(Boolean).join(' · ')}</div>
      )}
    </button>
  )
}

export function SessionSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const sessions = useStore($sessions)
  const loading = useStore($sessionsLoading)
  const total = useStore($sessionsTotal)
  const activeId = useStore($activeStoredSessionId)
  const searchResults = useStore($sessionSearch)
  const searching = useStore($searchLoading)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) {
      void refreshSessions()
    }
  }, [open])

  useEffect(() => {
    const timer = setTimeout(() => void searchSessionsQuery(query), 200)

    return () => clearTimeout(timer)
  }, [query])

  const isSearching = query.trim().length > 0
  const close = () => onOpenChange(false)

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-80 max-w-[85%] gap-0 p-0" side="left">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
        </SheetHeader>
        <div className="px-3 pb-2">
          <Input onChange={e => setQuery(e.target.value)} placeholder="Search conversations…" value={query} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isSearching ? (
            <>
              {searching && searchResults.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">Searching…</div>
              )}
              {!searching && searchResults.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No matches.</div>
              )}
              {searchResults.map(r => (
                <SearchRow key={r.session_id} onOpen={close} result={r} />
              ))}
            </>
          ) : (
            <>
              {loading && sessions.length === 0 && <div className="p-3 text-sm text-muted-foreground">Loading…</div>}
              {!loading && sessions.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No conversations yet.</div>
              )}
              {sessions.map(s => (
                <SessionRow active={s.id === activeId} key={s.id} onOpen={close} session={s} />
              ))}
              {sessions.length < total && (
                <Button className="mt-1 w-full" onClick={() => void loadMoreSessions()} variant="text">
                  Load more
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
