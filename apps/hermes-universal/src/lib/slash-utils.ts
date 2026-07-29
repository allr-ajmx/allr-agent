// Slash-dispatcher render helpers, ported verbatim from desktop's
// app/session/hooks/use-prompt-actions/utils.ts (only the three the dispatcher
// needs — the rest of that file is Electron file-IO and queue machinery).

import type { Translations } from '@/i18n'
import { type CommandsCatalogLike, filterDesktopCommandsCatalog } from '@/lib/desktop-slash-commands'

/** A bare `/resume <value>` arg that looks like a session id rather than a title. */
export function isSessionIdCandidate(value: string): boolean {
  const trimmed = value.trim()

  return /^\d{8}_\d{6}_[A-Fa-f0-9]{6}$/.test(trimmed) || /^[A-Fa-f0-9]{32}$/.test(trimmed)
}

/** Render the gateway's `commands.catalog` as the `/help` text block. */
export function renderCommandsCatalog(catalog: CommandsCatalogLike, copy: Translations['desktop']): string {
  const desktopCatalog = filterDesktopCommandsCatalog(catalog)

  const sections = desktopCatalog.categories?.length
    ? desktopCatalog.categories
    : [{ name: copy.desktopCommands, pairs: desktopCatalog.pairs ?? [] }]

  const body = sections
    .filter(section => section.pairs.length > 0)
    .map(section => {
      const rows = section.pairs.map(([cmd, desc]) => `${cmd.padEnd(18)} ${desc}`)

      return [`${section.name}:`, ...rows].join('\n')
    })
    .join('\n\n')

  const tail = [
    desktopCatalog.skill_count ? copy.skillCommandsAvailable(desktopCatalog.skill_count) : '',
    desktopCatalog.warning ? copy.warningLine(desktopCatalog.warning) : ''
  ]
    .filter(Boolean)
    .join('\n')

  return [body || 'No desktop commands available.', tail].filter(Boolean).join('\n\n')
}

/** Wrap slash output in the `slash:<cmd>` envelope the system-message chip parses
 *  (see components/assistant-ui/thread/system-message.tsx). */
export function slashStatusText(command: string, output: string): string {
  return [`slash:${command}`, output.trim()].filter(Boolean).join('\n')
}
