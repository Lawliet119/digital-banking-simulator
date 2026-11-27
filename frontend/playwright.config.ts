import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real backend (`APP_ROLE=both` or `api`, `AUTH_MODE=local`) and the
 * Vite dev server, which serves `/__dev-auth/token` and proxies `/v1`. Start the backend first
 * (see frontend/README.md); Playwright starts Vite itself unless one is already running.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.DBS_WEB_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
