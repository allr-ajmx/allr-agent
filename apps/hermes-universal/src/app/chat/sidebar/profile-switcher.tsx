import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { CodeEditor } from '@/components/chat/code-editor'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ColorSwatches } from '@/components/ui/color-swatches'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip, Tooltip, TooltipContent, TooltipScope, TooltipTrigger } from '@/components/ui/tooltip'
import { getProfileSoul, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { createLongPress } from '@/lib/long-press'
import { IS_MOBILE } from '@/lib/platform'
import { PROFILE_SWATCHES, profileColorSoft, resolveProfileColor } from '@/lib/profile-color'
import {
  REORDER_DRAG_TRANSITION_CSS,
  REORDER_RAIL_TRANSITION,
  reorderCommitHaptic,
  reorderStepHaptic
} from '@/lib/reorder'
import { TAP_SLOP_PX } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { notify, notifyError } from '@/store/notifications'
import {
  $activeGatewayProfile,
  $profileColors,
  $profileCreateRequest,
  $profileOrder,
  $profileScope,
  ALL_PROFILES,
  normalizeProfileKey,
  refreshProfiles,
  selectProfile,
  setProfileColor,
  setProfileOrder,
  setShowAllProfiles,
  sortByProfileOrder
} from '@/store/profile'
import { $profiles } from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

import { CreateProfileDialog } from '../../profiles/create-profile-dialog'
import { DeleteProfileDialog } from '../../profiles/delete-profile-dialog'
import { RenameProfileDialog } from '../../profiles/rename-profile-dialog'
import { PROFILES_ROUTE } from '../../routes'

const RAIL_GAP = 4 // px — matches gap-1 between squares.

// Past this many named profiles the squares stop scaling (tiny drag targets,
// endless horizontal scroll), so the tail spills into the "⌄" overflow popover
// instead. Drag-reorder, long-press-recolor and the context menu stay on the
// inline squares — the rail never degrades into a text control.
//
// Higher on a phone: the rail is a footer inside a 19rem pane on the desktop,
// but the full width of the screen at the top of the phone's sidebar surface,
// so it has the room for most people's whole profile set without a popover.
export const RAIL_VISIBLE_LIMIT = IS_MOBILE ? 7 : 4

// The letter that stands in for a profile inside its colored square.
function profileInitial(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').charAt(0) || '?'
}

// Neighbors reflow on RAIL_TRANSITION; the dragged square glides between
// snapped cells on the snappier DRAG_TRANSITION. Both come from the SHARED
// reorder primitive (lib/reorder.ts) so every reorder strip feels identical.
const RAIL_TRANSITION = REORDER_RAIL_TRANSITION
const DRAG_TRANSITION = REORDER_DRAG_TRANSITION_CSS

// The rail is a single horizontal strip of fixed cells. Pin drags to the x-axis
// (no cross-axis scrollbar), snap to whole cells so a square steps slot-to-slot
// instead of gliding, and clamp to the occupied strip so it can't float past the
// last profile onto the "+".
const stepThroughCells: Modifier = ({ containerNodeRect, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !containerNodeRect) {
    return { ...transform, y: 0 }
  }

  const pitch = draggingNodeRect.width + RAIL_GAP
  const minX = containerNodeRect.left - draggingNodeRect.left
  const maxX = containerNodeRect.right - draggingNodeRect.right
  const snapped = Math.round(transform.x / pitch) * pitch

  return { ...transform, x: Math.min(maxX, Math.max(minX, snapped)), y: 0 }
}

// Wheel deltas arrive in three units. Chromium (desktop's only target) always
// sends pixels, so desktop adds deltaY straight to scrollLeft; WebKitGTK — which
// renders universal's desktop build — can report DOM_DELTA_LINE, where a notch is
// ±1 and the untranslated add reads as a dead rail. Normalize before scrolling.
function wheelStep(event: WheelEvent, el: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * el.clientWidth
  }

  return event.deltaY
}

