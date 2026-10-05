'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', '.vscode-test/**', '*.vsix'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    // Webview client: plain browser script, talks to VS Code through acquireVsCodeApi().
    files: ['media/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, acquireVsCodeApi: 'readonly' }
    }
  },
  {
    // page.evaluate() callbacks run in the browser.
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
];
