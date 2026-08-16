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

  it('ignores text an inline style has taken out of the render', () => {
    mount('<p style="display:none">needle</p><p style="visibility:hidden">needle</p><p>needle</p>')

    expect(countDomTextMatches('needle')).toBe(1)
  })

  // A closed <details> renders its summary and nothing else, so window.find can
  // never land in its body. Counting it would put a number by the input that no
  // amount of pressing "next" can reach — collapsed tool output and the
  // user-message "output" drawer are both this shape.
  it('counts a collapsed block’s summary but not its hidden body', () => {
    mount('<details><summary>needle summary</summary><pre>needle body</pre></details>')

    expect(countDomTextMatches('needle')).toBe(1)
  })

  it('counts a collapsed block’s body once it is open', () => {
    mount('<details open><summary>needle summary</summary><pre>needle body</pre></details>')

    expect(countDomTextMatches('needle')).toBe(2)
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

  // The engine flattens an inline run before matching, so a query straddling
  // element boundaries IS a match — and window.find selects it. A per-text-node
  // scan reported 0 here, leaving the bar showing 0/0 over a highlighted hit.
  it('counts a match split across inline elements', () => {
    mount('<p><b>He</b>rmes</p>')

    expect(countDomTextMatches('hermes')).toBe(1)
  })

  // The real shape of the above: Shiki emits one span per token, so any query
  // crossing a token boundary lands here.
  it('counts a match split across syntax-highlighted tokens', () => {
    mount('<pre><code><span>foo</span><span>.</span><span>bar</span></code></pre>')

    expect(countDomTextMatches('foo.bar')).toBe(1)
  })

  it('does not fuse text across a block boundary into a match that is not there', () => {
    mount('<p>her</p><p>mes</p>')

    expect(countDomTextMatches('hermes')).toBe(0)
  })

  it('does not fuse text across a line break', () => {
    mount('<p>her<br>mes</p>')

    expect(countDomTextMatches('hermes')).toBe(0)
  })

  it('does not fuse text across a hidden span', () => {
    mount('<p>her<span hidden>XXX</span>mes</p>')

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
