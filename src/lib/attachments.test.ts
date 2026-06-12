import { describe, expect, it } from "vitest";
import { looksLikeAttachment, resolveAttachment } from "./attachments";
import type { Attachment } from "./vault";

const att = (rel: string): Attachment => ({
  path: `/v/${rel}`,
  rel,
  name: rel.split("/").pop()!,
});

const list = [att("pics/cat.png"), att("docs/Report.pdf"), att("cat.png")];

describe("resolveAttachment", () => {
  it("matches by bare filename, root-most wins on ambiguity", () => {
    expect(resolveAttachment(list, "cat.png")?.rel).toBe("cat.png");
  });
  it("matches by path suffix", () => {
    expect(resolveAttachment(list, "pics/cat.png")?.rel).toBe("pics/cat.png");
  });
  it("is case-insensitive and ignores #fragments", () => {
    expect(resolveAttachment(list, "report.PDF#page=3")?.rel).toBe("docs/Report.pdf");
  });
  it("returns null for unknown targets", () => {
    expect(resolveAttachment(list, "missing.png")).toBeNull();
    expect(resolveAttachment(list, "Some Note")).toBeNull();
  });
});

describe("looksLikeAttachment", () => {
  it("detects non-md file extensions", () => {
    expect(looksLikeAttachment("Report.pdf")).toBe(true);
    expect(looksLikeAttachment("Note.md")).toBe(false);
    expect(looksLikeAttachment("Plain Note")).toBe(false);
  });
});
