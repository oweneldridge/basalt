import { defineConfig, devices } from "@playwright/test";

// Basalt's half of a parity run (see parity/rename.md). Needs `npx vite build`
// and `cargo build -p basalt-server`, and PARITY_RUN set to the run folder.
export default defineConfig({
  testDir: ".",
  testMatch: "basalt.spec.ts",
  workers: 1,
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
