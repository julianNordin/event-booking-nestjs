// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Emitted by `prisma generate`. Not ours to lint, and it is not on disk
      // at all on a clean checkout until postinstall has run.
      'src/generated/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unawaited promise in a request handler is a response that races the
      // next one. This is the single most valuable rule in the type-aware set.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Deliberately NOT enabling consistent-type-imports: Nest resolves
      // constructor dependencies from the `design:paramtypes` metadata that
      // TypeScript emits, and a type-only import erases the class to Object.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
