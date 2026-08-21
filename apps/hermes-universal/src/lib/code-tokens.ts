/**
 * A syntax tokenizer with NO dependencies.
 *
 * The code fence used to reach TextMate grammars through react-shiki, which
 * meant its colours arrived from a lazy chunk, through a WASM regex engine,
 * into DOM this app did not own. On a signed iOS build that chain produced a
 * fence collapsed onto a single line and nobody could explain which link did it
 * (ALLR-30). So colour stops being something we fetch and becomes something we
 * compute: one synchronous pass, no imports, no network, no engine to fail.
 *
 * The fidelity trade is real and deliberate. This recognises comments, strings,
 * numbers, keywords, type names, call sites and markup tags — not semantics, not
 * nested template interpolation, not JSX inside a string. A token can come out
 * the wrong COLOUR. It cannot come out the wrong SHAPE, because the output is a
 * partition of the input: concatenating every token's text reproduces the input
 * character for character, and `code-tokens.test.ts` asserts exactly that for
 * every language. That property is what lets the fence render tokens with no
 * risk of losing a character or a newline relative to rendering the raw string.
 *
 * An unrecognised language is not an error — it yields one `plain` token holding
 * the whole input, which the fence renders as plain code. There is no failure
 * mode in this module: `tokenizeCode` never throws.
 */

export type TokenKind = 'attr' | 'comment' | 'function' | 'keyword' | 'number' | 'plain' | 'string' | 'tag' | 'type'

export interface Token {
  kind: TokenKind
  text: string
}

interface StringRule {
  /** Closing delimiter; usually the same as `open`. */
  close: string
  /** Backslash-style escape, or null for raw strings (Go backticks). */
  escape: string | null
  /**
   * Whether the literal survives a newline. A non-multiline literal ends at EOL,
   * which is what keeps one stray apostrophe from staining the rest of a file.
   */
  multiline: boolean
  /** Opening delimiter. */
  open: string
}

interface Grammar {
  blockComment: [string, string][]
  caseInsensitive: boolean
  keywords: Set<string>
  lineComment: string[]
  /** Tag/attribute scanning instead of the identifier scanner (HTML, XML, SVG). */
  markup: boolean
  strings: StringRule[]
  types: Set<string>
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean))

const quoted = (open: string, close = open, escape: string | null = '\\', multiline = false): StringRule => ({
  close,
  escape,
  multiline,
  open
})

// Single- and double-quoted with backslash escapes, ending at EOL. The default
// for nearly every language here.
const BASIC_STRINGS: StringRule[] = [quoted('"'), quoted("'")]

const SLASH_COMMENTS = { blockComment: [['/*', '*/']] as [string, string][], lineComment: ['//'] }

// -- keyword tables ---------------------------------------------------------
//
// Per language rather than per family: a union set would colour Go's `func` as a
// keyword inside Java. Literals (`true`, `null`, ...) fold into `keywords`
// because they read as keywords at a glance and a separate colour for them buys
// nothing at 11px.

const JS_KEYWORDS = `as async await break case catch class const continue debugger default delete do else export
  extends false finally for from function get if import in instanceof let new null of return set static super switch
  this throw true try typeof undefined var void while with yield NaN Infinity`

const TS_KEYWORDS = `${JS_KEYWORDS} abstract asserts declare enum implements infer interface is keyof namespace
  override private protected public readonly satisfies type`

const TS_TYPES = `any bigint boolean never number object string symbol unknown Array Promise Record Partial Readonly
  Pick Omit Map Set Date RegExp Error`

const PYTHON_KEYWORDS = `and as assert async await break class continue def del elif else except False finally for
  from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self`

const PYTHON_TYPES = `bool bytes dict float frozenset int list object set str tuple type Any Callable Dict List
  Optional Sequence Tuple Union`

const GO_KEYWORDS = `break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var nil true false iota`

const GO_TYPES = `any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
  uint uint8 uint16 uint32 uint64 uintptr`

const RUST_KEYWORDS = `as async await break const continue crate dyn else enum extern false fn for if impl in let
  loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while`

