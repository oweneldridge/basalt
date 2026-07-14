import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vitest: the e2e/ Playwright specs are run by `npm run test:e2e`, not vitest.
  test: { exclude: [...configDefaults.exclude, "e2e/**"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Web dev: proxy /api → a locally-running basalt-server so the app, loaded
    // in a plain browser, reaches the backend same-origin (no CORS). Inert under
    // Tauri (the desktop app uses IPC and never hits /api).
    proxy: {
      "/api": { target: "http://localhost:8799", changeOrigin: true },
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
