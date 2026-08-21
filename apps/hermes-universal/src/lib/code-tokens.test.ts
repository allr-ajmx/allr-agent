import { describe, expect, it } from 'vitest'

import { canTokenize, grammarKeyFor, type Token, tokenizeCode } from '@/lib/code-tokens'

const join = (tokens: Token[]): string => tokens.map(token => token.text).join('')

const kindOf = (tokens: Token[], needle: string): string | undefined =>
  tokens.find(token => token.text.includes(needle))?.kind

/** Every grammar key plus a few aliases and one tag with no grammar at all. */
const LANGUAGES = [
  'c',
  'csharp',
  'css',
  'dart',
  'diff',
  'dockerfile',
  'go',
  'java',
  'javascript',
  'json',
  'kotlin',
  'makefile',
  'markup',
  'perl',
  'php',
  'python',
  'r',
  'ruby',
  'rust',
  'scala',
  'shell',
  'sql',
  'swift',
  'toml',
  'typescript',
  'yaml',
  // aliases
  'ts',
  'tsx',
  'py',
  'sh',
  'html',
  'yml',
  'c++',
  // no grammar
  'brainfuck',
  ''
]

/**
 * Inputs chosen to break a scanner rather than to look like code: unterminated
 * everything, delimiters that never close, tabs, CRLF, lone quotes.
 */
const HOSTILE = [
  '',
  '\n',
  '\n\n\n',
  '   ',
  '\t\tindented\n\t\tmore',
  'a\r\nb\r\nc',
  'trailing newline\n',
  '"unterminated string',
  "it's a lone apostrophe in prose",
  '/* unterminated block comment',
  '<!-- unterminated markup comment',
  '`unterminated template',
  '"""unterminated triple',
  '// comment with no newline',
  '#',
  '<',
  '</',
  '<>',
  '<a href="x">text</a>',
  '0x1F 0b1010 1_000 1.5e-3 .5 1..2',
  'ident123 _under $dollar café λ',
  '{"a": [1, 2, null], "b": true}',
  'SELECT * FROM t -- trailing\nWHERE x = 1;',
  '@@ -1,2 +1,3 @@\n-old\n+new\n context',
  'def f(x):\n    """doc"""\n    return x\n',
  'const a = `tpl ${b} end`\n// done\n'
]

describe('tokenizeCode', () => {
  // THE invariant. Everything else in this file is a nicety; this is the reason
  // the code fence can render tokens instead of a raw string without risking a
  // lost character or a lost newline (ALLR-30).
  describe('partitions its input exactly', () => {
    it.each(LANGUAGES)('language %s', language => {
      for (const input of HOSTILE) {
        expect(join(tokenizeCode(input, language))).toBe(input)
      }
    })
  })

  it('partitions a large realistic input', () => {
    const big = Array.from({ length: 3_000 }, (_, i) => `  const value${i} = "line ${i}" // note`).join('\n')

    expect(join(tokenizeCode(big, 'typescript'))).toBe(big)
  })

  it('never throws, on any byte soup', () => {
    const alphabet = `abc{}[]()<>"'\`\\/*#-+=@$_ \n\t.:;0123456789`

    for (let seed = 0; seed < 200; seed += 1) {
      let input = ''

      // Deterministic pseudo-random: a test that fails must fail again.
      for (let i = 0, x = seed * 2654435761; i < 80; i += 1) {
        x = (x * 1103515245 + 12345) >>> 0
        input += alphabet[x % alphabet.length]
      }

      for (const language of ['typescript', 'python', 'markup', 'sql', 'diff']) {
        expect(() => tokenizeCode(input, language)).not.toThrow()
        expect(join(tokenizeCode(input, language))).toBe(input)
      }
    }
  })

  it('returns nothing for empty input', () => {
    expect(tokenizeCode('', 'typescript')).toEqual([])
  })

  it('returns one plain token for a language it does not know', () => {
    const code = 'BEGIN { print "hi" }'

    expect(tokenizeCode(code, 'awk')).toEqual([{ kind: 'plain', text: code }])
    expect(tokenizeCode(code, '')).toEqual([{ kind: 'plain', text: code }])
  })
})