// Arc-Spaces-style profile rail at the sidebar foot: a default↔all toggle pinned
// left, the colored named profiles scrolling between, and Manage pinned right.
// The active profile pops in its own color — the "where am I" cue. Single-
// profile users see the "+" (create their first profile) and the Manage
// overflow (edit the default profile's SOUL.md); the colored named squares
// and the default↔all toggle only appear once a second profile exists.
//
// Ported from desktop `profile-switcher.tsx` (MJX-108). Desktop's hover-intent
// `useProfilePrewarm` is deliberately dropped: it warms Electron's per-profile
// backend *process* pool, and universal re-scopes REST against one gateway, so
// there is nothing to spawn ahead of the click.
export function ProfileRail() {
  const { t } = useI18n()
  const p = t.profiles
  const profiles = useStore($profiles)
  const scope = useStore($profileScope)
  const gatewayProfile = useStore($activeGatewayProfile)
  const order = useStore($profileOrder)
  const colors = useStore($profileColors)
  const navigate = useNavigate()

  const [createOpen, setCreateOpen] = useState(false)
  const [pendingRename, setPendingRename] = useState<null | ProfileInfo>(null)
  const [pendingDelete, setPendingDelete] = useState<null | ProfileInfo>(null)
  const [pendingSoul, setPendingSoul] = useState<null | string>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // A drag that starts in the overflow grid has to travel down out of the
  // popover, so it can't wear the rail's axis lock.
  const [dragFromOverflow, setDragFromOverflow] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // A plain mouse wheel only emits deltaY; map it to horizontal scroll so the
  // rail is navigable without a trackpad. Trackpad x-scroll (deltaX) passes
  // through. Native + non-passive so we can preventDefault and not bleed the
  // gesture into the sessions list above.
  useEffect(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return
      }

      el.scrollLeft += wheelStep(event, el)
      event.preventDefault()
    }

    el.addEventListener('wheel', onWheel, { passive: false })

    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const isAll = scope === ALL_PROFILES
  const activeKey = normalizeProfileKey(gatewayProfile)
  const defaultProfile = profiles.find(profile => profile.is_default)
  const onDefault = !isAll && activeKey === 'default'

  const named = sortByProfileOrder(
    profiles.filter(profile => !profile.is_default),
    order
  )

  const multiProfile = profiles.length > 1

  // Rail order decides who stays inline; the tail spills into the overflow
  // popover. The active profile is the one exception — it is pulled back out of
  // the spill onto the rail (and out of the menu) so "where am I" is always
  // visible, landing in its own slot just left of the "⌄".
  const overflowing = named.length > RAIL_VISIBLE_LIMIT
  const inline = overflowing ? named.slice(0, RAIL_VISIBLE_LIMIT) : named
  const spilled = overflowing ? named.slice(RAIL_VISIBLE_LIMIT) : []
  const hoisted = spilled.find(entry => !isAll && normalizeProfileKey(entry.name) === activeKey) ?? null
  const hidden = hoisted ? spilled.filter(entry => entry !== hoisted) : spilled

  // distance constraint: a small drag reorders, a tap still selects the profile.
  // The rail owns these rather than sharing the sidebar's `dndSensors`: the
  // activation distance differs, and the sessions list adds vertical autoScroll
  // this horizontal strip must not inherit.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: TAP_SLOP_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Tick a haptic each time the drag crosses into a new cell, and a satisfying
  // confirm on a committed reorder.
  const lastOverRef = useRef<string | null>(null)

  const handleDragStart = ({ active }: DragStartEvent) => {
    lastOverRef.current = String(active.id)
    setDragging(true)
    setDragFromOverflow(hidden.some(entry => entry.name === String(active.id)))
  }

  const handleDragCancel = () => {
    lastOverRef.current = null
    setDragging(false)
    setDragFromOverflow(false)
  }

  const handleDragOver = ({ over }: DragOverEvent) => {
    const id = over ? String(over.id) : null

    if (id && id !== lastOverRef.current) {
      lastOverRef.current = id
      reorderStepHaptic()
    }
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    lastOverRef.current = null
    setDragging(false)
    setDragFromOverflow(false)

    if (!over || active.id === over.id) {
      return
    }

    const ids = named.map(profile => profile.name)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))

    if (from >= 0 && to >= 0) {
      setProfileOrder(arrayMove(ids, from, to))
      reorderCommitHaptic()
    }
  }

  // Re-pull the profile list on mount so a profile created elsewhere shows up;
  // cheap and best-effort. (Desktop probes /api/profiles/active for the running
  // backend's profile too; universal's `$activeProfile` IS that source of truth.)
  useEffect(() => {
    void refreshProfiles().catch(() => undefined)
  }, [])

  // Open the create dialog when the `profile.create` hotkey fires (the dialog
  // state lives here, so the global keybind bumps a request atom we watch).
  const createRequest = useStore($profileCreateRequest)
  const lastCreateRef = useRef(createRequest)

  useEffect(() => {
    if (createRequest === lastCreateRef.current) {
      return
    }

    lastCreateRef.current = createRequest
    setCreateOpen(true)
  }, [createRequest])

  const reloadProfiles = async () => void (await refreshProfiles().catch(() => undefined))

  // One square, three homes: the inline strip, the hoisted active slot, and the
  // overflow grid. Sharing the wiring keeps the picker's squares gesture-for-
  // gesture identical to the rail's, and keeps every dialog owned by the rail.
  const renderSquare = (entry: ProfileInfo, opts?: { hoisted?: boolean; overflow?: boolean }) => (
    <ProfileSquare
      active={opts?.hoisted === true || (!isAll && normalizeProfileKey(entry.name) === activeKey)}
      color={resolveProfileColor(entry.name, colors)}
      freeDrag={opts?.overflow}
      key={entry.name}
      label={entry.name}
      onDelete={() => setPendingDelete(entry)}
      onEditSoul={() => setPendingSoul(entry.name)}
      onRecolor={color => setProfileColor(entry.name, color)}
      onRename={() => setPendingRename(entry)}
      onSelect={() => {
        selectProfile(entry.name)

        // Picking from the grid dismisses it; the rail has nothing to dismiss.
        if (opts?.overflow) {
          setOverflowOpen(false)
          triggerHaptic('selection')
        }
      }}
      sortDisabled={opts?.hoisted}
    />
  )

  return (
    <div aria-label={p.title} className="flex items-center gap-0.5" data-slot="profile-rail" role="tablist">
      {/* One button toggles default ↔ all: home face when scoped to a profile,
          layers face when showing everything. Pinned left like Manage is right.
          Hidden until a second profile exists. */}
      {multiProfile &&
        (defaultProfile ? (
          // On default → toggle to all. Anywhere else (all view or a named
          // profile) → return to default. So leaving a profile never lands on all.
          <ProfilePill
            active={isAll || onDefault}
            glyph={isAll ? 'layers' : 'home'}
            label={onDefault ? p.showAllProfiles : p.switchToProfile(defaultProfile.name)}
            onSelect={() => (onDefault ? setShowAllProfiles(true) : selectProfile(defaultProfile.name))}
          />
        ) : (
          <ProfilePill active={isAll} glyph="layers" label={p.allProfiles} onSelect={() => setShowAllProfiles(true)} />
        ))}

      {/* Single-profile: the active default's home icon next to the create +. */}
      {!multiProfile && defaultProfile && (
        <ProfilePill
          active
          glyph="home"
          label={defaultProfile.name}
          onSelect={() => selectProfile(defaultProfile.name)}
        />
      )}

      {multiProfile ? (
        // Renders no DOM, so it can also span the overflow picker without
        // disturbing the flex row — and React context reaches the popover
        // through Radix's portal, putting both grids in one drag space.
        <DndContext
          collisionDetection={closestCenter}
          // The axis lock belongs to rail reorders only: a drag out of the
          // picker has to travel down onto the strip.
          modifiers={dragFromOverflow ? [] : [stepThroughCells]}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragStart={handleDragStart}
          sensors={sensors}
        >
          {/* Only the inline squares are reorder cells — the hoisted one is a
              stand-in for a profile that lives in the overflow menu. */}
          <SortableContext items={inline.map(profile => profile.name)} strategy={horizontalListSortingStrategy}>
            <div
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              ref={scrollRef}
            >
              {/* relative → the strip is the dragged square's offsetParent, so the
                  clamp modifier bounds drags to the occupied cells. */}
              <div className="relative flex items-center gap-1">{inline.map(profile => renderSquare(profile))}</div>
            </div>

            {hoisted && renderSquare(hoisted, { hoisted: true })}
          </SortableContext>

          {overflowing && (
            <ProfileOverflowMenu
              dragging={dragging}
              names={hidden.map(entry => entry.name)}
              onOpenChange={setOverflowOpen}
              open={overflowOpen}
            >
              {hidden.map(entry => renderSquare(entry, { overflow: true }))}
            </ProfileOverflowMenu>
          )}
        </DndContext>
      ) : (
        // No strip to grow: an empty spacer keeps + and Manage pinned right.
        <div className="min-w-0 flex-1" />
      )}

      <AddProfileButton label={p.newProfile} onClick={() => setCreateOpen(true)} />

      {/* Always reachable, even with only the default profile: the manage
          overlay is the only place to edit a profile's SOUL.md, and a
          single-profile user must be able to edit the default's persona
          without first creating a throwaway second profile. */}
      <ProfilePill active={false} glyph="ellipsis" label={p.manageProfiles} onSelect={() => navigate(PROFILES_ROUTE)} />

      {/* Land in the new profile, not stuck on the session you were just in. */}
      <CreateProfileDialog
        onClose={() => setCreateOpen(false)}
        onCreated={async name => {
          await reloadProfiles()
          selectProfile(name)
        }}
        open={createOpen}
        profiles={profiles}
      />

      <RenameProfileDialog
        currentName={pendingRename?.name ?? ''}
        onClose={() => setPendingRename(null)}
        onRenamed={reloadProfiles}
        open={pendingRename !== null}
      />

      <DeleteProfileDialog
        onClose={() => setPendingDelete(null)}
        onDeleted={reloadProfiles}
        open={pendingDelete !== null}
        profile={pendingDelete}
      />

      <EditSoulDialog onClose={() => setPendingSoul(null)} profileName={pendingSoul} />
    </div>
  )
}

