import type { ComponentType, ReactNode } from 'react'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// Ported to match apps/desktop/src/app/settings/primitives.tsx: the settings
// page scroll wrapper, section heading, and the canonical labeled-control row —
// keyed to the desktop `--conversation-*` typography + `--ui-*` tokens so every
// section reads identically to desktop.

export function SettingsContent({ children }: { children: ReactNode }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto pb-20', PAGE_INSET_X)}>{children}</div>
}

export function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'primary'; children: ReactNode }) {
  return <Badge variant={tone === 'primary' ? 'default' : 'muted'}>{children}</Badge>
}

export function SectionHeading({
  icon: Icon,
  title,
  meta,
  aside
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  meta?: string
  // Right-aligned trailing content on the heading row (e.g. a compact status +
  // action), so a single-item section needn't repeat its own label as a row.
  aside?: ReactNode
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2 pt-2 text-[length:var(--conversation-text-font-size)] font-medium">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span>{title}</span>
      {meta && <Pill>{meta}</Pill>}
      {aside && <div className="ms-auto flex min-w-0 items-center">{aside}</div>}
    </div>
  )
}

// A titled section: heading + body with the shared vertical rhythm. Keeps the
// heading and its content welded together so pages stop hand-rolling
// `<div className="mb-…"><SectionHeading/>…</div>` at every call site.
//
// NOTE: distinct from the `SettingsSection` exported by ./settings-section —
// that one is the routed page wrapper. This is the in-page section primitive.
export function SettingsSection({
  aside,
  children,
  icon,
  meta,
  title
}: {
  aside?: ReactNode
  children: ReactNode
  icon: ComponentType<{ className?: string }>
  meta?: string
  title: string
}) {
  return (
    <section className="mb-6">
      <SectionHeading aside={aside} icon={icon} meta={meta} title={title} />
      {children}
    </section>
  )
}

export function ListRow({
  title,
  description,
  hint,
  action,
  below,
  wide = false,
  className
}: {
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  below?: ReactNode
  wide?: boolean
  className?: string
}) {
  return (
    // Container-queried (not viewport): the label/control split keys on the row's
    // own pane width, so a narrow detail column stacks instead of squishing.
    <div className={cn('@container', className)}>
      <div
        className={cn(
          'grid gap-3 py-3',
          !wide && '@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] @2xl:items-center'
        )}
      >
        <div className="min-w-0">
          <div className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
              {description}
            </div>
          )}
          {hint && <div className="mt-1 block font-mono text-[0.68rem] text-muted-foreground/45">{hint}</div>}
          {below}
        </div>
        {action && <div className={cn('min-w-0', !wide && '@2xl:justify-self-end')}>{action}</div>}
      </div>
    </div>
  )
}

// Skeleton primitives mirroring the settings layout rhythm — a loading page keeps
// its shape instead of collapsing to a centered spinner.
export function SectionHeadingSkeleton() {
  return (
    <div className="mb-2.5 flex items-center gap-2 pt-2">
      <Skeleton className="size-4" />
      <Skeleton className="h-4 w-36 max-w-full" />
    </div>
  )
}

export function ListRowSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="@container">
      <div
        className={cn(
          'grid gap-3 py-3',
          !wide && '@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] @2xl:items-center'
        )}
      >
        <div className="min-w-0 space-y-1.5">
          <Skeleton className="h-3.5 w-40 max-w-full" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        {!wide && <Skeleton className="h-8 w-full @2xl:w-72 @2xl:justify-self-end" />}
      </div>
    </div>
  )
}

// A full settings page in its loading shape: an optional leading search field
// over one or more sections, each an optional heading above a run of rows.
// `<SettingsSkeleton search sections={[{ heading, rows }]} />`. `children` is
// for real content that already renders its own loading shape and should stay
// mounted (the Model page's header slot).
export function SettingsSkeleton({
  children,
  search = false,
  sections = [{ rows: 4 }]
}: {
  children?: ReactNode
  search?: boolean
  sections?: { heading?: boolean; rows: number }[]
}) {
  return (
    <SettingsContent>
      {children}
      {search && <Skeleton className="mb-3 h-8 w-full" />}
      {sections.map((section, index) => (
        <section className={cn(index > 0 && 'mt-6')} key={index}>
          {section.heading && <SectionHeadingSkeleton />}
          <div className="grid gap-1">
            {Array.from({ length: section.rows }, (_, row) => (
              <ListRowSkeleton key={row} />
            ))}
          </div>
        </section>
      ))}
    </SettingsContent>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  )
}
