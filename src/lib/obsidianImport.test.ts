import { describe, expect, it } from "vitest";
import { parseObsidianImport, obsidianChord } from "./obsidianImport";

describe("obsidianChord", () => {
  it("maps modifiers + key to a Basalt chord in canonical order", () => {
    expect(obsidianChord(["Mod", "Shift"], "F")).toBe("mod+shift+f");
    expect(obsidianChord(["Alt"], "ArrowUp")).toBe("alt+arrowup");
    expect(obsidianChord(["Mod"], "k")).toBe("mod+k");
  });
  it("collapses Ctrl/Meta to mod", () => {
    expect(obsidianChord(["Ctrl"], "p")).toBe("mod+p");
  });
  it("allows a bare function key but rejects an unmodified printable key", () => {
    expect(obsidianChord([], "F5")).toBe("f5");
    expect(obsidianChord([], "a")).toBeNull();
    expect(obsidianChord(["Mod"], "")).toBeNull();
  });
});

describe("parseObsidianImport", () => {
  it("maps appearance.json → theme / accent / font / fonts / snippets", () => {
    const r = parseObsidianImport({
      appearance: JSON.stringify({
        theme: "obsidian",
        accentColor: "#7B6CD9",
        baseFontSize: 18,
        textFontFamily: "Inter",
        monospaceFontFamily: "MesloLGL Nerd Font Mono",
        enabledCssSnippets: ["mytweaks", "colors"],
      }),
      hotkeys: null,
      communityPlugins: [],
    });
    expect(r.theme).toBe("dark");
    expect(r.accent).toBe("#7B6CD9");
    expect(r.fontSize).toBe(18);
    expect(r.fontText).toBe("Inter");
    expect(r.fontMono).toBe("MesloLGL Nerd Font Mono");
    expect(r.enabledSnippets).toEqual(["mytweaks", "colors"]);
  });

  it("falls back to interfaceFontFamily and ignores empty font strings", () => {
    expect(parseObsidianImport({ appearance: JSON.stringify({ interfaceFontFamily: "Lato" }), hotkeys: null, communityPlugins: [] }).fontText).toBe("Lato");
    expect(parseObsidianImport({ appearance: JSON.stringify({ textFontFamily: "" }), hotkeys: null, communityPlugins: [] }).fontText).toBeNull();
  });

  it("maps moonstone/system themes and ignores a bad accent/font", () => {
    expect(parseObsidianImport({ appearance: JSON.stringify({ theme: "moonstone" }), hotkeys: null, communityPlugins: [] }).theme).toBe("light");
    expect(parseObsidianImport({ appearance: JSON.stringify({ theme: "system" }), hotkeys: null, communityPlugins: [] }).theme).toBe("system");
    const r = parseObsidianImport({ appearance: JSON.stringify({ accentColor: "not-a-hex", baseFontSize: 999 }), hotkeys: null, communityPlugins: [] });
    expect(r.accent).toBeNull();
    expect(r.fontSize).toBeNull();
  });

  it("maps known hotkeys and reports unmapped ones", () => {
    const r = parseObsidianImport({
      appearance: null,
      hotkeys: JSON.stringify({
        "app:open-settings": [{ modifiers: ["Mod"], key: "," }],
        "workspace:split-vertical": [{ modifiers: ["Mod", "Shift"], key: "\\" }],
        "some-plugin:do-thing": [{ modifiers: ["Mod"], key: "j" }],
      }),
      communityPlugins: [],
    });
    expect(r.hotkeys).toEqual({ settings: "mod+,", "split-right": "mod+shift+\\" });
    expect(r.unmappedHotkeys).toEqual(["some-plugin:do-thing"]);
  });

  it("reports community plugins and survives malformed JSON", () => {
    const r = parseObsidianImport({ appearance: "{bad json", hotkeys: "also bad", communityPlugins: ["dataview", "templater-obsidian"] });
    expect(r.plugins).toEqual(["dataview", "templater-obsidian"]);
    expect(r.theme).toBeNull();
    expect(r.hotkeys).toEqual({});
  });
});
