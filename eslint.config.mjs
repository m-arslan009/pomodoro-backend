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
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // Asserting on a test double's method (`expect(users.findByEmail).toHaveBeenCalled()`) reads
    // the method without binding it, which is exactly what unbound-method flags. In production
    // code that warning is worth keeping; in a spec the reference is never invoked, so the rule
    // reports only false positives.
    files: ['src/**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Architectural boundary: the domain layer is pure or it is broken. Keeping it free of
    // the framework and the ORM is what makes the business rules exhaustively unit-testable.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@nestjs/**'],
              message: 'src/domain must stay framework-free.',
            },
            {
              group: ['@prisma/*', '@prisma/**', '**/generated/prisma/**'],
              message: 'src/domain must not touch the ORM. Take plain values as arguments.',
            },
            {
              group: ['../controllers/*', '../services/*', '../repositories/*'],
              message: 'src/domain must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Controllers orchestrate; they must not reach past the service layer into persistence.
    files: ['src/controllers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../repositories/*', '**/*.repository'],
              message: 'Controllers must go through a service, never a repository.',
            },
            {
              group: ['@prisma/client', '**/generated/prisma/**'],
              message: 'The ORM lives in src/repositories and src/database only.',
            },
          ],
        },
      ],
    },
  },
);
