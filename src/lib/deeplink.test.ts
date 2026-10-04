import { describe, expect, it } from "vitest";
import { deepLinkVaultPolicy, parseBasaltUri, parseObsidianUri } from "./deeplink";

describe("parseBasaltUri", () => {
  it("parses open links with a vault and optional note", () => {
    expect(parseBasaltUri("basalt://open?vault=/Users/me/vault&note=Journal/2026-07-12.md")).toEqual({
      vault: "/Users/me/vault",
      note: "Journal/2026-07-12.md",
    });
    expect(parseBasaltUri("basalt://open?vault=/v")).toEqual({ vault: "/v", note: undefined });
  });

  it("decodes percent-encoded paths (spaces, slashes)", () => {
    expect(parseBasaltUri("basalt://open?vault=%2Fmy%20vault&note=A%20B.md")).toEqual({
      vault: "/my vault",
      note: "A B.md",
    });
  });

  it("returns null for the wrong scheme, wrong action, or a missing vault", () => {
    expect(parseBasaltUri("obsidian://open?vault=/v")).toBeNull();
    expect(parseBasaltUri("basalt://search?q=hi")).toBeNull();
    expect(parseBasaltUri("basalt://open?note=x.md")).toBeNull(); // no vault
    expect(parseBasaltUri("not a url")).toBeNull();
    expect(parseBasaltUri("")).toBeNull();
  });
});

describe("deepLinkVaultPolicy", () => {
  it("opens a known vault, asks about an unknown one, refuses network paths", () => {
    const known = ["/Users/o/Notes", "C:\\Vaults\\Work"];
    expect(deepLinkVaultPolicy("/Users/o/Notes/", known)).toBe("open");
    expect(deepLinkVaultPolicy("C:\\Vaults\\Work", known)).toBe("open");
    expect(deepLinkVaultPolicy("/", known)).toBe("confirm");
    expect(deepLinkVaultPolicy("/Users/o/Downloads/shared", known)).toBe("confirm");
    expect(deepLinkVaultPolicy("\\\\attacker\\share", known)).toBe("refuse");
    expect(deepLinkVaultPolicy("//attacker/share", known)).toBe("refuse");
    expect(deepLinkVaultPolicy("smb://attacker/share", known)).toBe("refuse");
  });
});

describe("parseObsidianUri", () => {
  it("reads open by vault and file, by path, and both shorthands", () => {
    expect(parseObsidianUri("obsidian://open?vault=my%20vault&file=Notes%2FIdeas")).toEqual({ action: "open", vault: "my vault", file: "Notes/Ideas", path: undefined });
    expect(parseObsidianUri("obsidian://open?path=%2FUsers%2Fme%2Fv%2FA%20B.md")).toEqual({ action: "open", vault: undefined, file: undefined, path: "/Users/me/v/A B.md" });
    expect(parseObsidianUri("obsidian://vault/my vault/Notes/my note")).toEqual({ action: "open", vault: "my vault", file: "Notes/my note" });
    expect(parseObsidianUri("obsidian:///absolute/path/to/my note")).toEqual({ action: "open", path: "/absolute/path/to/my note" });
  });

  it("reads search, and leaves writing actions and other schemes alone", () => {
    expect(parseObsidianUri("obsidian://search?vault=v&query=tag%3A%23idea")).toEqual({ action: "search", vault: "v", query: "tag:#idea" });
    expect(parseObsidianUri("obsidian://open?vault=v&file=A&append=hi")).toBeNull();
    expect(parseObsidianUri("obsidian://new?vault=v&name=A&content=x")).toBeNull();
    expect(parseObsidianUri("obsidian://daily?vault=v")).toBeNull();
    expect(parseObsidianUri("https://obsidian.md")).toBeNull();
    expect(parseObsidianUri("not a url")).toBeNull();
  });
});
