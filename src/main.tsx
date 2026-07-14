import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri, webVaultRoot } from "./lib/platform";

const LAST_VAULT_KEY = "basalt.lastVault";

async function boot() {
  // Web app: basalt-server hosts one fixed vault, so seed it as the last vault
  // — App's mount then opens it via its usual ?vault=/last-vault flow. On the
  // desktop this is skipped and behaviour is unchanged.
  if (!isTauri) {
    try {
      localStorage.setItem(LAST_VAULT_KEY, await webVaultRoot());
    } catch {
      /* server unreachable — App falls back to its normal empty/picker state */
    }
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
