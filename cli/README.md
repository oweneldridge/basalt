# basalt CLI

Command-line access to a Basalt/Obsidian vault. It reads and writes the vault's
Markdown files directly — **no running app required** — so it works headless
(e.g. from Claude Code sessions or scripts).

## Install

The CLI is a dependency-free Node script (Node 18+). From a clone:

```sh
npm link            # exposes `basalt` on your PATH (uses the "bin" entry)
# or run it directly:
node cli/basalt.mjs --help
```

## Vault resolution

Each command needs a vault. It's found, in order:

1. `--vault <path>`
2. `$BASALT_VAULT`
3. walking up from the current directory for a `.obsidian` or `.basalt` folder

## Commands

```sh
basalt ls [--json]                 # list every note (relative paths)
basalt cat <note>                  # print a note (resolve by path, basename, or substring)
basalt path <note>                 # print a note's absolute path
basalt search <query> [--regex] [--limit N] [--json]
basalt new <title> [--folder F] [--content STR] [--force] [--open]
basalt open <note>                 # hand a basalt:// URI to the OS opener
basalt info [--json]               # vault path + note count
```

### Notes

- `search` is grep-like: it prints `rel:line: text`. `--regex` treats the query
  as a case-insensitive `RegExp`; otherwise it's a case-insensitive substring.
- `new` refuses to overwrite an existing note unless `--force`, sanitizes
  filesystem-hostile characters, and rejects path traversal (`..`).
- `open` emits `basalt://open?vault=…&note=…` to the OS. Basalt registers the
  `basalt://` scheme, so a running app focuses and navigates to the note (and if
  it isn't running, launching it opens the link). Requires the bundled app —
  custom-scheme registration doesn't apply to `tauri dev`.

## Examples

```sh
export BASALT_VAULT=~/vaults/notes
basalt search "TODO" --limit 50
basalt cat 2026-07-12                     # today's daily note
basalt new "Meeting notes" --folder Journal --open
basalt ls --json | jq length
```
