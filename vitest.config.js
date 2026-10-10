import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    testTimeout: 30000,
    // Legacy per-location shop tests assert multi-store behaviour; single-store mode
    // (production default) has its own tests that switch it on explicitly.
    env: { SINGLE_STORE_MODE: 'false' },
  },
})
