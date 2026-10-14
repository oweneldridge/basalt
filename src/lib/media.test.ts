import { describe, expect, it } from "vitest";
import { mediaKind, mediaPath, pdfOptions } from "./media";

describe("mediaKind", () => {
  it("classifies audio / video / pdf; anything else is null", () => {
    expect(mediaKind("song.mp3")).toBe("audio");
    expect(mediaKind("Voice Memo.M4A")).toBe("audio");
    expect(mediaKind("clip.mp4")).toBe("video");
    expect(mediaKind("demo.webm")).toBe("video");
    expect(mediaKind("paper.pdf")).toBe("pdf");
    expect(mediaKind("Note")).toBeNull();
    expect(mediaKind("img.png")).toBeNull();
  });
});

describe("pdf embed options", () => {
  it("read a page and a height from the link, and resolve the file alone", () => {
    expect(pdfOptions("doc.pdf#page=3")).toEqual({ page: 3, height: undefined });
    expect(pdfOptions("doc.pdf#height=400")).toEqual({ page: undefined, height: 400 });
    expect(pdfOptions("doc.pdf#page=2&height=300")).toEqual({ page: 2, height: 300 });
    expect(pdfOptions("doc.pdf")).toEqual({ page: undefined, height: undefined });
    expect(pdfOptions("doc.pdf#page=-1")).toEqual({ page: undefined, height: undefined });
    expect(mediaPath("folder/doc.pdf#page=3")).toBe("folder/doc.pdf");
  });
});
