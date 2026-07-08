import { test, expect } from "@playwright/test";

// Audio recorder — mic hardware is mocked (getUserMedia + MediaRecorder) so the
// full record → save-attachment → embed-at-cursor flow runs headless.
test("record audio saves an attachment and embeds it in the note", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error test shim
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream;
    class FakeRec {
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        setTimeout(() => this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) }), 10);
      }
      stop() {
        this.onstop?.();
      }
    }
    // @ts-expect-error test shim
    window.MediaRecorder = FakeRec;
  });
  await page.goto("/app-harness.html");
  await page.evaluate(() => {
    Object.keys(localStorage).filter((k) => k.includes("workspace")).forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.locator(".tree-row.file", { hasText: "Ideas" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator('.ribbon-btn[title^="Command palette"]').click();
  await page.locator(".palette-input").first().fill("Record audio");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rec-indicator")).toBeVisible();
  await page.locator(".rec-stop").click();
  await expect(page.locator(".rec-indicator")).toHaveCount(0);
  await expect(page.locator(".pane .cm-content")).toContainText(/!\[\[Recording .*\.webm\]\]/);
});
