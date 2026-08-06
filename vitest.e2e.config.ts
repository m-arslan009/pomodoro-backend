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
    // `test/auth.e2e-spec.ts` is the first spec here, so an empty run is now a sign the glob or
    // the file went missing rather than a phase that has not been reached yet.
    passWithNoTests: false,
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
