// Types for the plain-ESM CLI core so TypeScript tests can import it.
export interface CliNote {
  rel: string;
  path: string;
}
export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  fileExists(path: string): boolean;
  isDir(path: string): boolean;
  listMarkdown(vaultRoot: string): CliNote[];
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  openUri(uri: string): void;
  out(text: string): void;
  err(text: string): void;
}
export interface SearchMatch {
  rel: string;
  line: number;
  text: string;
}
export interface SearchResult {
  results: SearchMatch[];
  truncated?: boolean;
  error?: string;
}
export function parseArgs(argv: string[]): { command?: string; args: string[]; opts: Record<string, string | boolean> };
export function findVaultRoot(startDir: string, io: { fileExists(p: string): boolean }): string | null;
export function resolveNote(notes: CliNote[], query: string): CliNote | null;
export function searchNotes(
  notes: CliNote[],
  contentOf: (n: CliNote) => string,
  query: string,
  opts?: { limit?: number; regex?: boolean },
): SearchResult;
export function noteRelForTitle(title: string, folder?: string): string | null;
export function openUri(vault: string, rel: string): string;
export function run(argv: string[], io: CliIo): number;
