import { defineConfig, devices } from '@playwright/test';

// BASE_URL / MAILPIT_URL are set by docker compose (e2e service).
// Running on the host against `docker compose up`, the defaults apply.
export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),
  // The Spanner emulator runs one read-write transaction at a time and aborts the
  // rest (the client retries with backoff, which can take seconds). Run tests
  // serially so timings stay deterministic. Real Spanner doesn't have this limit.
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
