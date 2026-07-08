import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// App test harness: runs the FULL <App/> in a plain browser with the Tauri IPC
// mocked (src/testkit/tauriMock.ts), so panes, sidebar resizing, tab drag-drop
// and splits can be driven by Playwright / CI.
//   npx vite --config vite.harness.config.ts   →   http://localhost:1422/app-harness.html
const mock = fileURLToPath(new URL("./src/testkit/tauriMock.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": mock,
      "@tauri-apps/api/event": mock,
      "@tauri-apps/api/window": mock,
      "@tauri-apps/plugin-dialog": mock,
      "@tauri-apps/plugin-opener": mock,
    },
  },
  server: { port: 1422, strictPort: true },
});
