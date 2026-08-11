import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  coerceFocusValue,
  formatFocusStatus,
  formatFocusToggleMessage,
  formatHiddenLine,
  resolveFocusArg
} from '@/lib/focus-view'
import {
  $focusRevealedRuns,
  $focusView,
  isFocusRunRevealed,
  pushFocusView,
  revealFocusRun,
  setFocusViewLocal,
  syncFocusView
} from '@/store/focus-view'

beforeEach(() => {
  setFocusViewLocal(false)
  $focusRevealedRuns.set([])
})

describe('/focus argument grammar', () => {
  // Ported from hermes_cli/focus_view.py resolve_focus_arg — the same words
  // have to mean the same thing on every surface.
  it('toggles on a bare command, like its sibling display switches', () => {
    expect(resolveFocusArg('', false)).toEqual({ action: 'set', target: true })
    expect(resolveFocusArg('', true)).toEqual({ action: 'set', target: false })
    expect(resolveFocusArg('toggle', true)).toEqual({ action: 'set', target: false })
  })

  it('accepts the CLI aliases for on and off', () => {
    for (const word of ['on', 'enable', 'enabled', 'true', 'yes', '1', ' ON ']) {
      expect(resolveFocusArg(word, false)).toEqual({ action: 'set', target: true })
    }

    for (const word of ['off', 'disable', 'disabled', 'false', 'no', '0']) {
      expect(resolveFocusArg(word, true)).toEqual({ action: 'set', target: false })
    }
  })

  it('reports state for status words and rejects anything else', () => {
    expect(resolveFocusArg('status', true)).toEqual({ action: 'status', target: null })
    expect(resolveFocusArg('?', false)).toEqual({ action: 'status', target: null })
    expect(resolveFocusArg('sometimes', false)).toEqual({ action: 'usage', target: null })
  })
})

describe('focus view copy', () => {
  it('counts hidden rows honestly — nothing hidden, nothing said', () => {
    expect(formatHiddenLine(0)).toBeNull()
    expect(formatHiddenLine(-3)).toBeNull()
    expect(formatHiddenLine(1)).toBe('⋯ 1 tool line hidden')
    expect(formatHiddenLine(4)).toBe('⋯ 4 tool lines hidden')
  })

  it('says how to get the rows back whenever it is on', () => {
    expect(formatFocusStatus(true)).toContain('/focus off')
    expect(formatFocusStatus(false)).toContain('OFF')
    expect(formatFocusToggleMessage(true)).toContain('enabled')
    expect(formatFocusToggleMessage(false)).toContain('disabled')
  })

  it('reads the gateway flag in either of the shapes config.get answers with', () => {
    expect(coerceFocusValue('on')).toBe(true)
    expect(coerceFocusValue(true)).toBe(true)
    expect(coerceFocusValue('off')).toBe(false)
    expect(coerceFocusValue(undefined)).toBe(false)
  })
})

describe('focus view state', () => {
  it('keeps per-run reveals only while focus is on', () => {
    setFocusViewLocal(true)
    revealFocusRun('msg-1:3')

    expect(isFocusRunRevealed($focusRevealedRuns.get(), 'msg-1:3')).toBe(true)
    expect(isFocusRunRevealed($focusRevealedRuns.get(), 'msg-1:7')).toBe(false)

    // Leaving focus drops them: re-entering it later must start hidden rather
    // than resurrect an hour-old exception.
    setFocusViewLocal(false)
    expect($focusRevealedRuns.get()).toEqual([])
  })

  it('writes the shared flag display-only, so tool events keep arriving', async () => {
    const request = vi.fn().mockResolvedValue({ display_only: true, value: 'on' })

    const result = await pushFocusView(request, true)

    expect(request).toHaveBeenCalledWith('config.set', { key: 'focus', value: 'on', display_only: true })
    expect(result).toEqual({ displayOnly: true, enabled: true })
    expect($focusView.get()).toBe(true)
  })

  it('reports a gateway that ignored display_only rather than silently degrading', async () => {
    const request = vi.fn().mockResolvedValue({ value: 'on' })

    expect(await pushFocusView(request, true)).toEqual({ displayOnly: false, enabled: true })
  })

  it('adopts the gateway flag on connect — a mode set from the CLI is honored here', async () => {
    const request = vi.fn().mockResolvedValue({ tool_progress: 'off', value: 'on' })

    expect(await syncFocusView(request)).toBe(true)
    expect($focusView.get()).toBe(true)
  })
})
