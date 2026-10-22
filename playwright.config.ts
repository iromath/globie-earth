import { defineConfig, devices } from '@playwright/test';

/**
 * The browser half of the notification plan's 4b.
 *
 * Unlike the Vitest suites (pure logic, node), these drive a real page, so a
 * target is required. It defaults to the live deployment and is overridden with
 * E2E_BASE_URL, so the same suite can point at `npm run dev` or a preview build
 * without an edit here:
 *
 *     E2E_BASE_URL=http://localhost:3000 npx playwright test
 *
 * There is no webServer block: the target is a running site (production by
 * default), not something this config is expected to boot.
 *
 * One worker, no parallelism: the scenarios share device identity and, when a
 * fixture is supplied, a single contribution. Serial keeps the device ids and
 * the notification ordering honest.
 */
const BASE_URL = (process.env.E2E_BASE_URL ?? 'https://globie.earth').replace(/\/+$/, '');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
