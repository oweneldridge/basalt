import { test, expect, openApp, openNote, caretToEnd, settle } from "./fixture";

async function insertTemplate(page: import("@playwright/test").Page, name: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog").getByRole("combobox").fill("Insert template");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("combobox").fill(name);
  await page.keyboard.press("Enter");
}

test.describe("templates with properties", () => {
  test.use({
    vaultFiles: {
      "Templates/Meeting.md": "---\ntags: [meeting]\nstatus: draft\n---\n## Agenda\n",
      "Tagged.md": "---\n# mine\ntags:\n  - work\n---\n# Tagged\n\nFirst line\n",
      "Plain.md": "# Plain\n\nFirst line\n",
    },
  });

  test("properties merge into the note's own; the body goes in at the caret", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tagged");
    await caretToEnd(page);
    await insertTemplate(page, "Meeting");
    await expect.poll(() => vault.read("Tagged.md")).toContain("## Agenda");
    await settle(page);
    expect(vault.read("Tagged.md")).toBe(
      "---\n# mine\ntags:\n  - work\n  - meeting\nstatus: draft\n---\n# Tagged\n\nFirst line\n## Agenda\n",
    );
  });

  test("with the caret at the very top, the body goes after the note's properties", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tagged");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+Home");
    await insertTemplate(page, "Meeting");
    await expect.poll(() => vault.read("Tagged.md")).toContain("## Agenda");
    await settle(page);
    expect(vault.read("Tagged.md")).toBe(
      "---\n# mine\ntags:\n  - work\n  - meeting\nstatus: draft\n---\n## Agenda\n# Tagged\n\nFirst line\n",
    );
  });

  test("a note without properties gets them at the top", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Plain");
    await caretToEnd(page);
    await insertTemplate(page, "Meeting");
    await expect.poll(() => vault.read("Plain.md")).toContain("## Agenda");
    await settle(page);
    expect(vault.read("Plain.md")).toBe("---\ntags: [meeting]\nstatus: draft\n---\n# Plain\n\nFirst line\n## Agenda\n");
  });
});

test.describe("a template without properties", () => {
  test.use({
    vaultFiles: {
      "Templates/Plain body.md": "Just a line\n",
      "Tagged.md": "---\ntags: [work]\n---\n# Tagged\n",
    },
  });

  test("inserted at the very top, it goes after the note's properties", async ({ page, vault }) => {
    await openApp(page, vault);
    await openNote(page, "Tagged");
    await page.locator(".pane:not(.dock) .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+Home");
    await insertTemplate(page, "Plain body");
    await expect.poll(() => vault.read("Tagged.md")).toContain("Just a line");
    await settle(page);
    expect(vault.read("Tagged.md")).toBe("---\ntags: [work]\n---\nJust a line\n# Tagged\n");
  });
});
