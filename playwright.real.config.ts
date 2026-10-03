import { defineConfig, devices } from "@playwright/test";

// Real-IO e2e: the production web build served by basalt-server over a temp
// vault per test (see e2e-real/fixture.ts). Needs `npx vite build` and
// `cargo build -p basalt-server` first; `npm run test:e2e:real` does both.
export default defineConfig({
  testDir: "./e2e-real",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
