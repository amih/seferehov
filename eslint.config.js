// Lint (npm run lint): mistakes a test run might miss, above all a name used but never
// defined (a deleted helper still called: the to-do tabs, 11 Nov 2026, left screens on
// "Loading…"). The recommended rules, with empty catch blocks and omitted rest siblings allowed.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'server/scan-keep/**', 'server/scan-trace/**', 'uploads/**', 'ocr/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['web/src/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, __APP_VERSION__: 'readonly', __APP_BUILD__: 'readonly' } },
  },
];
