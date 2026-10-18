import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WRITE_CONFLICT, bufferChange, isWriteConflict, type ChangedNote } from "./vault";

describe("WRITE_CONFLICT", () => {
  it("matches the string the Rust core returns", () => {
    const core = readFileSync(new URL("../../basalt-core/src/lib.rs", import.meta.url), "utf8");
    expect(core).toContain(`pub const WRITE_CONFLICT: &str = "${WRITE_CONFLICT}";`);
  });

  it("is recognised whether it arrives as a string or an Error", () => {
    expect(isWriteConflict(WRITE_CONFLICT)).toBe(true);
    expect(isWriteConflict(new Error(WRITE_CONFLICT))).toBe(true);
    expect(isWriteConflict("disk full")).toBe(false);
  });
});

describe("bufferChange", () => {
  it("keeps a pending read of a note's text when only its time changes after", () => {
    const buf = new Map<string, ChangedNote>();
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 1, size: 5 });
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 2, size: 5, statsOnly: true });
    expect(buf.get("A.md")).toEqual({ path: "/v/A.md", rel: "A.md", mtime: 2, size: 5, statsOnly: false });
    bufferChange(buf, { path: "/v/B.md", rel: "B.md", mtime: 3, statsOnly: true });
    expect(buf.get("B.md")?.statsOnly).toBe(true);
    bufferChange(buf, { path: "/v/B.md", rel: "B.md", mtime: 4 });
    expect(buf.get("B.md")?.statsOnly).toBeUndefined();
  });

  it("keeps two changes of a note's time alone as a change of time alone", () => {
    const buf = new Map<string, ChangedNote>();
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 1, statsOnly: true, seq: 1 });
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 2, statsOnly: true, seq: 2 });
    expect(buf.get("A.md")).toEqual({ path: "/v/A.md", rel: "A.md", mtime: 2, statsOnly: true, seq: 2 });
  });

  it("keeps a newer change's stats when an older read is sent back behind it", () => {
    const buf = new Map<string, ChangedNote>();
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 5, statsOnly: true, seq: 7 });
    bufferChange(buf, { path: "/v/A.md", rel: "A.md", mtime: 2, seq: 3 });
    expect(buf.get("A.md")).toEqual({ path: "/v/A.md", rel: "A.md", mtime: 5, statsOnly: false, seq: 7 });
    bufferChange(buf, { path: "/v/B.md", rel: "B.md", mtime: 5, seq: 7 });
    bufferChange(buf, { path: "/v/B.md", rel: "B.md", mtime: 2, statsOnly: true, seq: 3 });
    expect(buf.get("B.md")).toEqual({ path: "/v/B.md", rel: "B.md", mtime: 5, seq: 7 });
  });
});
