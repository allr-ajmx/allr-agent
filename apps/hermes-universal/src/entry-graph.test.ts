import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Shiki must never be reachable from the app entry through STATIC imports.
 *
 * This is the assertion MJXHRM-380 was closed without. That ticket put
 * `lazy()` / dynamic `import()` in front of all four of the app's own shiki
 * entry points and measured the entry chunk shrink — and the engine still
 * loaded on every cold start, because `markdown-text.tsx` statically imported
 * `@streamdown/code`, which statically imports all of shiki. Four correct seams
 * defeated by a fifth importer nobody had enumerated. A byte-size check would
 * not have caught it either: the bytes DID move into a separate chunk; the
 * entry just kept a top-level static import OF that chunk.
 *
 * So the property worth asserting is reachability, not size — and it has to
 * cover node_modules, because that is where the defeat came from.
 *
 * How it works: parse every module reachable from `src/main.tsx` following
 * static edges only (import declarations, side-effect imports, `export … from`
 * re-exports, `import x = require()`, and CommonJS `require()`), and stop at
 * every `import()` expression, which is a chunk boundary rather than an entry
 * edge. Type-only imports are erased by the bundler, so they are skipped here
 * too; the repo lints `@typescript-eslint/consistent-type-imports` as an error,
 * which is what makes "type-only" decidable from syntax alone.
 */

// `import.meta.url` is an http URL under Vite's transform, so the app root
// comes from the process instead: vitest runs rooted at this package.
const APP_DIR = process.cwd()
const REPO_ROOT = path.resolve(APP_DIR, '../..')
const SRC = path.join(APP_DIR, 'src')
const ENTRY = path.join(SRC, 'main.tsx')

/** Package names that must not appear on the entry's static graph. */
const FORBIDDEN = ['shiki', 'react-shiki', '@shikijs', '@streamdown/code']

/**
 * Specifiers this walker cannot resolve, each verified by hand to be incapable
 * of reaching shiki. `#minpath` / `#minproc` / `#minurl` are vfile's private
 * node-vs-browser imports map; `react-remove-scroll-bar/constants` is a
 * two-constant module. A NEW entry here means the resolver has a blind spot —
 * check what it is before widening the list, because a blind spot is exactly
 * how an importer hides.
 */
const UNRESOLVED_ALLOWLIST = ['#minpath', '#minproc', '#minurl', 'react-remove-scroll-bar/constants']

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function resolveFile(candidate: string): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext

    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt
    }
  }

  for (const ext of INDEX_EXTENSIONS) {
    const index = path.join(candidate, `index${ext}`)

    if (fs.existsSync(index)) {
      return index
    }
  }

  return null
}

/** Pick the browser/ESM branch of an `exports` condition tree, as Vite does. */
function pickCondition(node: unknown): string | null {
  if (typeof node === 'string') {
    return node
  }

  if (!node || typeof node !== 'object') {
    return null
  }

  for (const key of ['browser', 'import', 'module', 'default', 'require']) {
    if (key in (node as Record<string, unknown>)) {
      const picked = pickCondition((node as Record<string, unknown>)[key])

      if (picked) {
        return picked
      }
    }
  }

  return null
}

function resolveBare(specifier: string, fromDir: string): string | null {
  const segments = specifier.split('/')
  const pkgName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const subpath = `.${specifier.slice(pkgName.length)}`

  let dir = fromDir

  while (dir.startsWith(REPO_ROOT)) {
    const pkgDir = path.join(dir, 'node_modules', pkgName)
    const manifest = path.join(pkgDir, 'package.json')

    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>
      const exportsField = pkg.exports as Record<string, unknown> | string | undefined
      let target: string | null = null

      if (typeof exportsField === 'string') {
        target = subpath === '.' ? exportsField : null
      } else if (exportsField) {
        target =
          exportsField[subpath] !== undefined
            ? pickCondition(exportsField[subpath])
            : subpath === '.'
              ? pickCondition(exportsField)
              : null
      }

      target ??= subpath === '.' ? ((pkg.module ?? pkg.main ?? 'index.js') as string) : subpath

      return resolveFile(path.join(pkgDir, target))
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return null
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolveFile(path.join(SRC, specifier.slice(2)))
  }

  if (specifier === '@hermes/plugin-sdk') {
    return resolveFile(path.join(SRC, 'sdk/index.ts'))
  }

  if (specifier.startsWith('.')) {
    const joined = path.join(path.dirname(fromFile), specifier)

    return resolveFile(joined.replace(/\.tsx?$/, '')) ?? resolveFile(joined)
  }

  // Node builtins, inline data, and Vite virtual modules carry no app code.
  if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('virtual:')) {
    return null
  }

  return resolveBare(specifier, path.dirname(fromFile))
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (file.endsWith('.ts')) {
    return ts.ScriptKind.TS
  }

  if (file.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  return ts.ScriptKind.JS
}

