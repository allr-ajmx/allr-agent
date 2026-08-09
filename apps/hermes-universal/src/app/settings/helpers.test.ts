import { describe, expect, it } from 'vitest'

import type { HermesConfigRecord } from '@/types/hermes'

import { defineFieldCopy, fieldCopyForSchemaKey, schemaKeyToFieldCopyKey } from './field-copy'
import {
  enumOptionsFor,
  getNested,
  providerGroup,
  setNested,
  stripToolsetLabel,
  toolsetDisplayLabel,
  voiceFieldVisible
} from './helpers'

describe('settings helpers', () => {
  it('does not shadow the backend schema options for memory.provider', () => {
    // memory.provider options are discovery-driven and served by the backend
    // config schema (merged per-request); enumOptionsFor must return undefined
    // so config-field consumes schema.options instead of a stale static list —
    // otherwise a user-installed or pip-provided memory backend is unpickable.
    expect(enumOptionsFor('memory.provider', '', {})).toBeUndefined()
    expect(enumOptionsFor('memory.provider', 'honcho', {})).toBeUndefined()
  })

  describe('defineFieldCopy', () => {
    it('flattens nested field copy paths', () => {
      const copy = defineFieldCopy({
        display: {
          personality: 'Personality'
        },
        stt: {
          elevenlabs: {
            language_code: 'Language'
          }
        }
      })

      expect(copy[['display', 'personality'].join('.')]).toBe('Personality')
      expect(copy[['stt', 'elevenlabs', 'language_code'].join('.')]).toBe('Language')
    })

    it('keeps top-level flat field keys', () => {
      expect(
        defineFieldCopy({
          model_context_length: 'Context Window',
          file_read_max_chars: 'File Read Limit'
        })
      ).toEqual({
        model_context_length: 'Context Window',
        file_read_max_chars: 'File Read Limit'
      })
    })

    it('maps schema keys to camelCase translation keys', () => {
      expect(schemaKeyToFieldCopyKey('model_context_length')).toBe('modelContextLength')
      expect(schemaKeyToFieldCopyKey('display.show_reasoning')).toBe('display.showReasoning')
      expect(schemaKeyToFieldCopyKey('tool_output.max_line_length')).toBe('toolOutput.maxLineLength')
      expect(schemaKeyToFieldCopyKey('updates.non_interactive_local_changes')).toBe(
        'updates.nonInteractiveLocalChanges'
      )
    })

    it('looks up camelCase field copy by schema key with legacy fallback', () => {
      const copy = defineFieldCopy({
        display: {
          showReasoning: 'Reasoning Blocks'
        },
        file_read_max_chars: 'Legacy File Read Limit',
        modelContextLength: 'Context Window',
        toolOutput: {
          maxLineLength: 'Line Length Limit'
        }
      })

      expect(fieldCopyForSchemaKey(copy, 'model_context_length')).toBe('Context Window')
      expect(fieldCopyForSchemaKey(copy, 'display.show_reasoning')).toBe('Reasoning Blocks')
      expect(fieldCopyForSchemaKey(copy, 'tool_output.max_line_length')).toBe('Line Length Limit')
      expect(fieldCopyForSchemaKey(copy, 'file_read_max_chars')).toBe('Legacy File Read Limit')
    })

    it('rejects duplicate flattened paths', () => {
      const duplicateKey = ['display', 'personality'].join('.')

      expect(() =>
        defineFieldCopy({
          display: {
            personality: 'Personality'
          },
          [duplicateKey]: 'Duplicate'
        })
      ).toThrow('Duplicate field copy key: display.personality')
    })
  })

  it('reads and writes nested config paths', () => {
    const config: HermesConfigRecord = { display: { theme: 'mono' } }
    const next = setNested(config, 'display.theme', 'slate')

    expect(getNested(next, 'display.theme')).toBe('slate')
    expect(getNested(config, 'display.theme')).toBe('mono')
  })

  it('rejects prototype-polluting config paths', () => {
    const config: HermesConfigRecord = {}

    expect(() => setNested(config, '__proto__.polluted', true)).toThrow('Unsafe config path')
    expect(() => setNested(config, 'constructor.prototype.polluted', true)).toThrow('Unsafe config path')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  describe('stripToolsetLabel', () => {
    it('removes leading emoji prefixes from registry labels', () => {
      expect(stripToolsetLabel('⏰ Cron Jobs')).toBe('Cron Jobs')
      expect(stripToolsetLabel('⚡ Code Execution')).toBe('Code Execution')
      expect(stripToolsetLabel('🌐 Browser Automation')).toBe('Browser Automation')
    })

    it('leaves plain titles unchanged', () => {
      expect(stripToolsetLabel('Terminal & Processes')).toBe('Terminal & Processes')
    })
  })

  describe('toolsetDisplayLabel', () => {
    it('strips emoji from toolset rows', () => {
      expect(toolsetDisplayLabel({ name: 'cronjob', label: '⏰ Cron Jobs' })).toBe('Cron Jobs')
    })
  })

  describe('providerGroup', () => {
    it('maps a provider env var to its labeled group', () => {
      expect(providerGroup('XAI_API_KEY')).toBe('xAI')
      expect(providerGroup('NOUS_API_KEY')).toBe('Nous Portal')
      expect(providerGroup('OPENROUTER_API_KEY')).toBe('OpenRouter')
    })

    it('prefers the longest matching prefix so CN/regional buckets win', () => {
      expect(providerGroup('MINIMAX_CN_API_KEY')).toBe('MiniMax (China)')
      expect(providerGroup('MINIMAX_API_KEY')).toBe('MiniMax')
      expect(providerGroup('KIMI_CN_API_KEY')).toBe('Kimi (China)')
      expect(providerGroup('KIMI_API_KEY')).toBe('Kimi / Moonshot')
      expect(providerGroup('HERMES_QWEN_BASE_URL')).toBe('DashScope (Qwen)')
      expect(providerGroup('GEMINI_API_KEY')).toBe('Gemini')
    })

    it('falls back to "Other" for un-grouped env vars', () => {
      expect(providerGroup('SOMETHING_RANDOM')).toBe('Other')
    })
  })

  describe('voiceFieldVisible', () => {
    it('always shows top-level (non-provider-scoped) keys', () => {
      expect(voiceFieldVisible('tts.provider', {})).toBe(true)
      expect(voiceFieldVisible('voice.auto_tts', {})).toBe(true)
    })

    it('shows only the selected TTS provider’s sub-fields', () => {
      const config = { tts: { provider: 'openai' } }
      expect(voiceFieldVisible('tts.openai.voice', config)).toBe(true)
      expect(voiceFieldVisible('tts.elevenlabs.voice_id', config)).toBe(false)
    })

    it('hides all STT provider sub-fields when STT is disabled', () => {
      const config = { stt: { enabled: false, provider: 'local' } }
      expect(voiceFieldVisible('stt.local.model', config)).toBe(false)
    })

    it('shows the selected STT provider’s sub-fields when STT is enabled', () => {
      const config = { stt: { enabled: true, provider: 'local' } }
      expect(voiceFieldVisible('stt.local.model', config)).toBe(true)
      expect(voiceFieldVisible('stt.openai.model', config)).toBe(false)
    })
  })

  describe('enumOptionsFor — backend selector dropdowns', () => {
    const config: HermesConfigRecord = {}

    it('renders a dropdown for the TTS provider including xAI (Grok)', () => {
      const opts = enumOptionsFor('tts.provider', 'edge', config)
      expect(opts).toBeDefined()
      expect(opts).toContain('xai')
      expect(opts).toContain('edge')
      expect(opts).toContain('elevenlabs')
    })

    it('renders a dropdown for the STT provider including xAI (Grok)', () => {
      const opts = enumOptionsFor('stt.provider', 'local', config)
      expect(opts).toEqual(['local', 'groq', 'openai', 'mistral', 'xai', 'elevenlabs'])
    })

    it('renders dropdowns for per-backend model/device sub-fields', () => {
      expect(enumOptionsFor('stt.openai.model', 'whisper-1', config)).toContain('gpt-4o-transcribe')
      expect(enumOptionsFor('tts.openai.model', 'gpt-4o-mini-tts', config)).toContain('tts-1-hd')
      expect(enumOptionsFor('tts.neutts.device', 'cpu', config)).toEqual(['cpu', 'cuda', 'mps'])
    })

    it('renders a dropdown for the terminal execution backend', () => {
      const opts = enumOptionsFor('terminal.backend', 'local', config)
      expect(opts).toEqual(['local', 'docker', 'singularity', 'modal', 'daytona', 'ssh'])
    })

    it('appends a hand-typed value not in the known list so it stays selected', () => {
      const opts = enumOptionsFor('tts.provider', 'my-custom-command-tts', config)
      expect(opts).toContain('my-custom-command-tts')
      expect(opts).toContain('xai')
    })
  })
})
