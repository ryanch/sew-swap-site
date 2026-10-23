import { defineConfig, devices } from '@playwright/test';

// BASE_URL / MAILPIT_URL are set by docker compose (e2e service).
// Running on the host against `docker compose up`, the defaults apply.
export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),
  // Tests share the admin account and its rate limits, so they run serially to keep
  // timings deterministic.
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
