import fs from "node:fs";
import { describe, expect, it } from "vitest";

const stableProviderActions = {
  memory: ["recall", "expand", "sessions"],
  state: ["transition", "get", "history", "complexity", "verify", "goal", "checkGoal"],
  schema: ["status", "hypothesize", "verify", "commit", "abort"],
  compact: ["request", "status", "cancel"],
} as const;

describe("fabric-exec skill provider contracts", () => {
  it("documents a return shape for every stable first-class provider action", () => {
    const skill = fs.readFileSync("skills/fabric-exec/SKILL.md", "utf8");

    for (const [provider, actions] of Object.entries(stableProviderActions)) {
      for (const action of actions) {
        expect(skill, `missing return-shape row for ${provider}.${action}`).toContain(
          `| \`${provider}.${action}(`,
        );
      }
    }
  });

  it("documents dynamic MCP and captured-extension returns", () => {
    const skill = fs.readFileSync("skills/fabric-exec/SKILL.md", "utf8");

    expect(skill).toContain("mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to");
    expect(skill).toContain("extensions.<tool>(args)` in full code mode resolves to");
  });

  it("keeps detailed execution caveats in the progressive skill", () => {
    const skill = fs.readFileSync("skills/fabric-exec/SKILL.md", "utf8");
    const extension = fs.readFileSync("src/index.ts", "utf8");

    expect(skill).toContain("string containing literal `${...}`");
    expect(skill).toContain("Omit `timeoutMs` for subagents and actors");
    expect(extension).not.toContain("Shorthands (all accepted)");
    expect(extension).not.toContain("mcp.fal_ai.get_model_schema");
    expect(extension).not.toContain("For subagents and actors, omit timeoutMs");
    expect(extension).not.toContain("FABRIC_TEMPLATE_LITERAL_CAVEAT");
  });

  it("centralizes ambient actor setup outside the profile skills", () => {
    const setup = fs.readFileSync(
      "skills/fabric-ambient/references/setup.md",
      "utf8",
    );
    expect(setup).toContain("agents.create({");
    expect(setup).toContain("agents.setDeliveryPolicy({");
    expect(setup).toContain("pass an empty string when unset");

    const profiles = {
      "fabric-advisor": "../fabric-ambient/references/setup.md",
      "fabric-supervisor": "../fabric-ambient/references/setup.md",
      "fabric-ambient": "references/setup.md",
    } as const;
    for (const [name, reference] of Object.entries(profiles)) {
      const skillPath = `skills/${name}/SKILL.md`;
      const skill = fs.readFileSync(skillPath, "utf8");
      const referencePath = new URL(reference, `file://${process.cwd()}/skills/${name}/`);
      expect(fs.existsSync(referencePath)).toBe(true);
      expect(skill).toContain(reference);
      expect(skill).toContain("empty");
      expect(skill).not.toContain("agents.create({");
      expect(skill).not.toContain("agents.setDeliveryPolicy({");
    }

    expect(fs.readFileSync("skills/fabric-supervisor/SKILL.md", "utf8"))
      .toContain("request credentials");
    expect(fs.readFileSync("skills/fabric-ambient/SKILL.md", "utf8"))
      .toContain("request credentials");
  });
});
