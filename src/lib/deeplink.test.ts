import { describe, expect, it } from "vitest";
import { parseBasaltUri } from "./deeplink";

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
