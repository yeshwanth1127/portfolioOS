import { defineConfig } from '@playwright/test';

/** Optional Phase 2 UI smoke — run only when PLAYWRIGHT=1 and stack is up. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001',
    trace: 'on-first-retry',
  },
});
