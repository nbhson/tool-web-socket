import js from '@eslint/js';
import globals from 'globals';
import n from 'eslint-plugin-n';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: {
      'n/no-unpublished-require': 'off',
    },
  },
  {
    files: ['**/*.test.js', 'vitest.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.mocha },
    },
  },
];
