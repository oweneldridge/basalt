# Parity check: rename and link rewriting

- Run `npm run parity:prepare`. It prints a folder like `~/parity-vaults/2026-10-12T...`
  holding three vaults under `obsidian/`, one per link setting.
- Do the four steps below in Obsidian, in each of the three vaults. About 15 minutes.
- Quit Obsidian, then run `PARITY_RUN=<folder> npm run parity:basalt` and
  `npm run parity:diff -- <folder>`.
- Only use Obsidian as you normally would. Don't open its developer tools.

Before you start, note the Obsidian version (Settings, About) here: ________

## For each vault (`shortest-wiki`, `relative-wiki`, `absolute-md`)

Open it with "Open folder as vault". If Obsidian asks whether to trust the
author, the vault has no plugins, so either answer is fine.

1. In the file explorer, right-click **Target** (the one at the top level, not
   the one in `Other`), choose Rename, and type `Target Renamed`.
2. Open the `Folder` folder, drag **Deep** onto the `Archive` folder. If
   Obsidian asks about updating links, choose to update them.
3. Right-click the **Folder** folder, choose Rename, and type `Folder2`.
4. Open `assets`, right-click **pic.png**, choose Rename, and type `picture`
   (Obsidian keeps the `.png`).

Wait a couple of seconds after the last step, then close the vault (or quit
Obsidian) before moving to the next one.