const RUST_TYPES = `bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option
  Result Box Rc Arc HashMap`

const JAVA_KEYWORDS = `abstract assert break case catch class const continue default do else enum extends final
  finally for goto if implements import instanceof interface native new package private protected public return
  static strictfp super switch synchronized this throw throws transient try var void volatile while true false null
  record sealed yield`

const JAVA_TYPES = `boolean byte char double float int long short Boolean Byte Character Double Float Integer Long
  Object Short String List Map Set Optional Stream`

const C_KEYWORDS = `auto break case char const continue default do double else enum extern float for goto if inline
  int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile
  while alignas alignof bool class catch constexpr decltype delete explicit false friend mutable namespace new
  noexcept nullptr operator override private protected public template this throw true try typeid typename using
  virtual`

const C_TYPES = `int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t ptrdiff_t
  std string vector map set unique_ptr shared_ptr`

const CSHARP_KEYWORDS = `abstract as async await base break case catch checked class const continue default delegate
  do else enum event explicit extern false finally fixed for foreach get goto if implicit in interface internal is
  lock namespace new null operator out override params private protected public readonly record ref return sealed
  set sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using var virtual void
  volatile while yield`

const CSHARP_TYPES = `bool byte char decimal double dynamic float int long nint nuint object sbyte short string uint
  ulong ushort List Dictionary Task IEnumerable Nullable`

const SWIFT_KEYWORDS = `as associatedtype async await break case catch class continue default defer deinit do else
  enum extension fallthrough false fileprivate final for func guard if import in init inout internal is lazy let
  nil open operator private protocol public repeat rethrows return self Self static struct subscript super switch
  throw throws true try typealias var weak where while`

const SWIFT_TYPES = `Any Array Bool Character Data Dictionary Double Error Float Int Int8 Int16 Int32 Int64 Optional
  Set String UInt Void`

const KOTLIN_KEYWORDS = `abstract actual annotation as break by catch class companion const constructor continue
  crossinline data delegate do dynamic else enum expect external false final finally for fun get if import in
  infix init inline inner interface internal is lateinit noinline null object open operator out override
  package private protected public reified return sealed set super suspend tailrec this throw true try typealias
  val var vararg when where while`

const KOTLIN_TYPES = `Any Array Boolean Byte Char Double Float Int List Long Map Nothing Number Set Short String
  Unit MutableList MutableMap`

const PHP_KEYWORDS = `abstract and array as break callable case catch class clone const continue declare default do
  echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for
  foreach function global goto if implements include include_once instanceof insteadof interface isset list match
  namespace new or print private protected public readonly require require_once return static switch throw trait
  try unset use var while xor yield true false null`

const PHP_TYPES = `bool float int iterable mixed object string void self parent never`

const SCALA_KEYWORDS = `abstract case catch class def do else extends false final finally for forSome given if
  implicit import lazy match new null object override package private protected return sealed super this throw
  trait true try type val var while with yield`

const SCALA_TYPES = `Any AnyRef Array Boolean Byte Char Double Either Float Int List Long Map Nothing Option Seq Set
  Short String Unit Vector`

const DART_KEYWORDS = `abstract as assert async await break case catch class const continue covariant default
  deferred do dynamic else enum export extends extension external factory false final finally for get hide if
  implements import in interface is late library mixin new null on operator part required rethrow return sealed
  set show static super switch sync this throw true try typedef var while with yield`

const DART_TYPES = `bool double Duration Function Future int List Map Object Set String Stream Symbol Type void`

const RUBY_KEYWORDS = `alias and begin break case class def defined? do else elsif end ensure false for if in module
  next nil not or redo rescue retry return self super then true undef unless until when while yield attr_accessor
  attr_reader attr_writer require require_relative include extend lambda proc raise puts`

const SHELL_KEYWORDS = `alias bg break case cd continue declare do done echo elif else esac eval exec exit export
  false fi for function getopts hash if in local printf pushd popd read readonly return select set shift source
  test then time trap true type ulimit umask unalias unset until wait while`

