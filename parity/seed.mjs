// The parity test vault: the same notes once per link setting, so a rename
// can be done by hand in Obsidian and by script in Basalt and the files diffed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VARIANTS = {
  "shortest-wiki": { newLinkFormat: "shortest", useMarkdownLinks: false },
  "relative-wiki": { newLinkFormat: "relative", useMarkdownLinks: false },
  "absolute-md": { newLinkFormat: "absolute", useMarkdownLinks: true },
};

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const FILES = {
  "Target.md": "# Target\n\n## Section A\n\nA paragraph to link to. ^blk1\n",
  "Other/Target.md": "# Another note named Target\n",
  "Notes/Linker.md": [
    "---",
    'related: "[[Target]]"',
    "links:",
    '  - "[[Target]]"',
    '  - "[[Folder/Deep]]"',
    "---",
    "Bare [[Target]], heading [[Target#Section A]], block [[Target#^blk1]], alias [[Target|alias text]].",
    "With the extension [[Target.md]], embedded ![[Target]] and ![[Target#Section A]].",
    "Markdown links: [plain](../Target.md), [heading](../Target.md#Section%20A), [angle](<../Target.md>).",
    "Deep note: [[Folder/Deep]] and [deep](../Folder/Deep.md). The other Target: [[Other/Target]].",
    "Picture: ![[pic.png]] and ![pic](../assets/pic.png).",
    "",
  ].join("\n"),
  "Folder/Deep.md": "Up to [[Target]] and [up](../Target.md). Myself: [[Deep]]. Down: [[Folder/Sub/Leaf]].\n",
  "Folder/Sub/Leaf.md": "Back to [[Deep]], [[Folder/Deep]] and [deep](../Deep.md).\n",
  "Board.canvas": JSON.stringify(
    {
      nodes: [
        { id: "n1", type: "file", file: "Target.md", x: 0, y: 0, width: 300, height: 200 },
        { id: "n2", type: "text", text: "See [[Target]] and [[Folder/Deep]]", x: 340, y: 0, width: 300, height: 120 },
        { id: "n3", type: "file", file: "assets/pic.png", x: 0, y: 240, width: 200, height: 200 },
      ],
      edges: [],
    },
    null,
    "\t",
  ),
  "Tasks.base": 'filters:\n  and:\n    - file.inFolder("Folder")\nviews:\n  - type: table\n    name: Deep notes\n',
  "Windows.md": "Line endings are CRLF.\r\nIt links [[Target]].\r\n",
  "Latin1.md": Buffer.from("Caf\xe9 in Latin-1, linking [[Target]].\n", "latin1"),
  "assets/pic.png": PNG,
};

/** Write the vault for one variant into `dir`. */
export function seed(dir, settings) {
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, "Archive"), { recursive: true });
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  // Update links on rename without asking, as both apps then do the same thing.
  writeFileSync(join(dir, ".obsidian/app.json"), JSON.stringify({ ...settings, alwaysUpdateLinks: true }, null, 2));
}
