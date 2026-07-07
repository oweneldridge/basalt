import { describe, expect, it } from "vitest";
import { chordOf, chordLabel, matchChord } from "./hotkeys";

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("chordOf", () => {
  it("normalizes to mod+alt+shift+key order (mac = meta)", () => {
    expect(chordOf(ev("k", { meta: true, shift: true }), true)).toBe("mod+shift+k");
    expect(chordOf(ev("K", { meta: true, alt: true, shift: true }), true)).toBe("mod+alt+shift+k");
    expect(chordOf(ev("k", { ctrl: true }), false)).toBe("mod+k"); // non-mac = ctrl
  });
  it("rejects bare keys, lone modifiers, and the cross-platform 'other' modifier", () => {
    expect(chordOf(ev("k"), true)).toBeNull(); // unmodified
    expect(chordOf(ev("Shift", { shift: true }), true)).toBeNull(); // lone modifier
    expect(chordOf(ev("k", { ctrl: true }), true)).toBeNull(); // ctrl on mac
    expect(chordOf(ev("k", { meta: true }), false)).toBeNull(); // meta on win/linux
  });
  it("allows bare function keys", () => {
    expect(chordOf(ev("f5"), true)).toBe("f5");
  });
});

describe("matchChord + chordLabel", () => {
  it("finds the command bound to a chord", () => {
    const b = { "toggle-theme": "mod+shift+t" };
    expect(matchChord(ev("t", { meta: true, shift: true }), b, true)).toBe("toggle-theme");
    expect(matchChord(ev("t", { meta: true }), b, true)).toBeNull();
  });
  it("labels chords per platform", () => {
    expect(chordLabel("mod+shift+k", true)).toBe("⌘⇧K");
    expect(chordLabel("mod+shift+k", false)).toBe("Ctrl+Shift+K");
  });
});
