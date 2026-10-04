import { describe, expect, it } from "vitest";
import { withoutRemoteImages } from "./mermaid";

describe("withoutRemoteImages", () => {
  it("blanks remote images but never eats the rest of the diagram", () => {
    const src = 'flowchart LR\n  A["see url(https://x.test/y.png"] --> B["parse (json)"]\n  B --> C';
    expect(withoutRemoteImages(src)).toBe(src);
    const img = 'A@{ img: "https://x.test/p.png", label: "p" }';
    expect(withoutRemoteImages(img)).toContain('img: "data:image/gif;base64,');
    expect(withoutRemoteImages("style A fill:url(https://x.test/f.svg#a)")).toBe("style A fill:none");
  });
});
