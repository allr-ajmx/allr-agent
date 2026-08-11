import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDomFindSelection, countDomTextMatches, domFind, domFindSupported } from './find-in-page-dom'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html

  return document.body
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('countDomTextMatches', () => {
  it('counts every occurrence, case-insensitively', () => {
    mount('<p>Hermes and hermes and HERMES</p>')

    expect(countDomTextMatches('hermes')).toBe(3)
    expect(countDomTextMatches('HeRmEs')).toBe(3)
  })

  it('counts across separate elements', () => {
    mount('<p>alpha</p><div><span>alpha</span></div>')

    expect(countDomTextMatches('alpha')).toBe(2)
  })

  it('does not double-count an overlapping match', () => {
    mount('<p>aaa</p>')

    expect(countDomTextMatches('aa')).toBe(1)
  })

  it('ignores script, style and hidden subtrees', () => {
    mount(
      '<script>needle</script><style>needle</style><div hidden>needle</div>' +
        '<div aria-hidden="true">needle</div><p>needle</p>'
    )

    expect(countDomTextMatches('needle')).toBe(1)
  })

  it('stops at the cap instead of walking a huge document', () => {
    mount(`<p>${'x '.repeat(50)}</p>`)

    expect(countDomTextMatches('x', document.body, 10)).toBe(10)
  })

  it('is zero for an empty query or a missing root', () => {
    mount('<p>anything</p>')

    expect(countDomTextMatches('')).toBe(0)
    expect(countDomTextMatches('anything', null)).toBe(0)
  })

  // The documented limit: a match split across elements is invisible to a
  // per-text-node scan, even though window.find would land on it.
  it('misses a match split across elements (known limit)', () => {
    mount('<p><b>He</b>rmes</p>')

    expect(countDomTextMatches('hermes')).toBe(0)
  })
})

describe('domFindSupported', () => {
  it('is false on an engine without window.find', () => {
    expect(domFindSupported({})).toBe(false)
    expect(domFindSupported(null)).toBe(false)
  })

  it('is true once the engine exposes find', () => {
    expect(domFindSupported({ find: () => true })).toBe(true)
  })
})

describe('domFind', () => {
  it('searches forward, wrapping, case-insensitively', () => {
    const find = vi.fn().mockReturnValue(true)

    expect(domFind('hermes', { win: { find } })).toBe(true)
    expect(find).toHaveBeenCalledWith('hermes', false, false, true, false, false, false)
  })

  it('passes the backwards flag through for previous', () => {
    const find = vi.fn().mockReturnValue(true)

    domFind('hermes', { backwards: true, win: { find } })

    expect(find).toHaveBeenCalledWith('hermes', false, true, true, false, false, false)
  })

  it('clears the selection first for a fresh query, so it starts at the top', () => {
    const removeAllRanges = vi.fn()
    const find = vi.fn().mockReturnValue(true)

    domFind('hermes', { fromStart: true, win: { find, getSelection: () => ({ removeAllRanges }) as never } })

    expect(removeAllRanges).toHaveBeenCalledOnce()
  })

  it('leaves the caret alone when stepping', () => {
    const removeAllRanges = vi.fn()

    domFind('hermes', { win: { find: () => true, getSelection: () => ({ removeAllRanges }) as never } })

    expect(removeAllRanges).not.toHaveBeenCalled()
  })

  it('reports no match rather than throwing when the engine rejects the call', () => {
    expect(
      domFind('hermes', {
        win: {
          find: () => {
            throw new Error('unsupported')
          }
        }
      })
    ).toBe(false)
  })

  it('is a no-op for an empty query or an engine with no find', () => {
    expect(domFind('', { win: { find: () => true } })).toBe(false)
    expect(domFind('hermes', { win: {} })).toBe(false)
  })
})

describe('clearDomFindSelection', () => {
  it('drops the highlight', () => {
    const removeAllRanges = vi.fn()

    clearDomFindSelection({ getSelection: () => ({ removeAllRanges }) as never })

    expect(removeAllRanges).toHaveBeenCalledOnce()
  })

  it('survives an engine that has no selection at all', () => {
    expect(() => clearDomFindSelection({})).not.toThrow()
    expect(() => clearDomFindSelection(null)).not.toThrow()
  })
})