// Right-click → Edit SOUL.md for a sidebar profile — the same in-app markdown
// editor as the Profiles overlay, so a profile's persona is editable without
// opening it.
function EditSoulDialog({ onClose, profileName }: { onClose: () => void; profileName: null | string }) {
  const { t } = useI18n()
  const p = t.profiles
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profileName) {
      return
    }

    let cancelled = false
    setLoading(true)
    setContent('')

    getProfileSoul(profileName)
      .then(soul => !cancelled && setContent(soul.content))
      .catch(err => !cancelled && notifyError(err, p.failedLoadSoul))
      .finally(() => !cancelled && setLoading(false))

    return () => void (cancelled = true)
  }, [p, profileName])

  const save = async () => {
    if (!profileName) {
      return
    }

    setSaving(true)

    try {
      await updateProfileSoul(profileName, content)
      notify({ kind: 'success', title: p.soulSaved, message: profileName })
      onClose()
    } catch (err) {
      notifyError(err, p.failedSaveSoul)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && !saving && onClose()} open={profileName !== null}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{profileName} · SOUL.md</DialogTitle>
        </DialogHeader>
        <div className="h-80">
          {!loading && profileName && (
            <CodeEditor
              filePath="SOUL.md"
              framed
              initialValue={content}
              key={profileName}
              onCancel={() => !saving && onClose()}
              onChange={setContent}
              onSave={() => void save()}
            />
          )}
        </div>
        <DialogFooter>
          <Button disabled={saving} onClick={onClose} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={saving || loading} onClick={() => void save()}>
            {saving ? p.saving : p.saveSoul}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The "+" create button, shared by both rail render paths.
function AddProfileButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className="grid size-5 shrink-0 place-items-center rounded-[3px] text-(--ui-text-tertiary) opacity-55 transition hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100"
        onClick={onClick}
        type="button"
      >
        <Codicon name="add" size="0.75rem" />
      </button>
    </Tip>
  )
}

