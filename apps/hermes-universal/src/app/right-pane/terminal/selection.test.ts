import { beforeEach, describe, expect, it } from 'vitest'

import { mirrorSelection } from './selection'

function terminalHost(): { host: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const host = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  host.appendChild(textarea)
  document.body.appendChild(host)

  return { host, textarea }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('mirrorSelection', () => {
  it('mirrors the terminal selection into the helper textarea when it has focus', () => {
    const { host, textarea } = terminalHost()
    textarea.focus()

    mirrorSelection(host, 'npm run build')

    expect(textarea.value).toBe('npm run build')
    // Claimed: a platform copy now has a DOM selection to read.
    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe('npm run build'.length)
  })

  it('clears the mirror when the terminal selection is emptied', () => {
    const { host, textarea } = terminalHost()
    textarea.value = 'stale'

    mirrorSelection(host, '')

    expect(textarea.value).toBe('')
  })

  it('YIELDS while focus is outside the terminal — the chat copy must win', () => {
    const { host, textarea } = terminalHost()
    const chatInput = document.createElement('input')
    document.body.appendChild(chatInput)
    chatInput.focus()

    mirrorSelection(host, 'terminal scrap')

    // The value is staged (so a later focus can use it) but the live range is
    // NOT claimed — claiming it is what stole ⌘C from the chat.
    expect(textarea.value).toBe('terminal scrap')
    expect(document.activeElement).toBe(chatInput)
  })

  it('yields to a foreign live range even while the terminal holds focus', () => {
    const { host, textarea } = terminalHost()
    const chatText = document.createElement('p')
    chatText.textContent = 'selected in the chat'
    document.body.appendChild(chatText)

    textarea.focus()

    const range = document.createRange()
    range.selectNodeContents(chatText)
    const live = window.getSelection()!
    live.removeAllRanges()
    live.addRange(range)

    mirrorSelection(host, 'terminal scrap')

    expect(textarea.value).toBe('terminal scrap')
    // The user's chat selection survives.
    expect(window.getSelection()?.toString()).toBe('selected in the chat')
  })

  it('is a no-op on a host with no helper textarea', () => {
    const host = document.createElement('div')

    expect(() => mirrorSelection(host, 'anything')).not.toThrow()
  })
})
