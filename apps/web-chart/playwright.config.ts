// End-to-end tests for the chart (M2-05): the built chart, served by Vite's
// preview server, against the platform's e2e server (made-up bars, a live
// feed the tests drive; apps/platform/src/e2e-server.ts). No Redis, S3,
// DynamoDB or provider needed.
//
//   pnpm e2e

import { defineConfig, devices } from '@playwright/test';

const PLATFORM_PORT = 8181;
const CHART_PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // The tests share one live feed, in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${CHART_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm exec tsx ../platform/src/e2e-server.ts',
      url: `http://127.0.0.1:${PLATFORM_PORT}/health`,
      env: { AIA_PORT: String(PLATFORM_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${CHART_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${CHART_PORT}`,
      env: { AIA_PLATFORM_URL: `http://127.0.0.1:${PLATFORM_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