// The rail's tail, once it no longer fits: a chevron that opens the profiles
// that spilled off the strip as the same colored squares, laid out like the
// long-press color picker's swatch grid — so the rail keeps reading as colors
// rather than degrading into a list of names. The squares are the rail's own
// `ProfileSquare`, so every gesture (select, recolor, context menu, drag)
// survives the spill; the grid is a second sortable container in the rail's
// DndContext, which is what lets a square be dragged back onto the strip.
function ProfileOverflowMenu({
  children,
  dragging,
  names,
  onOpenChange,
  open
}: {
  children: ReactNode
  dragging: boolean
  names: string[]
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { t } = useI18n()
  const p = t.profiles

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      {/* Tip renders a provider tree, not a ref-forwarding element, so it wraps
          the trigger rather than being wrapped by it. */}
      <Tip label={p.moreProfiles}>
        <PopoverTrigger asChild>
          <button
            aria-label={p.moreProfiles}
            className="grid size-5 shrink-0 place-items-center rounded-[3px] text-(--ui-text-tertiary) opacity-55 transition hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100 data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground data-[state=open]:opacity-100"
            type="button"
          >
            <Codicon name="chevron-down" size="0.75rem" />
          </button>
        </PopoverTrigger>
      </Tip>

      {/* The rail sits at the very bottom, so pad off the chrome (esp. the
          statusbar) — Radix then flips the grid up instead of squishing it. */}
      <PopoverContent
        align="end"
        aria-label={p.moreProfiles}
        className="w-auto p-2"
        collisionPadding={{ bottom: 44, left: 8, right: 8, top: 8 }}
        // A square dragged onto the rail is released well outside the popover;
        // without this the drop would dismiss the grid mid-gesture.
        onInteractOutside={event => dragging && event.preventDefault()}
        side="top"
      >
        <SortableContext items={names} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-6 gap-1.5">{children}</div>
        </SortableContext>
      </PopoverContent>
    </Popover>
  )
}

