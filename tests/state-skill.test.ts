import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("fabric-schema skill contract", () => {
  it("uses positive certification and does not claim direct Pi tools are gated", () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), "skills/fabric-schema/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("if (!verification.certified)");
    expect(skill).toContain("discipline over the typed state provider");
    expect(skill).toContain("does not gate direct `pi.edit`");
    expect(skill).toMatch(/forthcoming or optional strict schema mode/i);
    expect(skill).not.toMatch(/single gated channel/i);
    expect(skill).not.toMatch(/direct .*tools? (?:are|is) (?:harness-)?gated/i);
  });
});
