import type { ComponentProps, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'

import { resolveBrandIcon } from '@/lib/brand-icon'
import { ArrowUpRight } from '@/lib/icons'
import { IS_TAURI } from '@/lib/platform'
import { cn } from '@/lib/utils'

const titleCache = new Map<string, string>()
const titleInflight = new Map<string, Promise<string>>()
const titleSubs = new Map<string, Set<(value: string) => void>>()

const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)]|[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?:\/[^\s<>"'`.,;:!?)]*)?/gi

// Explicit-scheme / www. URLs only — no bare-domain matching.
const EXPLICIT_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)]/gi

const DOMAIN_RE = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i
const SKIP_PROTO_RE = /^(?:file|data|mailto|javascript|blob|chrome|about|hermes):/i
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i

// A fetched <title> that describes the FETCH rather than the page. Naming a
// link "Just a moment…" or "Page not found" is worse than no title at all, so
// these fall back to the URL slug instead.
const ERROR_TITLE_RE =
  /\b(?:access denied|attention required|captcha|error|forbidden|just a moment|not found|request blocked|too many requests)\b/i

// Hand a URL to the OS default handler, REPORTING whether it was taken. In a
// Tauri webview a plain <a> or window.open would navigate the app away (or
// no-op), so this routes through the native Rust command `open_external`, which
// calls the opener plugin's Rust API.
//
// The Rust command is the only working door, not a stylistic preference. Its JS
// counterpart (`@tauri-apps/plugin-opener`'s `openUrl`) is ACL-SCOPED: the
// `opener:allow-open-url` permission this app grants enables the command
// "without any pre-configured scope", and the plugin's `open_url` answers
// `Err(ForbiddenUrl)` unless some scope entry MATCHES the url. No scope is
// declared anywhere in `capabilities/` or `tauri.conf.json`, so the allow-list is
// empty and every url is forbidden — the JS path fails for all of them, on every
// platform. A Rust-internal `app.opener().open_url(..)` is not scope-checked at
// all. See `open_external` in `src-tauri/src/lib.rs`; eslint bans the JS import
// so this cannot be rediscovered a third time.
//
// False off Tauri (plain-web dev / vitest) — there is no OS door there to report on.
export async function tryOpenExternalLink(url: string): Promise<boolean> {
  if (!IS_TAURI) {
    return false
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external', { url })

    return true
  } catch {
    return false
  }
}

// Fire-and-forget twin for UI callers (links, menu items) with nothing to say
// about a failure: off Tauri, or when the native command is unavailable, it falls
// back to window.open rather than reporting anything.
export async function openExternalLink(url: string): Promise<void> {
  if (await tryOpenExternalLink(url)) {
    return
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* nothing to do */
  }
}

export function normalizeExternalUrl(value: string): string {
  const trimmed = value.trim()

  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return DOMAIN_RE.test(trimmed) ? `https://${trimmed}` : trimmed
}

function parseUrl(value: string): null | URL {
  try {
    return new URL(normalizeExternalUrl(value))
  } catch {
    return null
  }
}

function titleCacheKey(value: string): string {
  const url = parseUrl(value)

  if (!url) {
    return normalizeExternalUrl(value)
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '') || '/'

  return `${host}${pathname}${url.search || ''}`
}

export function shortHostLabel(value: string): string {
  return parseUrl(value)?.hostname.replace(/^www\./, '') ?? value
}

export function hostPathLabel(value: string): string {
  const url = parseUrl(value)

  if (!url) {
    return value
  }

  const host = url.hostname.replace(/^www\./, '')
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : ''

  return `${host}${path}`
}

function cleanSlug(segment: string): string {
  try {
    return decodeURIComponent(segment)
      .replace(/\.a\d+\..*$/i, '')
      .replace(/\.(?:html?|php|aspx?)$/i, '')
      .replace(/(?:[-_.](?:[a-z]{1,3}\d{2,}|i\d{2,}))+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return ''
  }
}

export function urlSlugTitleLabel(value: string): string {
  const url = parseUrl(value)

  for (const segment of url?.pathname.split('/').filter(Boolean).reverse() ?? []) {
    const cleaned = cleanSlug(segment)

    if (!cleaned || !/[a-z]/i.test(cleaned)) {
      continue
    }

    if (/^(?:[a-z]{1,3}\d+|\d+)$/i.test(cleaned.replace(/\s+/g, ''))) {
      continue
    }

    const titled = cleaned.replace(/\b[a-z]/g, c => c.toUpperCase())

    if (titled.length >= 4) {
      return titled
    }
  }

  return hostPathLabel(value)
}

export function isTitleFetchable(value: string): boolean {
  if (!value || SKIP_PROTO_RE.test(value)) {
    return false
  }

  const url = parseUrl(value)

  return Boolean(url && /^https?:$/.test(url.protocol) && !LOCAL_HOST_RE.test(url.host))
}

// Resolve an external link's page title via the native `fetch_link_title`
// command (reqwest GET + <title>/og:title parse in Rust — the webview can't
// fetch cross-origin). Results are cached and in-flight requests deduped;
// subscribers (useLinkTitle) are notified when the title lands. Off Tauri
// (plain-web dev / vitest) resolves to '' — PrettyLink then falls back to its
// label / URL slug, preserving rendering parity.
export function fetchLinkTitle(url: string): Promise<string> {
  const normalizedUrl = normalizeExternalUrl(url)
  const key = titleCacheKey(normalizedUrl)

  if (!isTitleFetchable(normalizedUrl)) {
    return Promise.resolve('')
  }

  if (titleCache.has(key)) {
    return Promise.resolve(titleCache.get(key) ?? '')
  }

  const pending = titleInflight.get(key)

  if (pending) {
    return pending
  }

  if (!IS_TAURI) {
    titleCache.set(key, '')

    return Promise.resolve('')
  }

  const promise = (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const raw = await invoke<string>('fetch_link_title', { url: normalizedUrl })
      const clean = (raw || '').replace(/\s+/g, ' ').trim()

      return clean && !ERROR_TITLE_RE.test(clean) ? clean : ''
    } catch {
      return ''
    }
  })().then(safe => {
    titleCache.set(key, safe)
    titleInflight.delete(key)
    titleSubs.get(key)?.forEach(sub => sub(safe))

    return safe
  })

  titleInflight.set(key, promise)

  return promise
}

