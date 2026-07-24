import { FilesPane } from '@/app/contrib/panes'
import { MobileStatusList } from '@/app/shell/mobile-status-list'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { persistentAtom } from '@/lib/persisted'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'

const TABS = [
  { id: 'status', label: 'Status' },
  { id: 'files', label: 'Files' }
] as const

type TabId = (typeof TABS)[number]['id']

// Remember the last-open tab across drawer opens, defaulting to Status — people
// check status more than files. The codec validates the persisted value to the
// tab union.
const $rightDrawerTab = persistentAtom<TabId>('hermes.rightDrawerTab', 'status', {
  decode: raw => (raw === 'files' ? 'files' : 'status'),
  encode: value => value
})

// The mobile right drawer's content: a two-tab panel switched by the Hermes
// SegmentedControl (the shared tinted-track / raised-active-pill switcher used in
// Command Center / Settings / Pet), so the tabs read as native.
//   • Status — the status-bar options, grouped into sections.
//   • Files  — the file explorer (reuses the desktop FilesPane / RightSidebarPane;
//     shows "No project open" until the session has a cwd).
// Safe-area padded top + bottom so the switcher and tree clear the status bar /
// home indicator; the surface bg fills to the edges.
export function MobileRightPanel() {
  const tab = useStore($rightDrawerTab)

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)"
      style={{ paddingTop: 'var(--safe-area-inset-top)', paddingBottom: 'var(--safe-area-inset-bottom)' }}
    >
      <div className="shrink-0 border-b border-(--ui-stroke-tertiary) p-2">
        <SegmentedControl className="w-full" onChange={id => $rightDrawerTab.set(id)} options={TABS} value={tab} />
      </div>

      {/* Both panels stay mounted; the inactive one is hidden so the file tree's
          expand/scroll state survives a tab switch. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', tab !== 'status' && 'hidden')}>
        <MobileStatusList />
      </div>
      <div className={cn('min-h-0 flex-1 overflow-hidden', tab !== 'files' && 'hidden')}>
        <FilesPane />
      </div>
    </div>
  )
}
