/**
 * Shared ESLint flat config for all Hermes TS workspaces.
 *
 * Usage in a workspace's eslint.config.mjs:
 *
 *   import config from '../../eslint.config.shared.mjs'
 *
 *   export default [
 *     ...config,
 *     // workspace-specific overrides here
 *   ]
 */

import js from '@eslint/js'
import tseslint from 'typescript-eslint';
import perfectionist from 'eslint-plugin-perfectionist'
import hooksPlugin from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'src/**/*.js', '**/package-lock.json']
  },
  {
    // A disable directive is a documented decision about ONE rule hit. Once the
    // code under it changes and the rule stops firing, the directive keeps
    // sitting there looking like a decision somebody made about the code that
    // is there NOW — which is how `exhaustive-deps` accumulated 67 suppressions
    // repo-wide before anyone triaged them (MJXHRM-430).
    // ESLint's flat-config default for this is `warn`, and no workspace here
    // passes --max-warnings, so a stale directive was invisible in every one.
    // `error` makes it fail the workspace's `lint` script instead. Audited when
    // this landed: 0 unused directives across every workspace on this config,
    // including apps/desktop's `src/ electron/`.
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      perfectionist,
      'react-hooks': hooksPlugin,
      'unused-imports': unusedImports
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': 'off',
      curly: ['error', 'all'],
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'padding-line-between-statements': [
        1,
        {
          blankLine: 'always',
          next: [
            'block-like',
            'block',
            'return',
            'if',
            'class',
            'continue',
            'debugger',
            'break',
            'multiline-const',
            'multiline-let'
          ],
          prev: '*'
        },
        {
          blankLine: 'always',
          next: '*',
          prev: ['case', 'default', 'multiline-const', 'multiline-let', 'multiline-block-like']
        },
        { blankLine: 'never', next: ['block', 'block-like'], prev: ['case', 'default'] },
        { blankLine: 'always', next: ['block', 'block-like'], prev: ['block', 'block-like'] },
        { blankLine: 'always', next: ['empty'], prev: 'export' },
        { blankLine: 'never', next: 'iife', prev: ['block', 'block-like', 'empty'] }
      ],
      'perfectionist/sort-exports': ['error', { order: 'asc', type: 'natural' }],
      'perfectionist/sort-imports': [
        'error',
        {
          groups: ['side-effect', 'builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          order: 'asc',
          type: 'natural'
        }
      ],
      'perfectionist/sort-jsx-props': ['error', { order: 'asc', type: 'natural' }],
      'perfectionist/sort-named-exports': ['error', { order: 'asc', type: 'natural' }],
      'perfectionist/sort-named-imports': ['error', { order: 'asc', type: 'natural' }],
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'unused-imports/no-unused-imports': 'error'
    }
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ignores: ['**/node_modules/**', '**/dist/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node },
      sourceType: 'module'
    }
  }
]
