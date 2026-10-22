import {defineConfig} from 'vitest/config';

/**
 * Vitest is the test runner for the four unit suites the notification plan's
 * 4b names (contributionRoutes, notificationLink, the client notifications
 * client, and commentFailure). They are pure-logic / stubbed-transport tests,
 * so the node environment is enough and no browser shim is needed.
 *
 * A separate file rather than a `test` block in vite.config.ts: the app config
 * carries the React and Tailwind plugins, which the tests neither need nor
 * should boot. Vitest prefers this file when both exist.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
});
