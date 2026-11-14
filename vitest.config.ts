import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'shared/test/**/*.test.ts', 'web/test/**/*.test.ts'],
    environment: 'node',
    // One temporary folder per run, removed at its end (vitest.global-setup.ts).
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
