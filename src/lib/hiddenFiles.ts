// Files and folders whose names start with a dot are hidden, as in Obsidian:
// sync tools' backups (`.unisonbak.*`), `.DS_Store`, editor swap files. A
// setting shows them again.

/** Whether a vault-relative path has a file or folder name starting with `.`. */
export function isHiddenRel(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => part.startsWith("."));
}
