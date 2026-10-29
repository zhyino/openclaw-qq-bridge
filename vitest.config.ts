import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Run files sequentially on purpose.
    //
    // With the default worker pool this suite is non-deterministic: on Windows
    // the workers race for the SSR module cache and a losing worker surfaces as
    // `Error: EPERM ... open <tmp>/ssr/<hash>`. Vitest reports it under
    // "Unhandled Errors", still prints "Test Files N passed", and exits 0 — so
    // a run that silently dropped three test files looks green. A test suite
    // whose result depends on scheduling is worse than a slow one.
    //
    // `npm run test:fast` keeps the parallel pool for quick local loops.
    fileParallelism: false,

    // An unhandled error means at least one file's setup failed. Never let that
    // pass as a green run.
    dangerouslyIgnoreUnhandledErrors: false,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
