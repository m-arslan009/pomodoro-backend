import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // E2E boots the real application against a real database; parallel files would race
    // on the same schema.
    fileParallelism: false,
    // Same reason as vitest.config.ts: no e2e specs exist yet, and the opt-in pre-push run
    // must not fail on an empty suite. Remove once the first e2e spec lands.
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
