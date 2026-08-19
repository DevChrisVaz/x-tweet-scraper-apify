import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.worktrees/**',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.vercel/**',
      '.codex/**',
      '.agents/**',
      'tmp/**',
    ],
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        structuredClone: 'readonly',
        URL: 'readonly',
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