export function useLinkTitle(url?: null | string): string {
  const normalizedUrl = useMemo(() => (url ? normalizeExternalUrl(url) : ''), [url])
  const key = useMemo(() => (normalizedUrl ? titleCacheKey(normalizedUrl) : ''), [normalizedUrl])
  const [title, setTitle] = useState(() => (key ? (titleCache.get(key) ?? '') : ''))

  useEffect(() => {
    setTitle(key ? (titleCache.get(key) ?? '') : '')

    if (!key || !isTitleFetchable(normalizedUrl)) {
      return
    }

    const subs = titleSubs.get(key) ?? new Set<(value: string) => void>()

    subs.add(setTitle)
    titleSubs.set(key, subs)
    void fetchLinkTitle(normalizedUrl)

    return () => {
      subs.delete(setTitle)

      if (!subs.size) {
        titleSubs.delete(key)
      }
    }
  }, [key, normalizedUrl])

  return title
}

interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  children?: ReactNode
  showExternalIcon?: boolean
}

export function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      aria-hidden
      className={cn('ms-1 inline size-[0.78em] align-[-0.08em] opacity-70 rtl:-scale-x-100', className)}
    />
  )
}

// Brand mark for a known host, sized in `em` so it tracks the surrounding text
// at any font size. It paints in `currentColor` rather than the brand hex —
// several brand colors (GitHub's near-black, Unity's white) vanish against one
// theme or the other.
//
// `title=""` is load-bearing: Simple Icons always renders a <title> defaulting
// to the brand name, which lands in the anchor's textContent and accessible
// name — a PR link would read "GitHub#123".
export function LinkBrandIcon({ className, href }: { className?: string; href: string }) {
  const Icon = resolveBrandIcon(shortHostLabel(href))

  return Icon ? (
    <Icon aria-hidden className={cn('me-1 inline size-[0.85em] align-[-0.12em] opacity-80', className)} title="" />
  ) : null
}

export function ExternalLink({
  children,
  className,
  href,
  onClick,
  showExternalIcon = false,
  ...rest
}: ExternalLinkProps) {
  const target = normalizeExternalUrl(href)

  return (
    <a
      className={cn('ref', className)}
      href={target}
      onClick={event => {
        event.stopPropagation()
        onClick?.(event)

        if (event.defaultPrevented) {
          return
        }

        event.preventDefault()
        void openExternalLink(target)
      }}
      rel="noopener noreferrer"
      target="_blank"
      {...rest}
    >
      {children ?? urlSlugTitleLabel(target)}
      {showExternalIcon && <ExternalLinkIcon />}
    </a>
  )
}

interface PrettyLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  label?: string
  fallbackLabel?: string
}

// Title resolution is a fallback, not an override. Both props carry authored
// text — chat markdown passes `fallbackLabel` — so either one skips the fetch.
export function PrettyLink({ className, fallbackLabel, href, label, ...rest }: PrettyLinkProps) {
  const target = useMemo(() => normalizeExternalUrl(href), [href])
  const authoredLabel = label?.trim() || fallbackLabel?.trim()
  const fetched = useLinkTitle(authoredLabel ? null : target)
  const display = authoredLabel || fetched || urlSlugTitleLabel(target)

  return (
    <ExternalLink className={cn('wrap-break-word', className)} href={target} title={target} {...rest}>
      <LinkBrandIcon href={target} />
      {display}
    </ExternalLink>
  )
}

interface LinkifiedTextProps {
  className?: string
  text: string
  pretty?: boolean
  explicitOnly?: boolean
}

export function LinkifiedText({ className, explicitOnly = false, pretty = true, text }: LinkifiedTextProps) {
  const nodes: ReactNode[] = []
  let cursor = 0

  for (const match of text.matchAll(explicitOnly ? EXPLICIT_URL_RE : URL_RE)) {
    const raw = match[0]
    const url = normalizeExternalUrl(raw)
    const index = match.index ?? 0

    if (index > cursor) {
      nodes.push(text.slice(cursor, index))
    }

    nodes.push(
      pretty ? (
        <PrettyLink href={url} key={`${url}-${index}`} />
      ) : (
        <ExternalLink href={url} key={`${url}-${index}`}>
          {raw}
        </ExternalLink>
      )
    )

    cursor = index + raw.length
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return <span className={className}>{nodes.length ? nodes : text}</span>
}

export function __resetLinkTitleCache(): void {
  titleCache.clear()
  titleInflight.clear()
  titleSubs.clear()
}
