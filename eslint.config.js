import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default [
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**', 'public/vendor/**', '.vercel/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } }
];
