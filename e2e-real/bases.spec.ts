import { statSync } from "node:fs";
import { test, expect, openApp, openNote, settle } from "./fixture";

const BASE = `# kept through edits
filters: 'file.inFolder("Projects")'
views:
  - type: list
    name: Projects
    customKey: stays
    order:
      - file.name
`;

test.describe("bases on disk", () => {
  test.use({
    vaultFiles: {
      "Projects.base": BASE,
      "Hub.md": "# Hub\n\n![[Projects.base]]\n\n```base\nviews:\n  - type: list\n    name: Here\n    filters: 'file.hasLink(this.file)'\n```\n",
      "Projects/Beta.md": "# Beta\n\nPart of [[Hub]].\n",
    },
  });

  test("a list view edit writes its options and keeps the rest of the file", async ({ page, vault }) => {
    await openApp(page, vault);
    await page.locator(".tree-row.attachment", { hasText: "Projects" }).click();
    const view = page.locator(".pane:not(.dock) .base-view");
    await expect(view.locator("ul.base-list").getByRole("listitem")).toHaveText(["Alpha", "Beta"]);
    await view.getByRole("button", { name: "✎ Edit" }).click();
    await page.locator(".base-editor").getByLabel("Markers").selectOption("number");
    await expect.poll(() => vault.read("Projects.base")).toContain("markers: number");
    const disk = vault.read("Projects.base");
    expect(disk).toContain("# kept through edits");
    expect(disk).toContain("customKey: stays");
    expect(disk).toContain(`filters: 'file.inFolder("Projects")'`);
    await expect(view.locator("ol.base-list").getByRole("listitem")).toHaveCount(2);
  });

  test("embedded bases render from disk and write nothing", async ({ page, vault }) => {
    const before = { hub: vault.read("Hub.md"), base: vault.read("Projects.base") };
    const mtimes = () => ["Hub.md", "Projects.base"].map((f) => statSync(vault.path(f)).mtimeMs);
    const mtimesBefore = mtimes();
    await openApp(page, vault);
    await openNote(page, "Hub");
    const embeds = page.locator(".pane:not(.dock) .base-view");
    await expect(embeds).toHaveCount(2);
    await expect(embeds.nth(0).getByRole("listitem")).toHaveText(["Alpha", "Beta"]);
    await expect(embeds.nth(1).getByRole("listitem")).toHaveText(["Beta"]);
    await page.locator('button[title^="Toggle Reading view"]').click();
    await expect(page.locator(".reading-view .base-view")).toHaveCount(2);
    await settle(page);
    expect(vault.read("Hub.md")).toBe(before.hub);
    expect(vault.read("Projects.base")).toBe(before.base);
    expect(mtimes()).toEqual(mtimesBefore);
  });
});
