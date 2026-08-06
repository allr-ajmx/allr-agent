import { describe, expect, it } from 'vitest'

import { describeTarget } from './events'

/**
 * The Event Timing observer itself cannot be tested — a synthetic `el.click()`
 * produces no entry, by spec, so an empty result from a scripted harness is
 * correct behaviour rather than a broken observer. `describeTarget` is the one
 * piece a unit test can reach, and it is also the piece that decides whether a
 * capture is readable at all.
 */
function build(html: string): HTMLElement {
  const host = document.createElement('div')

  host.innerHTML = html

  return host.querySelector<HTMLElement>('[data-probe]')!
}

describe('describeTarget', () => {
  it('names the sash a hover actually landed on, not the hairline inside it', () => {
    // The literal reproduction: the worst span in the motivating capture was a
    // 384ms `pointerdown` reported against a bare `span`.
    const target = build('<div role="separator"><span data-probe></span></div>')

    expect(describeTarget(target)).toBe('span[sash]')
  })

  it('prefers the most specific marker over the nearest one', () => {
    // `data-slot` is closer, but a shadcn wrapper is not what you want to read
    // in a trace when the thing is a sash.
    const target = build('<div role="separator"><div data-slot="wrapper"><span data-probe></span></div></div>')

    expect(describeTarget(target)).toBe('span[sash]')
  })

  it('keeps a static pane id but strips a session id', () => {
    const stat = build('<div data-tree-tab="workspace"><span data-probe></span></div>')
    const chat = build('<div data-tree-tab="session-tile:abc-123-secret"><span data-probe></span></div>')

    expect(describeTarget(stat)).toBe('span[tab:workspace]')
    // The session id must never ride into a shared trace.
    expect(describeTarget(chat)).toBe('span[tab:session-tile]')
    expect(describeTarget(chat)).not.toContain('abc-123-secret')
  })

  it('records generated node ids as the marker only', () => {
    const zone = build('<div data-tree-group="group-l2x9f-7"><span data-probe></span></div>')
    const split = build('<div data-tree-split="split-l2x9f-2"><span data-probe></span></div>')

    expect(describeTarget(zone)).toBe('span[zone]')
    expect(describeTarget(split)).toBe('span[split]')
    expect(describeTarget(zone)).not.toContain('l2x9f')
  })

  it('still reads data-slot when nothing structural is above it', () => {
    const target = build('<div data-slot="chat-composer"><span data-probe></span></div>')

    expect(describeTarget(target)).toBe('span[chat-composer]')
  })

  it('separates "no element" from "element nobody named"', () => {
    // Two different problems. The first is an instrument with nothing to
    // measure; the second is a gap in the marker list. Reporting both as
    // `unknown` is how an investigation gets convincingly wrong.
    expect(describeTarget(null)).toBe('unknown')
    expect(describeTarget(document.createTextNode('hi'))).toBe('unknown')
    expect(describeTarget(build('<div><p data-probe></p></div>'))).toBe('p?')
  })
})