const PERL_KEYWORDS = `and bless cmp continue do else elsif eq eval exists for foreach ge gt if last le local lt
  my ne next no not or our package print printf redo ref require return sub then unless until use wantarray when
  while x xor`

const R_KEYWORDS = `break else for function if in next repeat return while TRUE FALSE NULL NA NA_integer_
  NA_real_ NA_character_ Inf NaN library require`

const SQL_KEYWORDS = `add all alter and any as asc backup between by case check column constraint create database
  default delete desc distinct drop else end exec exists foreign from full group having if in index inner insert
  into is join key left like limit not null offset on or order outer primary procedure references replace right
  rollback select set table then top truncate union unique update values view when where with`

const SQL_TYPES = `bigint binary bit blob boolean char date datetime decimal double float int integer json numeric
  real serial smallint text time timestamp uuid varchar`

const CSS_KEYWORDS = `and charset container document font-face import keyframes layer media not only page property
  supports scope important inherit initial unset revert auto none`

const YAML_KEYWORDS = `true false null yes no on off`

const TOML_KEYWORDS = `true false`

const JSON_KEYWORDS = `true false null`

const DOCKERFILE_KEYWORDS = `add arg cmd copy entrypoint env expose from healthcheck label maintainer onbuild run
  shell stopsignal user volume workdir as`

const MAKE_KEYWORDS = `define else endef endif export ifdef ifeq ifndef ifneq include override private unexport
  vpath`

// -- grammars ---------------------------------------------------------------

function grammar(spec: Partial<Grammar>): Grammar {
  return {
    blockComment: [],
    caseInsensitive: false,
    keywords: new Set(),
    lineComment: [],
    markup: false,
    strings: [],
    types: new Set(),
    ...spec
  }
}

// Backtick template literals are multiline; `${}` interpolation is deliberately
// not parsed, so an interpolated expression reads as part of the string.
const JS_STRINGS: StringRule[] = [...BASIC_STRINGS, quoted('`', '`', '\\', true)]

