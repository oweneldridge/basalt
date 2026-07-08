import { defineConfig, devices } from "@playwright/test";

// E2E tests drive the FULL app against a mocked Tauri backend (see
// vite.harness.config.ts + src/testkit/tauriMock.ts) — the only way to test
// panes, sidebar resizing and tab drag-drop, which need the whole App mounted.
// Run: npm run test:e2e   (first time: npx playwright install chromium)
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:1422", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --config vite.harness.config.ts",
    url: "http://localhost:1422/app-harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
