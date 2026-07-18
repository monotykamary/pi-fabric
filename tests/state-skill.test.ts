import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("fabric-schema skill contract", () => {
  it("uses the real provider API and states the strict guarantee without treating evidence as proof", () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), "skills/fabric-schema/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("schema.status()");
    expect(skill).toContain("schema.hypothesize({");
    expect(skill).toContain("schema.verify({");
    expect(skill).toContain("schema.commit({");
    expect(skill).toContain("state.transition({");
    expect(skill).toContain("state.verify()");
    expect(skill).toContain("one same-`fabric_exec`");
    expect(skill).toContain("Evidence is not proof");
    expect(skill).toContain("does not gate direct `pi.edit`");
    expect(skill).toContain("Remote/network/database effects are not transactional");
    expect(skill).not.toContain("tools.call({");
    expect(skill).not.toMatch(/tests? (?:are|is) proof/i);
  });
});
