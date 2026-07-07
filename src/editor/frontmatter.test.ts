import { describe, expect, it } from "vitest";
import { isValidNumber, isValidDate } from "./frontmatter";

// The gate that keeps typed number/date widgets safe: only values a native
// control can hold AND that are safe to write UNQUOTED pass.
describe("typed-property validators", () => {
  it("isValidNumber accepts plain numbers, rejects leading zeros / partials", () => {
    for (const v of ["0", "42", "-3.14", "1e5", "100"]) expect(isValidNumber(v)).toBe(true);
    // leading zeros (zip/id — must stay a quoted string), and partials
    for (const v of ["007", "07001", "+5", "1.", "1,5", "", "abc", "Infinity", "0x10"]) {
      expect(isValidNumber(v)).toBe(false);
    }
  });
  it("isValidDate accepts real calendar dates, rejects impossible ones", () => {
    for (const v of ["2026-07-07", "2024-02-29", "2000-12-31"]) expect(isValidDate(v)).toBe(true);
    for (const v of ["2026-02-30", "2026-13-01", "2021-06-31", "0000-00-00", "2026-7-7", "nope"]) {
      expect(isValidDate(v)).toBe(false);
    }
  });
});
