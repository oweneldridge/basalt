import { describe, expect, it } from "vitest";
import { mediaKind } from "./media";

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