const GRAMMARS: Record<string, Grammar> = {
  c: grammar({ ...SLASH_COMMENTS, keywords: words(C_KEYWORDS), strings: BASIC_STRINGS, types: words(C_TYPES) }),
  csharp: grammar({
    ...SLASH_COMMENTS,
    keywords: words(CSHARP_KEYWORDS),
    strings: BASIC_STRINGS,
    types: words(CSHARP_TYPES)
  }),
  css: grammar({
    blockComment: [['/*', '*/']],
    keywords: words(CSS_KEYWORDS),
    lineComment: ['//'],
    strings: BASIC_STRINGS
  }),
  dart: grammar({ ...SLASH_COMMENTS, keywords: words(DART_KEYWORDS), strings: JS_STRINGS, types: words(DART_TYPES) }),
  diff: grammar({}),
  dockerfile: grammar({ keywords: words(DOCKERFILE_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS }),
  go: grammar({
    ...SLASH_COMMENTS,
    keywords: words(GO_KEYWORDS),
    // Backticks are Go's RAW string: no escapes, spans newlines.
    strings: [...BASIC_STRINGS, quoted('`', '`', null, true)],
    types: words(GO_TYPES)
  }),
  java: grammar({
    ...SLASH_COMMENTS,
    keywords: words(JAVA_KEYWORDS),
    strings: BASIC_STRINGS,
    types: words(JAVA_TYPES)
  }),
  javascript: grammar({ ...SLASH_COMMENTS, keywords: words(JS_KEYWORDS), strings: JS_STRINGS }),
  json: grammar({ keywords: words(JSON_KEYWORDS), lineComment: ['//'], strings: BASIC_STRINGS }),
  kotlin: grammar({
    ...SLASH_COMMENTS,
    keywords: words(KOTLIN_KEYWORDS),
    strings: [quoted('"""', '"""', null, true), ...BASIC_STRINGS],
    types: words(KOTLIN_TYPES)
  }),
  makefile: grammar({ keywords: words(MAKE_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS }),
  markup: grammar({ blockComment: [['<!--', '-->']], markup: true, strings: BASIC_STRINGS }),
  perl: grammar({ keywords: words(PERL_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS }),
  php: grammar({
    ...SLASH_COMMENTS,
    keywords: words(PHP_KEYWORDS),
    lineComment: ['//', '#'],
    strings: BASIC_STRINGS,
    types: words(PHP_TYPES)
  }),
  python: grammar({
    keywords: words(PYTHON_KEYWORDS),
    lineComment: ['#'],
    // Triple quotes first: `"""` must win over `"` at the same offset.
    strings: [quoted('"""', '"""', '\\', true), quoted("'''", "'''", '\\', true), ...BASIC_STRINGS],
    types: words(PYTHON_TYPES)
  }),
  r: grammar({ keywords: words(R_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS }),
  ruby: grammar({
    blockComment: [['=begin', '=end']],
    keywords: words(RUBY_KEYWORDS),
    lineComment: ['#'],
    strings: BASIC_STRINGS
  }),
  rust: grammar({
    ...SLASH_COMMENTS,
    keywords: words(RUST_KEYWORDS),
    strings: BASIC_STRINGS,
    types: words(RUST_TYPES)
  }),
  scala: grammar({
    ...SLASH_COMMENTS,
    keywords: words(SCALA_KEYWORDS),
    strings: [quoted('"""', '"""', null, true), ...BASIC_STRINGS],
    types: words(SCALA_TYPES)
  }),
  shell: grammar({ keywords: words(SHELL_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS }),
  sql: grammar({
    blockComment: [['/*', '*/']],
    caseInsensitive: true,
    keywords: words(SQL_KEYWORDS),
    lineComment: ['--'],
    strings: BASIC_STRINGS,
    types: words(SQL_TYPES)
  }),
  swift: grammar({
    ...SLASH_COMMENTS,
    keywords: words(SWIFT_KEYWORDS),
    strings: [quoted('"""', '"""', '\\', true), ...BASIC_STRINGS],
    types: words(SWIFT_TYPES)
  }),
  toml: grammar({
    keywords: words(TOML_KEYWORDS),
    lineComment: ['#'],
    strings: [quoted('"""', '"""', '\\', true), ...BASIC_STRINGS]
  }),
  typescript: grammar({ ...SLASH_COMMENTS, keywords: words(TS_KEYWORDS), strings: JS_STRINGS, types: words(TS_TYPES) }),
  yaml: grammar({ keywords: words(YAML_KEYWORDS), lineComment: ['#'], strings: BASIC_STRINGS })
}

/** Fence info string → grammar key. Anything absent renders plain. */
const ALIASES: Record<string, string> = {
  'c#': 'csharp',
  'c++': 'c',
  'objective-c': 'c',
  bash: 'shell',
  cc: 'c',
  cjs: 'javascript',
  cmake: 'makefile',
  conf: 'toml',
  cpp: 'c',
  cs: 'csharp',
  cxx: 'c',
  docker: 'dockerfile',
  fish: 'shell',
  golang: 'go',
  h: 'c',
  hpp: 'c',
  htm: 'markup',
  html: 'markup',
  ini: 'toml',
  json5: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  make: 'makefile',
  mjs: 'javascript',
  mm: 'c',
  objc: 'c',
  patch: 'diff',
  pl: 'perl',
  postgres: 'sql',
  postgresql: 'sql',
  ps1: 'shell',
  psql: 'sql',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'css',
  scss: 'css',
  sh: 'shell',
  sqlite: 'sql',
  svelte: 'markup',
  svg: 'markup',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'markup',
  xml: 'markup',
  yml: 'yaml',
  zsh: 'shell'
}

export function grammarKeyFor(language: string): string | null {
  const key = language.trim().toLowerCase()

  if (!key) {
    return null
  }

  const resolved = ALIASES[key] ?? key

  return resolved in GRAMMARS ? resolved : null
}

/** True when this module has a grammar for the tag — used to skip work upstream. */
export function canTokenize(language: string): boolean {
  return grammarKeyFor(language) !== null
}

// -- scanner ----------------------------------------------------------------

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'

// Anything above ASCII counts as an identifier character. Cheaper than a Unicode
// property escape and wrong only in ways that cost a colour, never a character.
const isIdentStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$' || ch.charCodeAt(0) > 127

const isIdentPart = (ch: string): boolean => isIdentStart(ch) || isDigit(ch)

/**
 * Collects tokens while guaranteeing the partition property: `plain` runs are
 * accumulated implicitly between marked tokens and flushed on demand, so every
 * character of the input lands in exactly one token, in order.
 */
class TokenSink {
  private out: Token[] = []
  private plainFrom = 0

  constructor(private readonly src: string) {}

  finish(end: number): Token[] {
    this.flush(end)

    return this.out
  }

  /** Mark `[from, to)` as `kind`, flushing anything plain before it. */
  mark(from: number, to: number, kind: TokenKind): void {
    if (to <= from) {
      return
    }

    this.flush(from)
    this.push(kind, this.src.slice(from, to))
    this.plainFrom = to
  }

  private flush(upTo: number): void {
    if (upTo > this.plainFrom) {
      this.push('plain', this.src.slice(this.plainFrom, upTo))
      this.plainFrom = upTo
    }
  }

  // Merge with the previous token when the kind matches — fewer spans for the
  // fence to render, and no observable difference in the concatenated text.
  private push(kind: TokenKind, text: string): void {
    const last = this.out[this.out.length - 1]

    if (last && last.kind === kind) {
      last.text += text
    } else {
      this.out.push({ kind, text })
    }
  }
}

/** Consume a string literal starting at `open`; returns the index just past it. */
function scanString(src: string, start: number, rule: StringRule): number {
  let i = start + rule.open.length

  while (i < src.length) {
    const ch = src[i]

    if (rule.escape && ch === rule.escape) {
      i += 2

      continue
    }

    if (!rule.multiline && ch === '\n') {
      return i
    }

    if (src.startsWith(rule.close, i)) {
      return i + rule.close.length
    }

    i += 1
  }

  return src.length
}

/** Consume a numeric literal; tolerant of hex, binary, separators and exponents. */
function scanNumber(src: string, start: number): number {
  let i = start

  while (i < src.length) {
    const ch = src[i]

    if (isIdentPart(ch) || ch === '.') {
      i += 1

      continue
    }

    // Exponent sign, but only immediately after the exponent marker.
    if ((ch === '+' || ch === '-') && i > start && 'eEpP'.includes(src[i - 1])) {
      i += 1

      continue
    }

    break
  }

  return i
}

function classifyWord(word: string, spec: Grammar): TokenKind | null {
  const probe = spec.caseInsensitive ? word.toLowerCase() : word

  if (spec.keywords.has(probe)) {
    return 'keyword'
  }

  if (spec.types.has(probe)) {
    return 'type'
  }

  return null
}

function tokenizeGeneric(src: string, spec: Grammar): Token[] {
  const sink = new TokenSink(src)
  let i = 0

  outer: while (i < src.length) {
    const ch = src[i]

    for (const marker of spec.lineComment) {
      if (src.startsWith(marker, i)) {
        const nl = src.indexOf('\n', i)
        const end = nl === -1 ? src.length : nl
        sink.mark(i, end, 'comment')
        i = end

        continue outer
      }
    }

    for (const [open, close] of spec.blockComment) {
      if (src.startsWith(open, i)) {
        const found = src.indexOf(close, i + open.length)
        const end = found === -1 ? src.length : found + close.length
        sink.mark(i, end, 'comment')
        i = end

        continue outer
      }
    }

    for (const rule of spec.strings) {
      if (src.startsWith(rule.open, i)) {
        const end = scanString(src, i, rule)
        sink.mark(i, end, 'string')
        i = end

        continue outer
      }
    }

    if (isDigit(ch)) {
      const end = scanNumber(src, i)
      sink.mark(i, end, 'number')
      i = end

      continue
    }

    if (isIdentStart(ch)) {
      let end = i + 1

      while (end < src.length && isIdentPart(src[end])) {
        end += 1
      }

      let kind = classifyWord(src.slice(i, end), spec)

      if (!kind) {
        // A bare identifier immediately followed by `(` is a call or a
        // declaration. Cheap, language-agnostic, and the single highest-value
        // signal available without a parser.
        let probe = end

        while (probe < src.length && (src[probe] === ' ' || src[probe] === '\t')) {
          probe += 1
        }

        kind = src[probe] === '(' ? 'function' : null
      }

      if (kind) {
        sink.mark(i, end, kind)
      }

      i = end

      continue
    }

    i += 1
  }

  return sink.finish(src.length)
}

const isTagNameChar = (ch: string): boolean => isIdentPart(ch) || ch === '-' || ch === ':' || ch === '.'

function tokenizeMarkup(src: string, spec: Grammar): Token[] {
  const sink = new TokenSink(src)
  let i = 0

  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const found = src.indexOf('-->', i + 4)
      const end = found === -1 ? src.length : found + 3
      sink.mark(i, end, 'comment')
      i = end

      continue
    }

    if (src[i] !== '<') {
      i += 1

      continue
    }

    // `<`, an optional `/`, `!` or `?`, then the tag name.
    let cursor = i + 1

    while (cursor < src.length && (src[cursor] === '/' || src[cursor] === '!' || src[cursor] === '?')) {
      cursor += 1
    }

    const nameStart = cursor

    while (cursor < src.length && isTagNameChar(src[cursor])) {
      cursor += 1
    }

    if (cursor === nameStart) {
      i += 1

      continue
    }

    sink.mark(nameStart, cursor, 'tag')

    // Inside the tag: attribute names, quoted values, everything else plain.
    while (cursor < src.length && src[cursor] !== '>') {
      const ch = src[cursor]

      if (ch === '"' || ch === "'") {
        const rule = spec.strings.find(candidate => candidate.open === ch) ?? quoted(ch)
        const end = scanString(src, cursor, rule)
        sink.mark(cursor, end, 'string')
        cursor = end

        continue
      }

      if (isIdentStart(ch)) {
        let end = cursor + 1

        while (end < src.length && isTagNameChar(src[end])) {
          end += 1
        }

        sink.mark(cursor, end, 'attr')
        cursor = end

        continue
      }

      cursor += 1
    }

    i = cursor
  }

  return sink.finish(src.length)
}

/**
 * A diff is coloured by LINE, not by syntax — the marker in column one is the
 * whole meaning. Reuses `tag` (green) and `keyword` (red) rather than inventing
 * add/remove kinds, so the palette stays at nine entries.
 */
function tokenizeDiff(src: string): Token[] {
  const sink = new TokenSink(src)
  let i = 0

  while (i < src.length) {
    const nl = src.indexOf('\n', i)
    const end = nl === -1 ? src.length : nl + 1
    const ch = src[i]

    if (src.startsWith('@@', i) || src.startsWith('diff ', i) || src.startsWith('index ', i)) {
      sink.mark(i, end, 'comment')
    } else if (ch === '+') {
      sink.mark(i, end, src.startsWith('+++', i) ? 'comment' : 'tag')
    } else if (ch === '-') {
      sink.mark(i, end, src.startsWith('---', i) ? 'comment' : 'keyword')
    }

    i = end
  }

  return sink.finish(src.length)
}

/**
 * Tokenize `code` for `language`.
 *
 * Never throws, and never loses input: `tokenizeCode(c, l).map(t => t.text).join('')`
 * equals `c` for every input and every language, including unknown ones.
 */
export function tokenizeCode(code: string, language: string): Token[] {
  if (!code) {
    return []
  }

  const key = grammarKeyFor(language)

  if (!key) {
    return [{ kind: 'plain', text: code }]
  }

  try {
    if (key === 'diff') {
      return tokenizeDiff(code)
    }

    const spec = GRAMMARS[key]

    return spec.markup ? tokenizeMarkup(code, spec) : tokenizeGeneric(code, spec)
  } catch {
    // Unreachable by construction, and that is exactly why it is caught: a fence
    // must never lose its content to a bug in its colours.
    return [{ kind: 'plain', text: code }]
  }
}
