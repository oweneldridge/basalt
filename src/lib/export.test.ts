import { describe, expect, it } from "vitest";
import { buildHtmlDocument } from "./export";

describe("buildHtmlDocument", () => {
  it("wraps the body in a standalone doc with embedded styles", () => {
    const html = buildHtmlDocument("My Note", "<h1>Hi</h1>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Note</title>");
    expect(html).toContain("<style>");
    expect(html).toContain("<h1>Hi</h1>");
  });
  it("escapes the title (no injection via the document title)", () => {
    const html = buildHtmlDocument('</title><script>x</script>', "body");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});
