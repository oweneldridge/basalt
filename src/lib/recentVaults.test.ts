import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecentVaults, pushRecentVault, vaultName, workspaceKey } from "./recentVaults";

// Minimal in-memory localStorage (the suite runs in the default node env; only
// getItem/setItem/clear are exercised).
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  clear() {
    this.m.clear();
  }
}
const store = new MemStorage();
vi.stubGlobal("localStorage", store);
// Match the code's `Storage.prototype`-based quota spy target.
vi.stubGlobal("Storage", MemStorage);

beforeEach(() => store.clear());

describe("vaultName", () => {
  it("takes the final path segment, tolerating trailing slashes and backslashes", () => {
    expect(vaultName("/Users/o/Notes")).toBe("Notes");
    expect(vaultName("/Users/o/Notes/")).toBe("Notes");
    expect(vaultName("C:\\Users\\o\\Vault")).toBe("Vault");
    expect(vaultName("Solo")).toBe("Solo");
  });
});

describe("recent vaults", () => {
  it("stores most-recent-first, dedupes, and caps at 12", () => {
    let t = 1000;
    for (let i = 0; i < 15; i++) pushRecentVault(`/v/vault${i}`, (t += 10));
    const list = loadRecentVaults();
    expect(list).toHaveLength(12);
    expect(list[0].path).toBe("/v/vault14"); // newest first
    expect(list[0].name).toBe("vault14");
    // re-opening an existing vault moves it to the front without duplicating
    pushRecentVault("/v/vault5", (t += 10));
    const after = loadRecentVaults();
    expect(after[0].path).toBe("/v/vault5");
    expect(after.filter((r) => r.path === "/v/vault5")).toHaveLength(1);
    expect(after).toHaveLength(12);
  });

  it("returns [] on missing/corrupt storage", () => {
    expect(loadRecentVaults()).toEqual([]);
    localStorage.setItem("basalt.recentVaults", "not json");
    expect(loadRecentVaults()).toEqual([]);
    localStorage.setItem("basalt.recentVaults", JSON.stringify([{ nope: 1 }, "x", null]));
    expect(loadRecentVaults()).toEqual([]);
  });

  it("survives a localStorage.setItem quota failure without throwing", () => {
    const spy = vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => pushRecentVault("/v/a", 1)).not.toThrow();
    spy.mockRestore();
  });
});

describe("workspaceKey", () => {
  it("keeps the historic key for the main window and scopes others", () => {
    expect(workspaceKey("/v/Notes", "main")).toBe("basalt.workspace./v/Notes");
    expect(workspaceKey("/v/Notes", "w123-4")).toBe("basalt.workspace./v/Notes::w123-4");
    // two windows on the same vault get distinct layout keys (no clobber)
    expect(workspaceKey("/v/Notes", "w1")).not.toBe(workspaceKey("/v/Notes", "w2"));
  });
});
