import { describe, expect, it } from "vitest";
import { countWords, countableText } from "./wordCount";

describe("word count", () => {
  it("counts words as Obsidian does", () => {
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("- item")).toBe(2); // a lone hyphen is a word to Obsidian
    expect(countWords("**bold** and `code`")).toBe(3);
    expect(countWords("1,000.50 is one number; v2 is one word")).toBe(8);
    expect(countWords("GPT-5 on 2026-09-11")).toBe(3);
    expect(countWords("⚠️ warning")).toBe(1);
    expect(countWords("don't well-known")).toBe(2);
    expect(countWords("日本語")).toBe(3);
    expect(countWords("café naïve Ελληνικά")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("# ## |")).toBe(0);
  });

  it("leaves the frontmatter out", () => {
    expect(countableText("---\ntitle: X\ntags: [a, b]\n---\nOne two three.\n")).toBe("One two three.\n");
    expect(countableText("no frontmatter\n---\n")).toBe("no frontmatter\n---\n");
    expect(countableText("---\nunclosed: yes\n")).toBe("---\nunclosed: yes\n");
  });
});
