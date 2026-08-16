import { describe, expect, it } from 'vitest'

import plugin from './plugin'

// The board contributes a route, a sidebar row and a statusbar pill. A bundled
// plugin that registers those without being asked is exactly the duplicate-UI
// regression MJXHRM-211 records, and `defaultEnabled` is the only thing standing
// between this board and that. Absence is not good enough: the host reads
// `plugin.defaultEnabled ?? true`, so a dropped field silently turns the board
// ON for everyone.
describe('the kanban manifest', () => {
  it('ships OFF until the user asks for it', () => {
    expect(plugin.defaultEnabled).toBe(false)
  })

  it('says what it does, so the inventory row is worth reading', () => {
    expect(plugin.description).toBeTruthy()
  })

  it('keeps the id its REST/socket namespace and storage scope are built from', () => {
    expect(plugin.id).toBe('kanban')
  })
})
