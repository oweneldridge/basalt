# Loading plugins without unsafe-eval

Plugins don't run in release builds. The desktop CSP has no `script-src`, so it
falls back to `default-src 'self'`, and the plugin host builds each plugin with
`new Function` (`src/lib/plugins.ts`). Tauri only allows that in dev builds.
Adding `'unsafe-eval'` would turn it on for every string in the page, so instead
plugins load as real scripts from a source Basalt serves and checks itself.

## Constraint

Basalt's plugin API hands plugins the live DOM: views mount into sidebar
elements, code-block processors render into the note, and editor extensions are
CodeMirror objects. A Web Worker or a sandboxed iframe can't do any of that
without a new message-based API, which would break every plugin. So plugins keep
running in the page, and the work goes into where their code comes from.

## Design

- **A plugin scheme.** The Tauri side registers `basalt-plugin://` with
  `register_asynchronous_uri_scheme_protocol`. A request for
  `basalt-plugin://localhost/<id>/<sha256>.js` returns the plugin's `main.js`
  only if the plugin is enabled and the file's hash still equals `<sha256>`, the
  hash the user approved (`codeHash` in `plugins.ts`). Anything else is a 404.
  Checking the hash on the request closes the gap between vetting and loading.
- **A module wrapper.** Plugins are CommonJS (`module.exports`, `require`). The
  scheme handler wraps the file so it imports as an ES module:
  `const module = { exports: {} }; const exports = module.exports;`
  `const require = (n) => globalThis.__basaltRequire("<id>", n);`, then the
  plugin's code, then `export default module.exports;`. `__basaltRequire` hands
  out the `basalt` API object, as `require` does today.
- **The CSP.** Add `script-src 'self' basalt-plugin://localhost
  http://basalt-plugin.localhost` (the second form is how Windows exposes custom
  schemes). No `'unsafe-eval'`, no `blob:`.
- **The host.** `loadPlugin` does `await import(url)` instead of
  `new Function(...)`, so its call sites are unchanged. Unloading stays as it is;
  a reload adds a query string so the module cache doesn't return the old code.
- **The web build.** `basalt-server` serves the same files at
  `/api/plugin/<id>/<sha256>.js` (same origin, so `'self'` covers it), and its
  CSP (sent since 2026-10-04) drops the `'unsafe-eval'` it keeps until then.

## What it doesn't solve

- **dataviewjs.** Its job is to run JavaScript written inside notes, with
  `new Function`. With this design it stays off in release builds. Making it work
  means serving note code through the scheme too (registered by hash, only while
  the plugin is enabled), which is eval by another route. That's a separate
  decision for Owen.
- **Trust.** Plugins still have full access to the page, as they do now. The
  protections are the ones already in place: off by default, enabled one by one,
  and re-approval when the code changes.

## Tests

- Rust: the handler serves an enabled plugin with the right hash, and returns
  404 for a wrong hash, a disabled plugin, a path outside `.basalt/plugins` and a
  symlinked `main.js`.
- Unit: the wrapper turns `module.exports` and `require("basalt")` into a working
  default export.
- Mock e2e: the six bundled plugins load through `import()`. A real-app check
  confirms the release CSP allows the scheme and still blocks `eval`.

Size: medium, mostly in the scheme handler and its tests.
