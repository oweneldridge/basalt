import { describe, expect, it } from "vitest";
import { shouldSnapshot, pruneSnapshots, SNAPSHOT_INTERVAL_MS, type Snapshot } from "./snapshots";

const MIN = 60 * 1000;
const snap = (ts: number, content: string): Snapshot => ({ ts, content });

describe("shouldSnapshot", () => {
  it("always snapshots the first save (non-empty)", () => {
    expect(shouldSnapshot([], "hello", 1000)).toBe(true);
    expect(shouldSnapshot([], "", 1000)).toBe(false); // never snapshot empty
  });

  it("skips when content is unchanged from the latest", () => {
    expect(shouldSnapshot([snap(0, "a")], "a", 10 * MIN)).toBe(false);
  });

  it("throttles: only after the interval has elapsed since the last snapshot", () => {
    const existing = [snap(0, "a")];
    expect(shouldSnapshot(existing, "b", 1 * MIN)).toBe(false); // changed but too soon
    expect(shouldSnapshot(existing, "b", 3 * MIN)).toBe(true); // changed + interval passed
  });

  it("force bypasses the throttle but still dedups identical content", () => {
    const existing = [snap(0, "a")];
    expect(shouldSnapshot(existing, "b", 1 * MIN, SNAPSHOT_INTERVAL_MS, true)).toBe(true); // forced
    expect(shouldSnapshot(existing, "a", 1 * MIN, SNAPSHOT_INTERVAL_MS, true)).toBe(false); // same → skip
  });
});

describe("pruneSnapshots", () => {
  it("drops entries older than the retention window", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const old = snap(0, "ancient");
    const recent = snap(now - MIN, "recent");
    expect(pruneSnapshots([old, recent], now).map((s) => s.content)).toEqual(["recent"]);
  });

  it("keeps only the newest `max`", () => {
    const list = Array.from({ length: 10 }, (_, i) => snap(i, `v${i}`));
    const kept = pruneSnapshots(list, 100, 3);
    expect(kept.map((s) => s.content)).toEqual(["v7", "v8", "v9"]);
  });
});
