// Entry for the full-app test harness (see vite.harness.config.ts). Seeds the
// last-vault key so <App/> auto-opens the mock vault on mount, then renders the
// real app (StrictMode OFF — double-invoked effects fight the once-only mount).
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

localStorage.setItem("basalt.lastVault", "/mock/vault");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
