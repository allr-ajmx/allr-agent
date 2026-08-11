import { describe, expect, it } from 'vitest'

import {
  desktopSlashCommandTakesArgs,
  desktopSlashDescription,
  desktopSlashUnavailableMessage,
  isDesktopSlashCommand,
  rankSkillCommands,
  resolveDesktopCommand,
  type SkillCatalogMap
} from './desktop-slash-commands'

const rows = [{ text: '/alpha' }, { text: '/beta' }, { text: '/gamma' }]

const skills: SkillCatalogMap = {
  '/alpha': { origin: 'bundled', usage: 0 },
  '/beta': { origin: 'hub', usage: 5 },
  '/gamma': { origin: 'bundled', usage: 2 }
}

describe('rankSkillCommands', () => {
  it('orders by usage, A–Z within a tie', () => {
    const ranked = rankSkillCommands([{ text: '/b' }, { text: '/a' }, { text: '/hot' }], {
      '/a': { usage: 1 },
      '/b': { usage: 1 },
      '/hot': { usage: 9 }
    })

    expect(ranked.map(row => row.text)).toEqual(['/hot', '/a', '/b'])
  })

  it('keeps never-used built-ins while browsing is off', () => {
    expect(rankSkillCommands(rows, skills).map(row => row.text)).toEqual(['/beta', '/gamma', '/alpha'])
  })

  it('drops never-used bundled skills when browsing a bare slash', () => {
    const ranked = rankSkillCommands(rows, skills, { pruneUnusedBuiltins: true })

    expect(ranked.map(row => row.text)).toEqual(['/beta', '/gamma'])
  })

  it('keeps rows the catalog has no entry for, even while pruning', () => {
    const ranked = rankSkillCommands([...rows, { text: '/unknown' }], skills, { pruneUnusedBuiltins: true })

    expect(ranked.map(row => row.text)).toContain('/unknown')
  })

  it('reorders and hides nothing on an older backend with no skills map', () => {
    expect(rankSkillCommands(rows, undefined).map(row => row.text)).toEqual(['/alpha', '/beta', '/gamma'])
  })
})

// `/diff` and `/focus` shipped in the backend registry with no client row, so
// both fell through as unknown commands. They resolve to deliberately DIFFERENT
// surfaces, and that difference is the point of these tests.
describe('/diff', () => {
  it('executes on the backend — it needs a repo this client does not have', () => {
    expect(resolveDesktopCommand('/diff')?.surface).toEqual({ kind: 'exec' })
    expect(isDesktopSlashCommand('/diff')).toBe(true)
    expect(desktopSlashUnavailableMessage('/diff')).toBeNull()
  })

  it('offers its modes as an argument step rather than committing on the bare command', () => {
    expect(desktopSlashCommandTakesArgs('/diff')).toBe(true)
    expect(desktopSlashDescription('/diff')).toContain('staged|all|session')
  })
})

describe('/approvals', () => {
  // Unregistered, it fell through to `command.dispatch`, which answers "not a
  // quick/plugin/skill command" instead of reporting the approval mode.
  it('executes on the backend rather than falling through as unknown', () => {
    expect(resolveDesktopCommand('/approvals')?.surface).toEqual({ kind: 'exec' })
    expect(isDesktopSlashCommand('/approvals')).toBe(true)
    expect(desktopSlashUnavailableMessage('/approvals')).toBeNull()
  })

  it('offers its modes as an argument step rather than committing on the bare command', () => {
    expect(desktopSlashCommandTakesArgs('/approvals')).toBe(true)
    expect(desktopSlashDescription('/approvals')).toContain('manual|smart|off')
  })
})

describe('/focus', () => {
  // Registering it as `exec` would have "worked" — the gateway answers /focus —
  // and would have been wrong: its answer is to pin tool progress off, which
  // stops the tool events this client renders from arriving at all. It is a
  // local action instead, and the transcript does the hiding.
  it('is a local action, not a backend exec and not an unavailable command', () => {
    expect(resolveDesktopCommand('/focus')?.surface).toEqual({ kind: 'action', action: 'focus' })
    expect(isDesktopSlashCommand('/focus')).toBe(true)
    expect(desktopSlashUnavailableMessage('/focus')).toBeNull()
  })

  it('offers on|off|status as an argument step', () => {
    expect(desktopSlashCommandTakesArgs('/focus')).toBe(true)
    expect(desktopSlashDescription('/focus')).toContain('on|off|status')
  })

  // /verbose stays terminal-only: it is the tool-progress CYCLE, and running it
  // from here would write the gateway-wide display.tool_progress and take this
  // client's tool events with it. Focus view no longer shares its surface.
  it('no longer shares a surface with /verbose', () => {
    expect(resolveDesktopCommand('/verbose')?.surface).toEqual({ kind: 'unavailable', reason: 'terminal' })
    expect(resolveDesktopCommand('/focus')?.surface).not.toEqual(resolveDesktopCommand('/verbose')?.surface)
  })
})
