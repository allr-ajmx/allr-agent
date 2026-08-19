import { useCallback } from 'react'

import { useTheme } from './context'

// Retired skin names land on the current default skin so old muscle memory
// works. `nous` is still a real, selectable skin — it just isn't the default
// any more — so it stays out of this map.
const ALIASES: Record<string, string> = {
  ares: 'ember',
  default: 'allr',
  gold: 'allr',
  hermes: 'allr',
  'nous-light': 'nous'
}

// Client-side `/skin` handler. Ported from apps/desktop/src/themes/use-skin-command.ts
// (wording de-desktopised); returns the message to surface in the composer.
export function useSkinCommand() {
  const { availableThemes, setTheme, themeName } = useTheme()

  return useCallback(
    (rawArg: string) => {
      const arg = rawArg.trim()

      if (!availableThemes.length) {
        return 'No themes are available.'
      }

      const activeIndex = Math.max(
        0,
        availableThemes.findIndex(t => t.name === themeName)
      )

      if (!arg || arg === 'next') {
        const next = availableThemes[(activeIndex + 1) % availableThemes.length]
        setTheme(next.name)

        return `Theme switched to ${next.label}.`
      }

      if (arg === 'list' || arg === 'ls' || arg === 'status') {
        const rows = availableThemes.map(t => `${t.name === themeName ? '*' : ' '} ${t.name.padEnd(10)} ${t.label}`)

        return ['Themes:', ...rows, '', 'Use /skin <name>, or /skin to cycle.'].join('\n')
      }

      const normalized = arg.toLowerCase()
      const targetName = ALIASES[normalized] || normalized

      const target = availableThemes.find(
        t => t.name.toLowerCase() === targetName || t.label.toLowerCase() === normalized
      )

      if (!target) {
        return `Unknown theme: ${arg}\nAvailable: ${availableThemes.map(t => t.name).join(', ')}`
      }

      setTheme(target.name)

      return `Theme switched to ${target.label}.`
    },
    [availableThemes, setTheme, themeName]
  )
}