interface ProfilePillProps {
  active: boolean
  // home / All / Manage are glyph action buttons (navigation, not identity).
  glyph: string
  label: string
  onSelect: () => void
}

function ProfilePill({ active, glyph, label, onSelect }: ProfilePillProps) {
  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'bg-transparent text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
          active && 'bg-(--ui-control-active-background) text-foreground'
        )}
        onClick={onSelect}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Codicon name={glyph} size="0.875rem" />
      </Button>
    </Tip>
  )
}

interface ProfileSquareProps {
  active: boolean
  color: null | string
  label: string
  onSelect: () => void
  onRecolor: (color: null | string) => void
  onRename: () => void
  onEditSoul: () => void
  onDelete: () => void
  // Overflow-grid squares drag free-form (down onto the rail) rather than
  // snapping cell to cell, so they must track the pointer with no easing.
  freeDrag?: boolean
  // The hoisted active square stands in for a profile that lives in the
  // overflow menu, so it is not one of the strip's reorder cells.
  sortDisabled?: boolean
}

// Hold this long without moving (a drag would have started first) — the "hard
// press" gesture, distinct from tap-to-select. What it opens depends on the
// pointer: see the pointerdown handler below.
const PROFILE_LONG_PRESS_MS = 450

// A profile *is* its colored square — no icon-button chrome. Soft profile-tint
// fill + the initial in the full color; the active one pops to full opacity with
// a color ring. These pack tightly so the rail reads as a strip of profiles,
// drag-sort to reorder (a tap below the drag threshold still selects), and
// right-click (or, on touch, a long press) to rename/delete. The button carries both the tooltip and
// context-menu triggers via nested asChild Slots, so a single element keeps the
// dnd listeners, hover tip, and right-click menu.
function ProfileSquare({
  active,
  color,
  freeDrag,
  label,
  onDelete,
  onEditSoul,
  onRecolor,
  onRename,
  onSelect,
  sortDisabled
}: ProfileSquareProps) {
  const { t } = useI18n()
  const p = t.profiles
  const hue = color ?? 'var(--ui-text-quaternary)'
  const [pickerOpen, setPickerOpen] = useState(false)
  const suppressClick = useRef(false)
  const squareRef = useRef<HTMLButtonElement | null>(null)
  // Which pointer armed the current hold — a mouse and a finger want different
  // things out of it (see below).
  const pressPointer = useRef<string>('mouse')

  const { attributes, isDragging, isOver, listeners, setNodeRef, transform, transition } = useSortable({
    disabled: sortDisabled,
    id: label,
    transition: RAIL_TRANSITION
  })

  // A hold means "more than a tap", but the two pointers reach different things
  // by other means, so it resolves differently:
  //
  //   mouse — right-click already opens the full menu, so the hold stays the
  //           recolor shortcut it has always been.
  //   touch — there is no right-click, so rename / edit soul / delete had no
  //           path at all. The hold opens the context menu instead, and colour
  //           is its first item, so nothing is lost — it costs one more tap.
  //
  // Radix's ContextMenu has no controlled `open`, so the menu is opened the way
  // a mouse opens it: by dispatching the event its trigger listens for, at the
  // point the finger is actually holding.
  const press = useRef(
    createLongPress({
      ms: PROFILE_LONG_PRESS_MS,
      onFire: ({ x, y }) => {
        suppressClick.current = true
        triggerHaptic('success')

        if (pressPointer.current === 'mouse') {
          setPickerOpen(true)

          return
        }

        squareRef.current?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
        )
      }
    })
  ).current

  // A real drag (movement past the dnd threshold) cancels the pending hold, so a
  // reorder never doubles as a color pick. Also tidy up on unmount.
  useEffect(() => {
    if (isDragging) {
      press.cancel()
    }
  }, [isDragging, press])
  useEffect(() => () => press.cancel(), [press])

  const base = CSS.Transform.toString(transform)
  const ring = active ? `inset 0 0 0 1.5px ${hue}` : ''
  const lift = isDragging ? '0 6px 16px -4px rgb(0 0 0 / 0.4)' : ''
  // Cross-container drags (out of the overflow grid) don't open a gap on the
  // strip, so the cell under the pointer says "drop here" itself.
  const dropTarget = isOver && !isDragging ? 'inset 0 0 0 1.5px var(--ui-text-secondary)' : ''

  const pickColor = (next: null | string) => {
    onRecolor(next)
    setPickerOpen(false)
    triggerHaptic('selection')
  }

  return (
    <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
      <ContextMenu>
        <TooltipScope>
          <Tooltip>
            <PopoverAnchor asChild>
              <ContextMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      'grid size-5 shrink-0 cursor-grab touch-none select-none place-items-center rounded-[3px] text-[0.5625rem] font-semibold uppercase leading-none transition-opacity hover:opacity-100',
                      active ? 'opacity-100' : 'opacity-55',
                      sortDisabled && 'cursor-pointer',
                      isOver && !isDragging && 'opacity-100',
                      isDragging && 'z-10 cursor-grabbing opacity-100'
                    )}
                    ref={node => {
                      setNodeRef(node)
                      squareRef.current = node
                    }}
                    style={{
                      backgroundColor: profileColorSoft(hue, active ? 30 : 22),
                      boxShadow: [ring, dropTarget, lift].filter(Boolean).join(', ') || undefined,
                      color: color ?? undefined,
                      // Glide the dragged square between snapped cells with a little
                      // overshoot (no scale — the overflow-x strip would clip it).
                      // A free drag has no cells to glide between, so it tracks the
                      // pointer directly instead of trailing it.
                      transform: base,
                      transition: isDragging ? (freeDrag ? 'none' : DRAG_TRANSITION) : transition
                    }}
                    type="button"
                    {...attributes}
                    {...listeners}
                    aria-label={label}
                    aria-pressed={active}
                    // Hold-to-recolor rides alongside the dnd pointer listener (call
                    // it first so drag tracking still arms), then a timer opens the
                    // picker and flags the trailing click so it doesn't also select.
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false

                        return
                      }

                      onSelect()
                    }}
                    onPointerCancel={() => press.cancel()}
                    onPointerDown={event => {
                      listeners?.onPointerDown?.(event)

                      if (event.button !== 0) {
                        return
                      }

                      suppressClick.current = false
                      pressPointer.current = event.pointerType || 'mouse'
                      press.down(event.clientX, event.clientY)
                    }}
                    // The hold now carries a movement tolerance of its own
                    // rather than relying solely on dnd to cancel it — a finger
                    // that drifts is not holding still.
                    onPointerLeave={() => press.cancel()}
                    onPointerMove={event => press.move(event.clientX, event.clientY)}
                    onPointerUp={() => press.up()}
                  >
                    {profileInitial(label)}
                  </button>
                </TooltipTrigger>
              </ContextMenuTrigger>
            </PopoverAnchor>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </TooltipScope>

        {/* The rail sits at the very bottom, so pad off the chrome (esp. the
            statusbar) — Radix then flips the menu up instead of squishing it. */}
        <ContextMenuContent
          aria-label={p.actionsFor(label)}
          className="w-40"
          collisionPadding={{ bottom: 44, left: 8, right: 8, top: 8 }}
          // Menu close refocuses the trigger — which doubles as the popover
          // anchor — so the picker reads it as focus-outside and dies on open.
          // Suppress the refocus and the picker survives.
          onCloseAutoFocus={event => event.preventDefault()}
        >
          <ContextMenuItem onSelect={() => setPickerOpen(true)}>
            <Codicon name="symbol-color" size="0.875rem" />
            <span>{p.color}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRename}>
            <Codicon name="text-size" size="0.875rem" />
            <span>{p.renameMenu}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onEditSoul}>
            <Codicon name="edit" size="0.875rem" />
            <span>{p.editSoul}</span>
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDelete}
            variant="destructive"
          >
            <Codicon name="trash" size="0.875rem" />
            <span>{t.common.delete}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <PopoverContent
        aria-label={p.colorFor(label)}
        className="w-auto p-2"
        collisionPadding={{ bottom: 44, left: 8, right: 8, top: 8 }}
        side="top"
      >
        <ColorSwatches
          clearIcon="sync"
          clearLabel={p.autoColor}
          onChange={pickColor}
          swatches={PROFILE_SWATCHES}
          swatchLabel={p.setColor}
          value={color}
        />
      </PopoverContent>
    </Popover>
  )
}
