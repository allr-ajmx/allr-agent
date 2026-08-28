import { type FC, Fragment } from 'react'

import type { Token, TokenKind } from '@/lib/code-tokens'

/**
 * The token → DOM layer, shared by every code surface this app owns.
 *
 * It used to live inside `components/chat/code-fence.tsx`. It is here so the
 * file preview can render the SAME elements instead of growing a second
 * implementation — the fence's structure is the one ALLR-30 proved out, and the
 * point of sharing it is that there is nothing left to diverge. `CodeFence`
 * itself is unchanged apart from importing this instead of declaring it.
 *
 * The structural rules from the fence's header comment apply to every caller:
 * WE render the elements, nothing third-party sits between the `<pre>` and the
 * text, and anything whose absence would make the block unreadable or
 * geometrically wrong is an INLINE STYLE rather than a class.
 */

/**
 * Custom properties rather than literal hex, so a theme flip repaints with no
 * JS and no re-tokenizing. The `currentColor` fallback is the point: if a
 * property is ever missing the declaration still resolves, and the token renders
 * in the surrounding text colour instead of disappearing.
 *
 * `plain` has no entry on purpose — a plain token renders as a bare text node,
 * exactly as in the un-tokenized path, which is both fewer DOM nodes and one
 * less way for the two paths to differ.
 */
export const TOKEN_COLOR: Partial<Record<TokenKind, string>> = {
  attr: 'var(--code-attr, currentColor)',
  comment: 'var(--code-com, currentColor)',
  function: 'var(--code-fn, currentColor)',
  keyword: 'var(--code-kw, currentColor)',
  number: 'var(--code-num, currentColor)',
  string: 'var(--code-str, currentColor)',
  tag: 'var(--code-tag, currentColor)',
  type: 'var(--code-type, currentColor)'
}

/**
 * `tokenizeCode` guarantees a partition of the input, so concatenating what this
 * renders reproduces the source character for character — including newlines,
 * which the enclosing `white-space: pre` turns into lines. A colour can be
 * wrong; a character can never be missing.
 */
export const CodeTokenBody: FC<{ tokens: Token[] }> = ({ tokens }) => (
  <>
    {tokens.map((token, index) => {
      const color = TOKEN_COLOR[token.kind]

      return color ? (
        <span key={index} style={{ color }}>
          {token.text}
        </span>
      ) : (
        <Fragment key={index}>{token.text}</Fragment>
      )
    })}
  </>
)
