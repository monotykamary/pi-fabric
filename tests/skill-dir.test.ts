import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSkillDirMarkers,
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "../src/core/skill-dir.js";

const skillDir = path.resolve("/installed/skills/portable");
const skillPath = path.join(skillDir, "SKILL.md");

describe("skill-dir markers", () => {
  it("replaces every marker with the supplied directory", () => {
    expect(
      expandSkillDirMarkers(
        "Read `<skill-dir>/references/a.md` and `<skill-dir>/references/b.md`.",
        skillDir,
      ),
    ).toBe(
      `Read \`${skillDir}/references/a.md\` and \`${skillDir}/references/b.md\`.`,
    );
  });

  it("expands only the Pi skill block and preserves user arguments", () => {
    const prompt = [
      `<skill name="duplicate-name" location="${skillPath}">`,
      `References are relative to ${skillDir}.`,
      "",
      "Read `<skill-dir>/references/setup.md`.",
      "</skill>",
      "",
      "User argument: keep <skill-dir> literal",
    ].join("\n");

    const expanded = expandSkillDirMarkersInSkillBlock(prompt);
    expect(expanded).toContain(`Read \`${skillDir}/references/setup.md\`.`);
    expect(expanded).toContain("User argument: keep <skill-dir> literal");
  });

  it("does not use a skill name or require a discovered registry entry", () => {
    const source = "Read `<skill-dir>/references/setup.md`.";
    expect(
      expandSkillDirMarkersForRead(
        source,
        { path: skillPath },
        path.resolve("/unrelated/workspace"),
      ),
    ).toBe(`Read \`${skillDir}/references/setup.md\`.`);
  });

  it("leaves ordinary file reads and malformed skill blocks unchanged", () => {
    const source = "literal <skill-dir>";
    expect(
      expandSkillDirMarkersForRead(
        source,
        { path: path.join(skillDir, "references", "setup.md") },
        "/",
      ),
    ).toBe(source);
    expect(expandSkillDirMarkersInSkillBlock(source)).toBe(source);
  });
});
