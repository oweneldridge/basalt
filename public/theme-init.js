// Apply the saved theme before first paint (no flash). Mirrors lib/theme.ts.
// A file rather than an inline script, so the CSP needs no exceptions.
try {
  var m = localStorage.getItem("basalt.theme") || "system";
  var dark = m === "dark" || (m !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch (e) {}
