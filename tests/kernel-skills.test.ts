import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FabricState } from "../src/fabric-state.js";
import { normalizeFabricConfig } from "../src/config.js";
import { KernelSkills } from "../src/core/kernel-skills.js";
import { restoreSkillsForFullCodePrompt } from "../src/core/skill-prompt.js";
import { fabricExecutionKernelGuidance } from "../src/core/system-guidance.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { availablePythonBackends } from "./fixtures/python-backends.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const fixture = (metadata = ""): Skill => {
  const dir = mkdtempSync(path.join(tmpdir(), "fabric-kernel-skill-"));
  dirs.push(dir);
  const filePath = path.join(dir, "SKILL.md");
  writeFileSync(filePath, `---\nname: example\ndescription: Example\n${metadata}---\n\n# Example\n`);
  return { name: "example", description: "Example", filePath, baseDir: dir, disableModelInvocation: false, sourceInfo: {} } as Skill;
};
const bundled = () => loadSkillsFromDir({ dir: path.resolve("skills"), source: "test" }).skills;

describe("kernel-specific skills", () => {
  it("selects disjoint bundled catalogs and switches without a stale cache", () => {
    const selector = new KernelSkills();
    const skills = bundled();
    expect(skills.length).toBe(13);
    expect(selector.select(skills, "python").map((s) => s.name)).toEqual(["fabric-exec-python"]);
    expect(selector.select(skills, "typescript")).toHaveLength(12);
    expect(selector.select(skills, "typescript").map((s) => s.name)).not.toContain("fabric-exec-python");
    expect(selector.select(skills, "python").map((s) => s.name)).toEqual(["fabric-exec-python"]);
  });

  it("preserves neutral and manual-only skills, rejects invalid declarations, detects metadata edits", () => {
    const neutral = fixture();
    const python = fixture('metadata: {fabric-kernel: "python"}\n');
    const invalid = fixture("metadata:\n  fabric-kernel: pythno\n");
    python.disableModelInvocation = true;
    const selector = new KernelSkills();
    expect(selector.select([neutral, python, invalid], "python")).toEqual([neutral, python]);
    expect(selector.select([neutral, python, invalid], "typescript")).toEqual([neutral]);
    expect(restoreSkillsForFullCodePrompt("Base", [python])).toBe("Base");
    writeFileSync(python.filePath, readFileSync(python.filePath, "utf8").replace('"python"', '"typescript"'));
    expect(selector.select([python], "python")).toEqual([]);
    expect(selector.select([python], "typescript")).toEqual([python]);
  });

  it.each([true, false])("replaces an existing catalog in fullCodeMode=%s, including an empty selection", (fullCodeMode) => {
    const selector = new KernelSkills();
    const original = restoreSkillsForFullCodePrompt("Before\nCurrent working directory: /repo", selector.select(bundled(), "typescript"));
    const updated = restoreSkillsForFullCodePrompt(original, selector.select(bundled(), "python"), fullCodeMode);
    expect(updated).toContain("<name>fabric-exec-python</name>");
    expect(updated).not.toContain("<name>fabric-exec</name>");
    expect(updated).not.toContain("fabric-workflow");
    expect(updated.match(/<available_skills>/g)).toHaveLength(1);
    expect(updated).toContain(fullCodeMode ? "Use `pi.read` inside" : "Use the read tool");
    const empty = restoreSkillsForFullCodePrompt(updated, []);
    expect(empty).not.toContain("available_skills");
    expect(empty).toContain("Before");
    expect(empty).toContain("Current working directory: /repo");
  });

  it("suppresses incompatible expanded invocations, retaining user intent and original history", () => {
    const skill = fixture("metadata:\n  fabric-kernel: typescript\n");
    const original = `<skill name="example" location="${skill.filePath}">\nconst secret = 1;\n</skill>\n\nUser: inspect my project`;
    const selector = new KernelSkills();
    const filtered = selector.filterInvocation(original, "python");
    expect(filtered).toContain("unavailable for the configured python kernel");
    expect(filtered).toContain("User: inspect my project");
    expect(filtered).not.toContain("const secret");
    expect(selector.filterInvocation(original, "typescript")).toBe(original);
    expect(selector.filterInvocation("ordinary user text", "python")).toBe("ordinary user text");
  });

  it("applies selection and context suppression through the registered extension hooks", async () => {
    const handlers = new Map<string, Array<(event: any, context: any) => any>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => []),
      on: (event: string, handler: (event: any, context: any) => any) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(), setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const { default: piFabric } = await import("../src/index.js");
    await piFabric(pi);
    const config = normalizeFabricConfig({ executor: { kernel: "python" } });
    const bootstrapped = vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
    const configured = vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(config);
    try {
      const handler = handlers.get("before_agent_start")![0]!;
      const event = { systemPrompt: "Base", prompt: "inspect", systemPromptOptions: { skills: bundled() } };
      const first = await handler(event, {});
      expect(first.systemPrompt).toContain("<name>fabric-exec-python</name>");
      expect(first.systemPrompt).not.toContain("<name>fabric-exec</name>");
      expect((await handler(event, {})).systemPrompt).toBe(first.systemPrompt);
      const skill = bundled().find((s) => s.name === "fabric-exec")!;
      const block = `<skill name="${skill.name}" location="${skill.filePath}">\nconst x = 1;\n</skill>\n\nUser: inspect source`;
      const messages = [
        { role: "user", content: block },
        { role: "user", content: [{ type: "text", text: block }, { type: "image", data: "untouched" }] },
      ];
      const context = { sessionManager: { getSessionId: () => "test" } };
      let filtered = messages;
      for (const hook of handlers.get("context") ?? []) {
        const result = await hook({ messages: filtered }, context);
        filtered = result?.messages ?? filtered;
      }
      expect(JSON.stringify(filtered)).not.toContain("const x");
      expect(JSON.stringify(filtered)).toContain("User: inspect source");
      expect(JSON.stringify(filtered)).toContain("untouched");
      expect(JSON.stringify(messages)).toContain("const x");
      config.executor.kernel = "typescript";
      const switched = await handler(event, {});
      expect(switched.systemPrompt).toContain("<name>fabric-exec</name>");
      expect(switched.systemPrompt).not.toContain("<name>fabric-exec-python</name>");
    } finally {
      bootstrapped.mockRestore();
      configured.mockRestore();
    }
  });

  it("keeps references and ambient instructions exclusive without banning project commands", () => {
    const python = readFileSync("skills/fabric-exec-python/SKILL.md", "utf8");
    const ts = readFileSync("skills/fabric-exec/SKILL.md", "utf8");
    expect(python).not.toMatch(/```(?:ts|typescript|javascript)\b|Promise\.all|const /);
    expect(ts).not.toMatch(/```python\b|asyncio\.gather|## Python kernel/);
    for (const kernel of ["typescript", "python"] as const) {
      const guidance = fabricExecutionKernelGuidance(true, kernel);
      expect(guidance).toContain("Do not invoke another interpreter");
      expect(guidance).toContain("Project builds, tests");
    }
  });

  it.skipIf(!availablePythonBackends.monty)("executes every fenced Python skill example in Monty", async () => {
    const text = readFileSync("skills/fabric-exec-python/SKILL.md", "utf8");
    const blocks = [...text.matchAll(/```python\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(3);
    for (const match of blocks) {
      const result = await new MontyRuntime().execute(match[1]!, async (ref) => {
        if (ref === "pi.bash") return { ok: true, output: "clean" };
        if (ref === "fabric.$search") return [{ ref: "demo.status" }];
        if (ref === "fabric.$describe") return { ref: "demo.status", inputSchema: { type: "object" } };
        return "example";
      }, { timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 });
      expect(result.terminationReason, result.error).toBe("completed");
    }
  });
});
