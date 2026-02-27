import { repairFrontmatterText } from "../src/utils/frontmatter-repair";

describe("repairFrontmatterText", () => {
  it("dedupes duplicate top-level keys by keeping the last value", () => {
    const input = [
      "---",
      "title: Test",
      "color: \"#111111\"",
      "color: \"#222222\"",
      "icon: lucide-check",
      "---",
      "Body"
    ].join("\n");

    const repaired = repairFrontmatterText(input);

    expect(repaired.changed).toBe(true);
    expect(repaired.fixes).toContain("deduped-keys");
    expect(repaired.content).toContain("color: \"#222222\"");
    expect(repaired.content).not.toContain("color: \"#111111\"");
  });

  it("quotes plain scalar values that contain colon-space", () => {
    const input = [
      "---",
      "folderPath: System/Archive: 02 Pages",
      "---",
      "Body"
    ].join("\n");

    const repaired = repairFrontmatterText(input);

    expect(repaired.changed).toBe(true);
    expect(repaired.fixes).toContain("quoted-colon-values");
    expect(repaired.content).toContain("folderPath: \"System/Archive: 02 Pages\"");
  });

  it("preserves content when frontmatter does not need repair", () => {
    const input = [
      "---",
      "status: working",
      "icon: \"lucide-square\"",
      "---",
      "Body"
    ].join("\n");

    const repaired = repairFrontmatterText(input);

    expect(repaired.changed).toBe(false);
    expect(repaired.fixes).toHaveLength(0);
    expect(repaired.content).toBe(input);
  });

  it("removes dangling scalar lines that break yaml maps", () => {
    const input = [
      "---",
      "color: \"#f04472\"",
      "gle",
      "icon: lucide:file-pen",
      "---",
      "Body"
    ].join("\n");

    const repaired = repairFrontmatterText(input);

    expect(repaired.changed).toBe(true);
    expect(repaired.fixes).toContain("removed-dangling-lines");
    expect(repaired.content).toContain("color: \"#f04472\"");
    expect(repaired.content).toContain("icon: lucide:file-pen");
    expect(repaired.content).not.toContain("\ngle\n");
  });
});
