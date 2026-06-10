// Build a folder tree from the flat note list (using each note's vault-relative
// path), so the sidebar can show real nested folders instead of a flat list.
import type { VaultNote } from "./vault";

export interface TreeFile {
  type: "file";
  name: string;
  path: string; // absolute note path
}
export interface TreeFolder {
  type: "folder";
  name: string;
  path: string; // folder path relative to the vault root (used as expand key)
  children: TreeNode[];
}
export type TreeNode = TreeFile | TreeFolder;

function sortFolder(folder: TreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1; // folders first
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const child of folder.children) {
    if (child.type === "folder") sortFolder(child);
  }
}

export function buildTree(notes: VaultNote[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, TreeFolder>([["", root]]);

  for (const note of notes) {
    const parts = note.rel.split(/[/\\]/);
    let parent = root;
    let parentPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const fp = parentPath ? `${parentPath}/${seg}` : seg;
      let folder = folders.get(fp);
      if (!folder) {
        folder = { type: "folder", name: seg, path: fp, children: [] };
        folders.set(fp, folder);
        parent.children.push(folder);
      }
      parent = folder;
      parentPath = fp;
    }
    parent.children.push({ type: "file", name: note.name, path: note.path });
  }

  sortFolder(root);
  return root.children;
}

/** Folder paths (expand keys) of every ancestor of a vault-relative file path. */
export function ancestorFolders(rel: string): string[] {
  const parts = rel.split(/[/\\]/).slice(0, -1);
  const out: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}
