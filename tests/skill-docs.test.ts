import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

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
    expect(setup).toContain("empty when unset");

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

  it("type-checks every TypeScript-fenced skill program", () => {
    const skillFiles = fs.readdirSync("skills", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("skills", entry.name, "SKILL.md"))
      .filter((file) => fs.existsSync(file));
    skillFiles.push("skills/fabric-ambient/references/setup.md");

    for (const file of skillFiles) {
      const markdown = fs.readFileSync(file, "utf8");
      const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)\n```/g)];
      for (const [index, match] of blocks.entries()) {
        const code = match[1]!;
        const result = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
        expect(result.errors, `${file} TypeScript block ${index + 1}`).toEqual([]);
        for (const key of code.matchAll(/π\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          expect(markdown, `${file} does not document strings.${key[1]}`)
            .toContain(`strings.${key[1]}`);
        }
      }
    }
  });

  it("resolves every relative Markdown reference in a skill", () => {
    for (const entry of fs.readdirSync("skills", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join("skills", entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const markdown = fs.readFileSync(file, "utf8");
      for (const match of markdown.matchAll(/`((?:\.\.?\/)+[^`]+\.md)`/g)) {
        const resolved = path.resolve(path.dirname(file), match[1]!);
        expect(fs.existsSync(resolved), `${file} -> ${match[1]}`).toBe(true);
      }
    }
  });

  it("retains each specialized skill's execution invariants", () => {
    const required: Record<string, string[]> = {
      "fabric-advisor": ["agent_settled", "tool_error", "`strings.triggerTurn`: `false`", "action\":\"silent"],
      "fabric-ambient": ["supervisor", "advisor", "triggerTurn=true", "triggerTurn=false"],
      "fabric-council": ["council.run", "synthesize: true", "material disagreement"],
      "fabric-exec": ["read, describe, retry", "tools.describe", "timeoutMs", "literal `${...}`"],
      "fabric-fusion": ["1–8 model panel", "tools.models()", "agents.models", "blind_spots", "non-recursive"],
      "fabric-rlm": ["strings.task", "rlm.query", "best-effort whole-tree spend guard", "budget.remaining()", "not inherited"],
      "fabric-schema": ["one same-`fabric_exec`", "Evidence is not proof", "quarantined", "not transactional"],
      "fabric-supervisor": ["agent_settled", "tool_error", "`strings.triggerTurn`: `true`", "Goal verified complete"],
      "fabric-swarm": ["ifVersion: 0", "observed version", "CAS-unblock dependents", "\"blocked\"", "agents.tell"],
      "fabric-workflow": ["parallel(thunks", "pipeline(items", "worktree: true", "verifier"],
    };

    for (const [name, signals] of Object.entries(required)) {
      const skill = fs.readFileSync(`skills/${name}/SKILL.md`, "utf8");
      for (const signal of signals) {
        expect(skill, `${name} lost signal: ${signal}`).toContain(signal);
      }
    }
  });
});
