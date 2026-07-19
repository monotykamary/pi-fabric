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
});
