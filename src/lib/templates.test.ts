import { describe, expect, it } from "vitest";
import { applyTemplate, type TemplateCtx } from "./templates";

const NOW = new Date(2026, 2, 5, 9, 30).getTime(); // 2026-03-05 09:30 local

function ctx(over: Partial<TemplateCtx> = {}): TemplateCtx {
  return {
    title: "My Note",
    folder: "Notes",
    path: "Notes/My Note.md",
    ctime: new Date(2026, 0, 1).getTime(),
    now: NOW,
    prompt: async () => "answer",
    ...over,
  };
}

describe("applyTemplate", () => {
  it("fills Obsidian core {{date}}/{{time}}/{{title}} tags", async () => {
    const r = await applyTemplate("# {{title}}\n{{date}} at {{time}}\n{{date:YYYY}}", ctx());
    expect(r.text).toBe("# My Note\n2026-03-05 at 09:30\n2026");
  });

  it("fills tp.date.* and tp.file.* tags", async () => {
    const r = await applyTemplate(
      "<% tp.file.title %> in <% tp.file.folder() %> — <% tp.date.now(\"YYYY-MM-DD\") %>, tomorrow <% tp.date.tomorrow() %>, yesterday <% tp.date.yesterday() %>",
      ctx(),
    );
    expect(r.text).toBe(
      "My Note in Notes — 2026-03-05, tomorrow 2026-03-06, yesterday 2026-03-04",
    );
  });

  it("reports the cursor position and strips its marker", async () => {
    const r = await applyTemplate("Start <% tp.file.cursor() %>End", ctx());
    expect(r.text).toBe("Start End");
    expect(r.cursor).toBe("Start ".length);
  });

  it("awaits tp.system.prompt and substitutes the answer", async () => {
    const asked: string[] = [];
    const r = await applyTemplate("Hi <% tp.system.prompt(\"Name?\") %>!", {
      ...ctx(),
      prompt: async (msg) => {
        asked.push(msg);
        return "Ada";
      },
    });
    expect(r.text).toBe("Hi Ada!");
    expect(asked).toEqual(["Name?"]);
  });

  it("uses the default / empty string when a prompt is cancelled", async () => {
    const r = await applyTemplate('X<% tp.system.prompt("Q", "def") %>Y', {
      ...ctx(),
      prompt: async () => null,
    });
    expect(r.text).toBe("XdefY");
  });

  it("honors <%- -%> whitespace trimming", async () => {
    const r = await applyTemplate("a\n<%- tp.file.title -%>\nb", ctx());
    expect(r.text).toBe("aMy Noteb");
  });

  it("leaves an unsupported tag empty and records an error (no JS eval)", async () => {
    const r = await applyTemplate("A<% tp.user.custom() %>B<% window.location %>C", ctx());
    expect(r.text).toBe("ABC");
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/Unsupported/);
  });

  it("multiple prompts resolve in order", async () => {
    const answers = ["one", "two"];
    let i = 0;
    const r = await applyTemplate('<% tp.system.prompt("a") %>-<% tp.system.prompt("b") %>', {
      ...ctx(),
      prompt: async () => answers[i++],
    });
    expect(r.text).toBe("one-two");
  });
});