describe('grammar selection', () => {
  it('resolves aliases to a shared grammar', () => {
    expect(grammarKeyFor('ts')).toBe('typescript')
    expect(grammarKeyFor('TSX')).toBe('typescript')
    expect(grammarKeyFor('py')).toBe('python')
    expect(grammarKeyFor('zsh')).toBe('shell')
    expect(grammarKeyFor('svg')).toBe('markup')
  })

  it('reports the languages it has no grammar for', () => {
    expect(grammarKeyFor('brainfuck')).toBeNull()
    expect(grammarKeyFor('')).toBeNull()
    expect(canTokenize('python')).toBe(true)
    expect(canTokenize('cobol')).toBe(false)
  })
})

describe('per-family recognition', () => {
  it('reads C-style and hash-style comments', () => {
    expect(kindOf(tokenizeCode('x = 1 // note', 'go'), '// note')).toBe('comment')
    expect(kindOf(tokenizeCode('x = 1 # note', 'python'), '# note')).toBe('comment')
    expect(kindOf(tokenizeCode('/* a */ b', 'c'), '/* a */')).toBe('comment')
  })

  it('reads SQL case-insensitively and treats -- as a comment', () => {
    expect(kindOf(tokenizeCode('SELECT 1', 'sql'), 'SELECT')).toBe('keyword')
    expect(kindOf(tokenizeCode('select 1', 'sql'), 'select')).toBe('keyword')
    expect(kindOf(tokenizeCode('x -- note', 'sql'), '-- note')).toBe('comment')
    // The same marker is arithmetic elsewhere, not a comment.
    expect(kindOf(tokenizeCode('a -- b', 'javascript'), '--')).toBe('plain')
  })

  it('separates keywords from types', () => {
    expect(kindOf(tokenizeCode('let x: number', 'typescript'), 'let')).toBe('keyword')
    expect(kindOf(tokenizeCode('let x: number', 'typescript'), 'number')).toBe('type')
  })

  it('does not carry one language keywords into another', () => {
    expect(kindOf(tokenizeCode('func x', 'go'), 'func')).toBe('keyword')
    expect(kindOf(tokenizeCode('func x', 'java'), 'func')).toBe('plain')
  })

  it('marks an identifier before an open paren as a call', () => {
    expect(kindOf(tokenizeCode('render(x)', 'javascript'), 'render')).toBe('function')
    expect(kindOf(tokenizeCode('render = x', 'javascript'), 'render')).toBe('plain')
  })

  it('reads markup tags, attributes and attribute values', () => {
    const tokens = tokenizeCode('<a href="/x" class=y>text</a>', 'html')

    expect(kindOf(tokens, 'href')).toBe('attr')
    expect(kindOf(tokens, '"/x"')).toBe('string')
    expect(tokens.filter(token => token.kind === 'tag').map(token => token.text)).toEqual(['a', 'a'])
  })

  it('reads a diff by line marker', () => {
    const tokens = tokenizeCode('@@ -1 +1 @@\n-gone\n+added\n same\n', 'diff')

    expect(kindOf(tokens, '@@')).toBe('comment')
    expect(kindOf(tokens, '-gone')).toBe('keyword')
    expect(kindOf(tokens, '+added')).toBe('tag')
    expect(kindOf(tokens, ' same')).toBe('plain')
  })

  it('keeps a triple-quoted Python docstring in one token', () => {
    const tokens = tokenizeCode('def f():\n    """line one\n    line two"""\n', 'python')

    expect(kindOf(tokens, 'line two')).toBe('string')
    expect(kindOf(tokens, 'def')).toBe('keyword')
  })

  it('stops a single-quoted literal at the end of its line', () => {
    // Prose in a comment or a shell script routinely contains one apostrophe.
    // Without the EOL stop it would stain everything after it.
    const tokens = tokenizeCode("echo don't\nexport PATH=/bin\n", 'shell')

    expect(kindOf(tokens, 'export')).toBe('keyword')
  })
})