/** Every specifier this module pulls in WITHOUT crossing a chunk boundary. */
function staticSpecifiers(file: string): string[] {
  if (file.endsWith('.json') || file.endsWith('.css')) {
    return []
  }

  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    false,
    scriptKind(file)
  )

  const found: string[] = []

  const literal = (node: ts.Expression | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause

      // `import type … from` and `import { type A, type B } from` are erased by
      // the bundler, so they create no edge. A default/namespace binding or any
      // value specifier means the module is really pulled in.
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every(element => element.isTypeOnly))

      const specifier = literal(node.moduleSpecifier)

      if (specifier && !typeOnly) {
        found.push(specifier)
      }
    } else if (ts.isExportDeclaration(node)) {
      // `export … from 'x'` re-hoists x into this module — the trap that turns
      // a dynamic import somewhere else back into a static edge.
      const specifier = literal(node.moduleSpecifier)

      if (specifier && !node.isTypeOnly) {
        found.push(specifier)
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression)

      if (specifier) {
        found.push(specifier)
      }
    } else if (ts.isCallExpression(node)) {
      // `import(...)` is the boundary we are asserting exists — never followed.
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = literal(node.arguments[0])

        if (specifier) {
          found.push(specifier)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)

  return found
}

interface Graph {
  reached: Set<string>
  parent: Map<string, string>
  forbidden: { file: string; specifier: string }[]
  unresolved: Set<string>
}

function walkStaticGraph(): Graph {
  const reached = new Set<string>([ENTRY])
  const parent = new Map<string, string>()
  const forbidden: { file: string; specifier: string }[] = []
  const unresolved = new Set<string>()
  const queue = [ENTRY]

  const isForbidden = (specifier: string): boolean =>
    FORBIDDEN.some(name => specifier === name || specifier.startsWith(`${name}/`))

  while (queue.length > 0) {
    const file = queue.shift() as string

    for (const specifier of staticSpecifiers(file)) {
      if (isForbidden(specifier)) {
        forbidden.push({ file, specifier })
      }

      const resolved = resolveSpecifier(specifier, file)

      if (!resolved) {
        // Relative and aliased specifiers always resolve; asset imports carry
        // no JS. Only a bare specifier going missing is a real blind spot.
        if (
          !specifier.startsWith('.') &&
          !specifier.startsWith('@/') &&
          !/\.(css|svg|png|jpe?g|woff2?)$/.test(specifier)
        ) {
          unresolved.add(specifier)
        }

        continue
      }

      if (reached.has(resolved)) {
        continue
      }

      reached.add(resolved)
      parent.set(resolved, file)
      queue.push(resolved)
    }
  }

  return { forbidden, parent, reached, unresolved }
}

function chainTo(graph: Graph, file: string): string[] {
  const chain: string[] = []
  let current: string | undefined = file

  while (current && chain.length < 64) {
    chain.push(path.relative(REPO_ROOT, current))
    current = graph.parent.get(current)
  }

  return chain.reverse()
}

describe('entry import graph', () => {
  const graph = walkStaticGraph()

  it('reaches the app through the entry at all', () => {
    // Guards the guard: if resolution broke, the walk would find nothing and
    // every assertion below would pass vacuously.
    expect(graph.reached.size).toBeGreaterThan(1_000)
    expect([...graph.reached].some(file => file.endsWith('/src/app.tsx'))).toBe(true)
    expect([...graph.reached].some(file => file.includes('/node_modules/streamdown/'))).toBe(true)
  })

  it('resolves every bare specifier it walks past, except the known-inert ones', () => {
    expect([...graph.unresolved].sort()).toEqual(UNRESOLVED_ALLOWLIST)
  })

  it('never reaches shiki through a static import', () => {
    const detail = graph.forbidden
      .map(
        hit =>
          `${hit.specifier} imported by ${path.relative(REPO_ROOT, hit.file)}\n  ${chainTo(graph, hit.file).join('\n  -> ')}`
      )
      .join('\n\n')

    expect(detail).toBe('')
  })

  it('never pulls a shiki module itself onto the entry graph', () => {
    const modules = [...graph.reached]
      .filter(file => /node_modules\/(shiki|react-shiki|@shikijs|@streamdown\/code)\//.test(file))
      .map(file => `${path.relative(REPO_ROOT, file)}\n  ${chainTo(graph, file).join('\n  -> ')}`)

    expect(modules).toEqual([])
  })

  it('keeps the shiki entry points behind a dynamic boundary', () => {
    // The complement of the assertions above: the seams must still EXIST, or
    // "not statically reachable" would be satisfied by deleting highlighting.
    const seams = [
      ['components/chat/shiki-highlighter.tsx', "lazy(() => import('@/components/chat/shiki-block'))"],
      ['components/chat/diff-lines.tsx', "React.lazy(() => import('@/components/chat/diff-lines-shiki'))"],
      ['components/chat/diff-lines.tsx', "import('shiki')"],
      ['app/right-pane/preview/preview-file.tsx', "lazy(() => import('@/app/right-pane/preview/preview-shiki-block'))"]
    ] as const

    for (const [file, seam] of seams) {
      expect(fs.readFileSync(path.join(SRC, file), 'utf8')).toContain(seam)
    }
  })
})
