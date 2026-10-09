import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WRITE_CONFLICT, isWriteConflict } from "./vault";

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
